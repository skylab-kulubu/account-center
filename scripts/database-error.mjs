export function serializeDatabaseError(error) {
  const details = { event: "database_migration_failed" };

  if (!(error instanceof Error)) return details;

  details.error = error.message;

  if ("code" in error && typeof error.code === "string") {
    details.code = error.code;
  }
  if ("schema" in error && typeof error.schema === "string") {
    details.schema = error.schema;
  }
  if ("table" in error && typeof error.table === "string") {
    details.table = error.table;
  }
  if ("constraint" in error && typeof error.constraint === "string") {
    details.constraint = error.constraint;
  }

  return details;
}
