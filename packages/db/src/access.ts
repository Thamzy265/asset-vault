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

/** Delete refused: the person still owns records or is linked to a login. Reassign or unlink first. */
export class PersonInUseError extends Error {
  override name = "PersonInUseError";
  constructor() {
    super("This person still owns records or is linked to a login");
  }
}

export type LogFn = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
export type RepositoryOptions = { log?: LogFn };
export const defaultRepositoryLog: LogFn = (level, msg, fields) => defaultLog(level, msg, fields);

const uuid = z.uuid();
const viewerSchema = z.object({
  userId: uuid,
  role: z.enum(["admin", "member"]),
  personId: uuid.nullable(),
});

/** Throws on a malformed viewer (e.g. an unknown role) rather than guessing what it may see. */
export function checkViewer(viewer: Viewer): Viewer {
  const result = viewerSchema.safeParse(viewer);
  if (!result.success) throw new TypeError("Invalid viewer");
  return result.data;
}

/** A malformed id can't name a record: treat it as not found, the same as an invisible one. */
export function checkId(id: string): string {
  if (!uuid.safeParse(id).success) throw new NotFoundError();
  return id;
}

/** Tables that carry the shared record columns (owner, visibility, ...). */
export type RecordTable = { [K in keyof Database]: Database[K] extends RecordColumns ? K : never }[keyof Database];

/**
 * THE visibility rule (M1.2 design note), as a WHERE condition on `table`:
 * - `family`: every signed-in user;
 * - `private`: the owner's linked user and admins only.
 * Every repository read and write filters with this, so an invisible record
 * looks exactly like a missing one.
 */
export function visibleTo(viewer: Viewer, table: RecordTable): RawBuilder<boolean> {
  const v = checkViewer(viewer);
  if (v.role === "admin") return sql<boolean>`true`;
  const visibility = sql.ref(`${table}.visibility`);
  if (v.personId === null) return sql<boolean>`${visibility} = 'family'`;
  return sql<boolean>`(${visibility} = 'family' or ${sql.ref(`${table}.owner_person_id`)} = ${v.personId})`;
}

/**
 * Writes the audit row for a change, inside the change's transaction: if it
 * fails, the change rolls back. `fields` are column names, never values.
 */
export async function auditChange(
  trx: Transaction<Database>,
  viewer: Viewer,
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
  viewer: Viewer,
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
