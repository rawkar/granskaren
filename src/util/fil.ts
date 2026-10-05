import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";

export function sakerstallMapp(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function dataMapp(...delar: string[]): string {
  return sakerstallMapp(path.join(DATA_DIR, ...delar));
}

/** Gör en sträng säker som filnamn. */
export function filnamnSaker(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120);
}

export function skrivJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

export function lasJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}
