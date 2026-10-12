import { describe, expect, it } from "vitest";
import { KLIPP_FYND, tolkaAnalys } from "../src/analyze/analys.js";
import { AnalysSchema, VerifieringSchema } from "../src/analyze/schema.js";

const fynd = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  omrade: "A",
  rubrik: `Rubrik ${id}`,
  observation: "Texten står i sidfoten.",
  belagg: { url: "https://exempel.se/", typ: "citat", varde: "6 km från Eskilstuna" },
  effekt: "Besökaren får leta.",
  allvar: 2,
  forslag_konkret: null,
  ...extra,
});

describe("den lätta analysen", () => {
  it("tolkar ett svar med bara de nya fälten", () => {
    const a = tolkaAnalys({
      organisationstyp: "forening",
      organisationsnamn: "Torshälla GK",
      profil: { person: { drivs_av_namngiven_person: false, fornamn: null, sakerhet: 0.9, belagg: null }, vad_de_gor: "Golfklubb med 18 hål", huvudhandling: "bli medlem" },
      valskott: false,
      fynd: [fynd("f1"), fynd("f2", { allvar: 7, forslag_konkret: '"Bli medlem i Torshälla GK."' })],
    });
    expect(a.fynd).toHaveLength(2);
    expect(a.fynd[1].allvar).toBe(3);
    expect(a.fynd[1].forslag_konkret).toBe("Bli medlem i Torshälla GK");
    expect(a.profil.vad_de_gor).toBe("Golfklubb med 18 hål");
  });

  it("tolkar ett äldre fördjupat svar: extra fält tas bort och profilpunkter med varde blir text", () => {
    const a = tolkaAnalys({
      organisationstyp: "aktiebolag",
      organisationsnamn: "Lovisualisera",
      profil: {
        person: { drivs_av_namngiven_person: true, fornamn: "Lovisa", sakerhet: 0.8, belagg: "Ring eller maila mig" },
        vad_de_gor: { varde: "Inredningsprojekt", sakerhet: 0.9, belagg: "x", gissning: false },
        for_vem: { varde: "Privatpersoner", sakerhet: 0.5, belagg: null, gissning: true },
        huvudhandling: { varde: "boka platsbesök", sakerhet: 0.9, belagg: "boka in oss", gissning: false },
      },
      sammanfattning: "...",
      valskott: false,
      bra: [{ text: "x", url: null }],
      fynd: [fynd("f1", { tjansteomrade: "strategi", djup: 3, insikt: "i", rotorsak: null, atgard: "a", sakerhet: 0.8, latt_att_forklara: 3, insats: "liten", kopplar_till_syfte: true, belagg2: null })],
      huvudinsikt: { text: "...", fynd_ids: ["f1"] },
      borja_med: [],
    });
    expect(a.profil.vad_de_gor).toBe("Inredningsprojekt");
    expect(a.profil.huvudhandling).toBe("boka platsbesök");
    expect("huvudinsikt" in a).toBe(false);
    expect("djup" in a.fynd[0]).toBe(false);
  });

  it("behåller högst sex fynd och gör id:n unika", () => {
    const a = tolkaAnalys({
      organisationstyp: "okand",
      organisationsnamn: null,
      profil: { person: { drivs_av_namngiven_person: false, fornamn: null, sakerhet: 0.5, belagg: null }, vad_de_gor: "x", huvudhandling: "y" },
      valskott: false,
      fynd: [fynd("f1"), fynd("f1"), fynd("f3"), fynd("f4"), fynd("f5"), fynd("f6"), fynd("f7")],
    });
    expect(a.fynd).toHaveLength(KLIPP_FYND);
    expect(a.fynd.map((f) => f.id)).toEqual(["f1", "f1b", "f3", "f4", "f5", "f6"]);
  });

  it("kräver profil och fynd", () => {
    expect(AnalysSchema.safeParse({ organisationstyp: "okand", organisationsnamn: null, valskott: false, fynd: [] }).success).toBe(false);
  });
});

describe("verifieringens svar", () => {
  it("tillåter bekraftat, delvis och fel med galler_inte", () => {
    expect(VerifieringSchema.parse({ bedomning: "delvis", motivering: "x", galler_inte: "knappen är den enda som syns högt upp i mobilen" }).galler_inte).toMatch(/knappen/);
    expect(VerifieringSchema.safeParse({ bedomning: "osakert", motivering: "x", galler_inte: null }).success).toBe(false);
  });
});
