import { describe, expect, it } from "vitest";
import { testDb } from "../src/db/index.js";
import { arSparrad, harFattMejl, laggTillProspekt, laggTillSparr, sparaFynd, fyndForProspekt, sattVerifiering } from "../src/db/fragor.js";

describe("databasregler", () => {
  it("tillåter bara ett förstamejl per domän, även om koden försöker två gånger", () => {
    const d = testDb();
    const { id } = laggTillProspekt(d, { doman: "exempel.se" });
    const infoga = d.prepare(
      "INSERT INTO mejl (prospekt_id, typ, amne, text, anvanda_fynd, sakerhet, status) VALUES (?, 'forsta', 'a', 'b', '[]', 0.9, 'koad')",
    );
    infoga.run(id);
    expect(() => infoga.run(id)).toThrow(/UNIQUE/);
    expect(harFattMejl(d, id)).toBe(true);
  });

  it("tillåter inte två prospekt med samma domän", () => {
    const d = testDb();
    laggTillProspekt(d, { doman: "exempel.se" });
    expect(() => d.prepare("INSERT INTO prospekt (doman) VALUES ('exempel.se')").run()).toThrow(/UNIQUE/);
  });

  it("spärrlistan träffar både domän och adresser på domänen", () => {
    const d = testDb();
    laggTillSparr(d, "Exempel.se", "test");
    expect(arSparrad(d, "exempel.se")).toBe(true);
    expect(arSparrad(d, "info@exempel.se")).toBe(true);
    expect(arSparrad(d, "annan.se")).toBe(false);
    laggTillSparr(d, "kalle@annan.se", "nej tack");
    expect(arSparrad(d, "kalle@annan.se")).toBe(true);
    expect(arSparrad(d, "annan.se")).toBe(false);
  });

  it("obekräftade fynd filtreras bort när bara verifierade hämtas", () => {
    const d = testDb();
    const { id } = laggTillProspekt(d, { doman: "exempel.se" });
    const bas = {
      prospekt_id: id, omrade: "D", tjansteomrade: "webb", rubrik: "r", observation: "o", belagg_url: "https://exempel.se/",
      belagg_typ: "saknat_element", belagg_varde: "h1", effekt: "e", atgard: "a", allvar: 2, sakerhet: 0.9, latt_att_forklara: 2,
      djup: 2, insikt: null, rotorsak: null, forslag_konkret: null, insats: "liten", kopplar_till_syfte: 1,
      belagg2_url: null, belagg2_typ: null, belagg2_varde: null,
    };
    const a = sparaFynd(d, { ...bas, fynd_id: "f-001" });
    sparaFynd(d, { ...bas, fynd_id: "f-002" });
    sattVerifiering(d, a, true, "kod", null);
    expect(fyndForProspekt(d, id)).toHaveLength(2);
    expect(fyndForProspekt(d, id, true).map((f) => f.fynd_id)).toEqual(["f-001"]);
  });
});
