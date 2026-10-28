import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testDb } from "../src/db/index.js";
import { laggTillProspekt, laggTillSparr } from "../src/db/fragor.js";
import { arKontaktad, domanHash, KandaDomaner, lasKontaktade, uppdateraKontaktade } from "../src/db/kontaktade.js";

function tempFil(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kontaktade-")), "kontaktade.txt");
}

function medSkickat(doman: string, status = "skickad") {
  const d = testDb();
  const { id } = laggTillProspekt(d, { doman });
  d.prepare("INSERT INTO mejl (prospekt_id, typ, amne, text, anvanda_fynd, sakerhet, status, mottagare) VALUES (?, 'forsta', 'Ämne', 'Hej', '[]', 0.9, ?, ?)").run(id, status, `info@${doman}`);
  return d;
}

describe("kontaktade.txt delas mellan datorer", () => {
  it("skriver skickade och spärrade domäner som hashar, inte i klartext", () => {
    const d = medSkickat("skickat.se");
    laggTillSparr(d, "sparrad.se", "bad att slippa");
    const fil = tempFil();
    expect(uppdateraKontaktade(d, fil)).toEqual({ nya: 2, totalt: 2 });
    const text = fs.readFileSync(fil, "utf8");
    expect(text).not.toMatch(/skickat\.se|sparrad\.se/);
    expect(arKontaktad("skickat.se", fil)).toBe(true);
    expect(arKontaktad("SPARRAD.se", fil)).toBe(true);
    expect(arKontaktad("annan.se", fil)).toBe(false);
  });

  it("tar inte med mejl som bara är köade eller i granskning", () => {
    const d = medSkickat("koad.se", "koad");
    const fil = tempFil();
    expect(uppdateraKontaktade(d, fil).totalt).toBe(0);
    expect(arKontaktad("koad.se", fil)).toBe(false);
  });

  it("behåller det som en annan dator har skrivit", () => {
    const fil = tempFil();
    fs.writeFileSync(fil, `# huvud\n${domanHash("fran-annan-dator.se")}\n`);
    const r = uppdateraKontaktade(medSkickat("har.se"), fil);
    expect(r).toEqual({ nya: 1, totalt: 2 });
    expect(lasKontaktade(fil)).toEqual(new Set([domanHash("fran-annan-dator.se"), domanHash("har.se")]));
  });

  it("kända domäner svarar ja för domäner i filen", () => {
    const fil = tempFil();
    fs.writeFileSync(fil, `${domanHash("kontaktad.se")}\n`);
    const k = new KandaDomaner(["prospekt.se"], fil);
    expect(k.has("prospekt.se")).toBe(true);
    expect(k.has("kontaktad.se")).toBe(true);
    expect(k.has("ny.se")).toBe(false);
  });
});
