import { describe, expect, it } from "vitest";
import { testDb } from "../src/db/index.js";
import { laggTillProspekt, laggTillSparr } from "../src/db/fragor.js";
import { arVardag, hinder, inomFonster, nyttMessageId, skickadeIdag, type MejlRad } from "../src/email/skicka.js";
import type { Konfig } from "../src/config.js";

const k = {
  SANDFONSTER_START: "08:30",
  SANDFONSTER_SLUT: "15:30",
  MAX_MEJL_PER_DAG: 2,
} as Konfig;

const mandag10 = new Date(2026, 9, 5, 10, 0); // måndag 5 oktober 2026
const lordag10 = new Date(2026, 9, 10, 10, 0);
const mandag17 = new Date(2026, 9, 5, 17, 0);

function mejl(d: ReturnType<typeof testDb>, prospektId: number, status = "koad"): MejlRad {
  const r = d
    .prepare("INSERT INTO mejl (prospekt_id, typ, mottagare, amne, text, anvanda_fynd, sakerhet, status) VALUES (?, 'forsta', 'info@exempel.se', 'a', 'b', '[]', 0.9, ?)")
    .run(prospektId, status);
  return d.prepare("SELECT * FROM mejl WHERE id = ?").get(Number(r.lastInsertRowid)) as MejlRad;
}

describe("tidsfönster och dagligt tak", () => {
  it("känner igen vardagar och fönstret", () => {
    expect(arVardag(mandag10)).toBe(true);
    expect(arVardag(lordag10)).toBe(false);
    expect(inomFonster(mandag10, "08:30", "15:30")).toBe(true);
    expect(inomFonster(mandag17, "08:30", "15:30")).toBe(false);
    expect(inomFonster(new Date(2026, 9, 5, 8, 29), "08:30", "15:30")).toBe(false);
    expect(inomFonster(new Date(2026, 9, 5, 15, 30), "08:30", "15:30")).toBe(true);
  });

  it("stoppar utanför vardag och fönster", () => {
    const d = testDb();
    const { id } = laggTillProspekt(d, { doman: "exempel.se" });
    const m = mejl(d, id);
    expect(hinder(d, k, m, mandag10)).toBeNull();
    expect(hinder(d, k, m, lordag10)).toBe("inte en vardag");
    expect(hinder(d, k, m, mandag17)).toMatch(/sändfönstret/);
  });

  it("räknar dagens skickade och stoppar vid taket", () => {
    const d = testDb();
    const a = laggTillProspekt(d, { doman: "a.se" }).id;
    const b = laggTillProspekt(d, { doman: "b.se" }).id;
    const c = laggTillProspekt(d, { doman: "c.se" }).id;
    const dag = "2026-10-05";
    d.prepare("UPDATE mejl SET status = 'skickad', skickad = ? WHERE id = ?").run(`${dag} 09:00:00`, mejl(d, a).id);
    expect(skickadeIdag(d, mandag10)).toBe(1);
    expect(hinder(d, k, mejl(d, b), mandag10)).toBeNull();
    d.prepare("UPDATE mejl SET status = 'skickad', skickad = ? WHERE prospekt_id = ?").run(`${dag} 09:30:00`, b);
    expect(skickadeIdag(d, mandag10)).toBe(2);
    expect(hinder(d, k, mejl(d, c), mandag10)).toMatch(/tak/);
  });

  it("stoppar spärrade mottagare och domäner", () => {
    const d = testDb();
    const { id } = laggTillProspekt(d, { doman: "exempel.se" });
    const m = mejl(d, id);
    laggTillSparr(d, "exempel.se", "test");
    expect(hinder(d, k, m, mandag10)).toMatch(/spärrlistan/);
  });

  it("skapar giltiga Message-ID på avsändarens domän", () => {
    const id = nyttMessageId("rawaz@rkkommunikation.se");
    expect(id).toMatch(/^<granskaren\.\d+\.[a-f0-9]{12}@rkkommunikation\.se>$/);
    expect(nyttMessageId("x@a.se")).not.toBe(id);
  });
});
