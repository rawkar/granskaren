import { describe, expect, it } from "vitest";
import { omfangsText, STANDARD_MAX_FYND, upptrappningsSkal } from "../src/analyze/analys.js";

describe("upptrappning", () => {
  it("trappar inte upp när analysen håller", () => {
    expect(upptrappningsSkal({ huvudinsikt: true, bekraftade: 3, djup3Bekraftat: true })).toBeNull();
  });
  it("trappar upp utan huvudinsikt, utan djup 3 eller med färre än tre bekräftade", () => {
    expect(upptrappningsSkal({ huvudinsikt: false, bekraftade: 4, djup3Bekraftat: true })).toBe("ingen huvudinsikt");
    expect(upptrappningsSkal({ huvudinsikt: true, bekraftade: 4, djup3Bekraftat: false })).toBe("inget bekräftat fynd med djup 3");
    expect(upptrappningsSkal({ huvudinsikt: true, bekraftade: 2, djup3Bekraftat: true })).toBe("bara 2 fynd bekräftade");
  });
});
import { AnalysKortSchema, franKortAnalys } from "../src/analyze/schema.js";

describe("omfång för analysen", () => {
  it("lägger inte till något när prompten gäller som den är skriven", () => {
    expect(omfangsText(STANDARD_MAX_FYND, false)).toBe("");
    expect(omfangsText(8, false)).toBe("");
  });

  it("begär färre fynd och minst ett med djup 3", () => {
    const t = omfangsText(4, false);
    expect(t).toContain("högst 4 fynd");
    expect(t).toContain("djup 3");
    expect(t).toContain("konkret förslag");
    expect(t).not.toContain("insikt och rotorsak");
  });

  it("beskriver det sammanslagna fältet när analysen är kort", () => {
    const t = omfangsText(4, true);
    expect(t).toContain("högst 4 fynd");
    expect(t).toContain("insikt och rotorsak finns inte");
    expect(t).toContain("högst två meningar");
  });
});

describe("kort analys", () => {
  it("saknar insikt och rotorsak i schemat och fyller dem efteråt", () => {
    const fynd = AnalysKortSchema.shape.fynd.element;
    expect(Object.keys(fynd.shape)).not.toContain("insikt");
    expect(Object.keys(fynd.shape)).not.toContain("rotorsak");
    expect(Object.keys(fynd.shape)).toContain("belagg");
    expect(Object.keys(fynd.shape)).toContain("forslag_konkret");
    expect(Object.keys(fynd.shape)).toContain("djup");
    const a = franKortAnalys({
      organisationstyp: "forening",
      organisationsnamn: "X",
      profil: {} as never,
      sammanfattning: "",
      valskott: false,
      bra: [],
      fynd: [{ id: "F1", omrade: "A", tjansteomrade: "strategi", rubrik: "r", observation: "o", belagg: { url: "u", typ: "citat", varde: "v" }, belagg2: null, effekt: "e", atgard: "a", allvar: 2, sakerhet: 0.8, latt_att_forklara: 2, djup: 3, forslag_konkret: null, insats: "liten", kopplar_till_syfte: true }],
      huvudinsikt: null,
      borja_med: [],
    });
    expect(a.fynd[0].insikt).toBe("");
    expect(a.fynd[0].rotorsak).toBeNull();
    expect(a.fynd[0].observation).toBe("o");
  });
});
