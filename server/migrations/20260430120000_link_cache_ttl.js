async function up(knex) {
  const hasCacheTtl = await knex.schema.hasColumn("links", "cache_ttl");
  if (!hasCacheTtl) {
    await knex.schema.alterTable("links", table => {
      table.integer("cache_ttl");
    });
  }
}

async function down() {
  return null;
}

module.exports = {
  up,
  down
}
