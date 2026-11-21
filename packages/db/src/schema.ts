import type { Generated } from "kysely";

/** System key/value table. No personal data is ever stored here. */
export interface MetaTable {
  key: string;
  value: string;
  updated_at: Generated<Date>;
}

export interface Database {
  _meta: MetaTable;
}
