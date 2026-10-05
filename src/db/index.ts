import Database from "better-sqlite3";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { sakerstallMapp } from "../util/fil.js";
import { MIGRERINGAR } from "./schema.js";

export type Db = Database.Database;

let instans: Db | undefined;

/** Öppnar (och skapar vid behov) databasen i data/granskaren.db och kör migreringar. */
export function db(sokvag?: string): Db {
  if (instans && !sokvag) return instans;
  const fil = sokvag ?? path.join(sakerstallMapp(DATA_DIR), "granskaren.db");
  const d = new Database(fil);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  migrera(d);
  if (!sokvag) instans = d;
  return d;
}

/** Skapar en databas i minnet, för tester. */
export function testDb(): Db {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  migrera(d);
  return d;
}

function migrera(d: Db): void {
  d.exec(`CREATE TABLE IF NOT EXISTS migreringar (
    namn TEXT PRIMARY KEY,
    kord TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const korda = new Set(
    (d.prepare("SELECT namn FROM migreringar").all() as { namn: string }[]).map((r) => r.namn),
  );
  for (const m of MIGRERINGAR) {
    if (korda.has(m.namn)) continue;
    d.transaction(() => {
      d.exec(m.sql);
      d.prepare("INSERT INTO migreringar (namn) VALUES (?)").run(m.namn);
    })();
  }
}
