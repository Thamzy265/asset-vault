import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import {
  auditChange,
  auditViews,
  canCreateFor,
  canEdit,
  canManage,
  checkId,
  checkViewer,
  defaultRepositoryLog,
  ForbiddenError,
  NotFoundError,
  parseInput,
  PersonInUseError,
  visibleTo,
  type RepositoryOptions,
  type Viewer,
} from "./access.ts";
import { kyselyOf, type DbLike } from "./handle.ts";
import { errorCode } from "./log.ts";
import { normaliseDisplayName } from "./names.ts";
import { VISIBILITIES } from "./rules.ts";
import type { Database, PeopleTable, Visibility } from "./schema.ts";

const ENTITY = "person";

export type Person = {
  id: string;
  displayName: string;
  relationship: string | null;
  ownerPersonId: string | null;
  visibility: Visibility;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
  updatedByUserId: string | null;
};

export type NewPerson = {
  displayName: string;
  relationship?: string | null;
  ownerPersonId?: string | null;
  visibility?: Visibility;
};

export type PersonChanges = Partial<NewPerson>;

/**
 * Runtime shape of the inputs (B2): wrong types and unknown fields are refused
 * with ValidationError; an explicit visibility must be one of the enum, never
 * defaulted (B5); the display name is trimmed and checked (decision 6). Owner
 * ids are checked separately: a malformed one is not-found, like any id.
 */
const displayNameSchema = z.string().transform((raw, ctx) => {
  const name = normaliseDisplayName(raw);
  if (name === null) {
    ctx.addIssue({ code: "custom", message: "invalid display name" });
    return z.NEVER;
  }
  return name;
});
const newPersonSchema = z.strictObject({
  displayName: displayNameSchema,
  relationship: z.string().nullable().optional(),
  ownerPersonId: z.string().nullable().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
});
const personChangesSchema = newPersonSchema.partial();

/** A malformed owner id is not-found; a well-formed one is returned in lowercase (B4). */
function withCheckedOwner<T extends { ownerPersonId?: string | null | undefined }>(input: T): T {
  const owner = input.ownerPersonId;
  return owner === undefined || owner === null ? input : { ...input, ownerPersonId: checkId(owner) };
}

/** The writable columns, as stored. Audit rows name these columns, never their values. */
type PersonColumns = {
  display_name?: string;
  relationship?: string | null;
  owner_person_id?: string | null;
  visibility?: Visibility;
};

function toPerson(row: Selectable<PeopleTable>): Person {
  return {
    id: row.id,
    displayName: row.display_name,
    relationship: row.relationship,
    ownerPersonId: row.owner_person_id,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
  };
}

/** Parsed input: a field that is absent or undefined was not given. */
type GivenFields = { [K in keyof NewPerson]?: NewPerson[K] | undefined };

/** Only the fields actually given (undefined means "not given"). */
function columnsOf(input: GivenFields): PersonColumns {
  const out: PersonColumns = {};
  if (input.displayName !== undefined) out.display_name = input.displayName;
  if (input.relationship !== undefined) out.relationship = input.relationship;
  if (input.ownerPersonId !== undefined) out.owner_person_id = input.ownerPersonId;
  if (input.visibility !== undefined) out.visibility = input.visibility;
  return out;
}

/** ON DELETE RESTRICT on owner_person_id and users.person_id. */
const RESTRICT_VIOLATION = "23001";

/**
 * People: create, get, list, update, delete. Every function takes the viewer
 * and applies the one visibility rule (access.ts) and the write rules
 * (decisions 1 and 2): ordinary fields of a visible family record are anyone's
 * to edit; owner, visibility and delete are for the owner's linked user (for a
 * person, also the user linked to that person) and admins; members create
 * records owned by themselves only. A refused change to a visible record is a
 * ForbiddenError; a hidden record is always not-found. Changes write their
 * audit row in the same transaction, reads write a best-effort view row.
 */
