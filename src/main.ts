import { openDatabase } from "./storage/database";
import { schemaVersion } from "./storage/migrations";

try {
  const db = openDatabase();
  try {
    console.log(`Looky storage ready: schema ${schemaVersion(db)}, FTS5 verified`);
  } finally {
    db.close();
  }
} catch (error) {
  console.error("Looky startup failed:", error);
  process.exitCode = 1;
}
