import { Knex } from "knex";

import { TableName } from "../schemas";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn(TableName.SuperAdmin, "orgCreatorIdentityIds"))) {
    await knex.schema.alterTable(TableName.SuperAdmin, (t) => {
      t.specificType("orgCreatorIdentityIds", "text[]");
    });
  }

  if (!(await knex.schema.hasColumn(TableName.Organization, "createdByIdentityId"))) {
    await knex.schema.alterTable(TableName.Organization, (t) => {
      t.uuid("createdByIdentityId").nullable();
      t.foreign("createdByIdentityId").references("id").inTable(TableName.Identity).onDelete("SET NULL");
      t.index("createdByIdentityId");
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn(TableName.Organization, "createdByIdentityId")) {
    await knex.schema.alterTable(TableName.Organization, (t) => {
      t.dropColumn("createdByIdentityId");
    });
  }

  if (await knex.schema.hasColumn(TableName.SuperAdmin, "orgCreatorIdentityIds")) {
    await knex.schema.alterTable(TableName.SuperAdmin, (t) => {
      t.dropColumn("orgCreatorIdentityIds");
    });
  }
}