export function peopleRepository(handle: DbLike, options: RepositoryOptions = {}) {
  const db = kyselyOf(handle);
  const log = options.log ?? defaultRepositoryLog;

  /** An owner the viewer can't see is treated as missing, so owners can't be probed. */
  async function assertOwnerVisible(trx: Kysely<Database>, viewer: Viewer, ownerId: string | null | undefined) {
    if (ownerId === undefined || ownerId === null) return;
    const found = await trx
      .selectFrom("people")
      .select("id")
      .where("id", "=", checkId(ownerId))
      .where(visibleTo(viewer, "people"))
      .executeTakeFirst();
    if (!found) throw new NotFoundError();
  }

  return {
    async create(viewer: Viewer, newPerson: NewPerson): Promise<Person> {
      const v = checkViewer(viewer);
      const input = withCheckedOwner(parseInput(newPersonSchema, newPerson));
      return db.transaction().execute(async (trx) => {
        await assertOwnerVisible(trx, v, input.ownerPersonId);
        if (!canCreateFor(v, input.ownerPersonId ?? null)) throw new ForbiddenError();
        const values = columnsOf(input);
        const row = await trx
          .insertInto("people")
          .values({
            display_name: input.displayName,
            relationship: input.relationship ?? null,
            owner_person_id: input.ownerPersonId ?? null,
            ...(input.visibility !== undefined && { visibility: input.visibility }),
            created_by_user_id: v.userId,
            updated_by_user_id: v.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await auditChange(trx, v, "create", ENTITY, row.id, Object.keys(values));
        return toPerson(row);
      });
    },

    async get(viewer: Viewer, id: string): Promise<Person> {
      const v = checkViewer(viewer);
      const row = await db
        .selectFrom("people")
        .selectAll()
        .where("id", "=", checkId(id))
        .where(visibleTo(v, "people"))
        .executeTakeFirst();
      if (!row) throw new NotFoundError();
      await auditViews(db, log, v, ENTITY, [row.id]);
      return toPerson(row);
    },

    async list(viewer: Viewer): Promise<Person[]> {
      const v = checkViewer(viewer);
      const rows = await db
        .selectFrom("people")
        .selectAll()
        .where(visibleTo(v, "people"))
        .orderBy("display_name")
        .orderBy("id")
        .execute();
      await auditViews(db, log, v, ENTITY, rows.map((r) => r.id));
      return rows.map(toPerson);
    },

    async update(viewer: Viewer, id: string, personChanges: PersonChanges): Promise<Person> {
      const v = checkViewer(viewer);
      const personId = checkId(id);
      const changes = withCheckedOwner(parseInput(personChangesSchema, personChanges));
      return db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom("people")
          .selectAll()
          .where("id", "=", personId)
          .where(visibleTo(v, "people"))
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw new NotFoundError();

        const given = columnsOf(changes);
        const changed: PersonColumns = Object.fromEntries(
          Object.entries(given).filter(([column, value]) => current[column as keyof PersonColumns] !== value),
        );
        if (Object.keys(changed).length === 0) return toPerson(current);
        if (!canEdit(v, "people", current)) throw new ForbiddenError();
        if (("owner_person_id" in changed || "visibility" in changed) && !canManage(v, "people", current)) throw new ForbiddenError();
        if ("owner_person_id" in changed) await assertOwnerVisible(trx, v, changed.owner_person_id);

        const row = await trx
          .updateTable("people")
          .set({ ...changed, updated_by_user_id: v.userId })
          .where("id", "=", current.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await auditChange(trx, v, "update", ENTITY, row.id, Object.keys(changed));
        return toPerson(row);
      });
    },

    /** Refused with PersonInUseError while the person owns records or is linked to a login. */
    async remove(viewer: Viewer, id: string): Promise<void> {
      const v = checkViewer(viewer);
      try {
        const personId = checkId(id);
        await db.transaction().execute(async (trx) => {
          const current = await trx
            .selectFrom("people")
            .select(["id", "owner_person_id"])
            .where("id", "=", personId)
            .where(visibleTo(v, "people"))
            .forUpdate()
            .executeTakeFirst();
          if (!current) throw new NotFoundError();
          if (!canManage(v, "people", current)) throw new ForbiddenError();
          const row = await trx.deleteFrom("people").where("id", "=", current.id).returning("id").executeTakeFirst();
          if (!row) throw new NotFoundError();
          await auditChange(trx, v, "delete", ENTITY, row.id);
        });
      } catch (error) {
        if (errorCode(error) === RESTRICT_VIOLATION) throw new PersonInUseError();
        throw error;
      }
    },
  };
}

export type PeopleRepository = ReturnType<typeof peopleRepository>;
