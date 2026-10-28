import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROT } from "../config.js";
import type { Db } from "./index.js";

/**
 * Domäner som har fått ett förstamejl eller spärrats, oavsett vilken dator som skickade.
 * Filen ligger i repot så att en dator med tom databas inte mejlar samma organisation igen.
 * Repot är publikt, så domänerna sparas som SHA-256 och inte i klartext.
 */
export const KONTAKTADE_FIL = path.join(ROT, "kontaktade.txt");

const HUVUD = [
  "# Domäner som har fått mejl från Granskaren eller spärrats, som SHA-256 av domänen.",
  "# Uppdateras av send och block. Committa och pusha efter varje utskick, pulla innan varje pass.",
];

export function domanHash(doman: string): string {
  return crypto.createHash("sha256").update(doman.toLowerCase().trim()).digest("hex");
}

export function lasKontaktade(fil = KONTAKTADE_FIL): Set<string> {
  if (!fs.existsSync(fil)) return new Set();
  const rader = fs.readFileSync(fil, "utf8").split(/\r?\n/).map((r) => r.trim());
  return new Set(rader.filter((r) => /^[0-9a-f]{64}$/.test(r)));
}

export function arKontaktad(doman: string, fil = KONTAKTADE_FIL): boolean {
  return lasKontaktade(fil).has(domanHash(doman));
}

/** Domäner i databasen som inte får mejlas igen: skickade förstamejl och spärrade domäner. */
export function kontaktadeIDatabasen(d: Db): string[] {
  const rader = d
    .prepare(
      `SELECT p.doman AS doman FROM mejl m JOIN prospekt p ON p.id = m.prospekt_id WHERE m.typ = 'forsta' AND m.status = 'skickad'
       UNION SELECT doman FROM prospekt WHERE status IN ('skickad', 'svar', 'studs', 'sparrad')
       UNION SELECT varde FROM sparrlista WHERE typ = 'doman'`,
    )
    .all() as { doman: string }[];
  return rader.map((r) => r.doman);
}

/** Lägger databasens kontaktade domäner till filen. Det som redan står där behålls, så två datorer kan dela filen. */
export function uppdateraKontaktade(d: Db, fil = KONTAKTADE_FIL): { nya: number; totalt: number } {
  const alla = lasKontaktade(fil);
  const fore = alla.size;
  for (const dom of kontaktadeIDatabasen(d)) alla.add(domanHash(dom));
  const nya = alla.size - fore;
  if (nya > 0 || !fs.existsSync(fil)) fs.writeFileSync(fil, `${[...HUVUD, ...[...alla].sort()].join("\n")}\n`);
  return { nya, totalt: alla.size };
}

/** En mängd domäner som också svarar ja för domäner i kontaktade.txt. */
export class KandaDomaner extends Set<string> {
  private hashar: Set<string>;
  constructor(domaner: Iterable<string> = [], fil = KONTAKTADE_FIL) {
    super(domaner);
    this.hashar = lasKontaktade(fil);
  }
  override has(doman: string): boolean {
    return super.has(doman) || this.hashar.has(domanHash(doman));
  }
}
