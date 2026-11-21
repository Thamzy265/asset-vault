import { sql, type Kysely, type RawBuilder, type Transaction } from "kysely";
import { z } from "zod";
import { errorCode, log as defaultLog, type LogLevel } from "./log.ts";
import type { AuditAction, Database, RecordColumns, Role } from "./schema.ts";

/**
 * Who is asking. Built from the signed-in session (M1.3). Every repository
 * function takes one; there is no way to read or write a business table
 * without it.
 */
export type Viewer = {
  userId: string;
  role: Role;
  /** The person this login is linked to, if any. */
  personId: string | null;
};

/** The record does not exist, or the viewer may not see it. The two are never told apart. */
export class NotFoundError extends Error {
  override name = "NotFoundError";
  constructor() {
    super("Not found");
  }
}

/**
 * The viewer can see the record but may not make this change (decision 1:
 * owner, visibility and delete are for the owner's linked user and admins).
 * Used only for records the viewer can already see, so it reveals nothing.
 */
export class ForbiddenError extends Error {
  override name = "ForbiddenError";
  constructor() {
    super("Forbidden");
  }
}

/** Delete refused: the person still owns records or is linked to a login. Reassign or unlink first. */
export class PersonInUseError extends Error {
  override name = "PersonInUseError";
  constructor() {
    super("This person still owns records or is linked to a login");
  }
}

/**
 * The input is malformed (wrong type, unknown field, or a value the rules
 * refuse). `fields` names the input fields at fault, never their values.
 */
export class ValidationError extends Error {
  override name = "ValidationError";
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`Invalid input: ${fields.join(", ")}`);
    this.fields = Object.freeze([...fields]);
  }
}

export type LogFn = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
export type RepositoryOptions = { log?: LogFn };
export const defaultRepositoryLog: LogFn = (level, msg, fields) => defaultLog(level, msg, fields);

const uuid = z.uuid();
/** Ids are compared case-insensitively: normalised to lowercase, as Postgres returns them (B4). */
const lowerUuid = uuid.transform((id) => id.toLowerCase());
const viewerSchema = z.object({
  userId: lowerUuid,
  role: z.enum(["admin", "member"]),
  personId: lowerUuid.nullable(),
});

declare const parsed: unique symbol;
/**
 * A viewer checkViewer has parsed (review C2). The helpers below take only
 * this, so each repository function parses its viewer once and passes the
 * result through.
 */
export type CheckedViewer = Viewer & { readonly [parsed]: true };

/** Throws on a malformed viewer (e.g. an unknown role) rather than guessing what it may see. */
export function checkViewer(viewer: Viewer): CheckedViewer {
  const result = viewerSchema.safeParse(viewer);
  if (!result.success) throw new TypeError("Invalid viewer");
  return result.data as CheckedViewer;
}

/** A malformed id can't name a record: treat it as not found, the same as an invisible one. Returns it in lowercase. */
export function checkId(id: string): string {
  const result = lowerUuid.safeParse(id);
  if (!result.success) throw new NotFoundError();
  return result.data;
}

/**
 * Runtime type check of a repository input (B2): throws ValidationError naming
 * the fields at fault. Unknown fields are refused, never ignored.
 */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = new Set<string>();
  for (const issue of result.error.issues) {
    if (issue.code === "unrecognized_keys") fields.add("(unknown field)");
    else fields.add(typeof issue.path[0] === "string" ? issue.path[0] : "(input)");
  }
  throw new ValidationError([...fields]);
}

/** Tables that carry the shared record columns (owner, visibility, ...). */
export type RecordTable = { [K in keyof Database]: Database[K] extends RecordColumns ? K : never }[keyof Database];

/**
 * Tables whose rows are people: the user linked to that person counts as the
 * row's owner too, so nobody can lock themselves out of their own record
 * (decision 2).
 */
const SELF_OWNED: ReadonlySet<RecordTable> = new Set<RecordTable>(["people"]);

/** The viewer owns the row: it is owned by the viewer's person, or (people) it is that person. */
export function isOwner(viewer: CheckedViewer, table: RecordTable, row: { id: string; owner_person_id: string | null }): boolean {
  if (viewer.personId === null) return false;
  return row.owner_person_id === viewer.personId || (SELF_OWNED.has(table) && row.id === viewer.personId);
}

/**
 * Decision 1: changing the owner or the visibility, and deleting, are for the
 * owner's linked user and admins only.
 */
export function canManage(viewer: CheckedViewer, table: RecordTable, row: { id: string; owner_person_id: string | null }): boolean {
  return viewer.role === "admin" || isOwner(viewer, table, row);
}

/**
 * Decision 1: the ordinary fields of a visible record may be edited by its
 * owner's linked user and admins, and, for `family` records only, by any
 * signed-in member.
 */
export function canEdit(
  viewer: CheckedViewer,
  table: RecordTable,
  row: { id: string; owner_person_id: string | null; visibility: string },
): boolean {
  return row.visibility === "family" || canManage(viewer, table, row);
}

/**
 * Decision 1: a member may create records owned by themselves only; admins
 * may create records for anyone, or with no owner.
 */
export function canCreateFor(viewer: CheckedViewer, ownerPersonId: string | null): boolean {
  return viewer.role === "admin" || (viewer.personId !== null && ownerPersonId === viewer.personId);
}

/**
 * THE visibility rule (M1.2 design note), as a WHERE condition on `table`:
 * - `family`: every signed-in user;
 * - `private`: the owner's linked user (for people, also the person's own
 *   linked user, decision 2) and admins only.
 * Every repository read and write filters with this, so an invisible record
 * looks exactly like a missing one.
 */
export function visibleTo(v: CheckedViewer, table: RecordTable): RawBuilder<boolean> {
  if (v.role === "admin") return sql<boolean>`true`;
  const visibility = sql.ref(`${table}.visibility`);
  if (v.personId === null) return sql<boolean>`${visibility} = 'family'`;
  const owned = SELF_OWNED.has(table)
    ? sql<boolean>`(${sql.ref(`${table}.owner_person_id`)} = ${v.personId} or ${sql.ref(`${table}.id`)} = ${v.personId})`
    : sql<boolean>`${sql.ref(`${table}.owner_person_id`)} = ${v.personId}`;
  return sql<boolean>`(${visibility} = 'family' or ${owned})`;
}

/**
 * Writes the audit row for a change, inside the change's transaction: if it
 * fails, the change rolls back. `fields` are column names, never values.
 */
export async function auditChange(
  trx: Transaction<Database>,
  viewer: CheckedViewer,
  action: Extract<AuditAction, "create" | "update" | "delete">,
  entityType: string,
  entityId: string,
  fields?: string[],
): Promise<void> {
  await trx
    .insertInto("audit_log")
    .values({
      actor_user_id: viewer.userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      details: fields ? JSON.stringify({ fields }) : null,
    })
    .execute();
}

/**
 * Records that `viewer` saw these records. Best-effort, in its own statement:
 * a failure is logged (ids and code only) and never fails the read.
 */
export async function auditViews(
  db: Kysely<Database>,
  log: LogFn,
  viewer: CheckedViewer,
  entityType: string,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  try {
    await db
      .insertInto("audit_log")
      .values(entityIds.map((id) => ({ actor_user_id: viewer.userId, action: "view" as const, entity_type: entityType, entity_id: id })))
      .execute();
  } catch (error) {
    const code = errorCode(error);
    log("error", "audit view write failed", { entityType, count: entityIds.length, actorUserId: viewer.userId, ...(code && { code }) });
  }
}
