import { describe, expect, it } from "vitest";
import { testDb } from "../src/db/index.js";
import { laggTillProspekt, loggaHandelse, sparaFynd, sparaKostnad, sattVerifiering } from "../src/db/fragor.js";
import { avbrytPaus, bedomVakt, pausa, pausad, periodMatt, type PeriodMatt } from "../src/report/vakt.js";

const matt = (x: Partial<PeriodMatt>): PeriodMatt => ({
  fran: "",
  till: "",
  skickade: 0,
  granskade: 10,
  fynd: 60,
  bekraftade: 54,
  upptrappade: 0,
  utkast: 0,
  stoppade: 0,
  svar: 0,
  kostnad: 0,
  kostnadPerSteg: {},
  ...x,
});

describe("kvalitetsvakten", () => {
  const opus = matt({ fynd: 100, bekraftade: 90 });

  it("dömer inte på för få sajter", () => {
    expect(bedomVakt(opus, matt({ granskade: 4, fynd: 16, bekraftade: 8 }))).toEqual([]);
  });

  it("släpper igenom ett tapp inom fem procentenheter", () => {
    expect(bedomVakt(opus, matt({ granskade: 8, fynd: 40, bekraftade: 35 }))).toEqual([]); // 87,5 %
  });

  it("slår till när andelen bekräftade sjunker mer än fem procentenheter", () => {
    const skal = bedomVakt(opus, matt({ granskade: 8, fynd: 40, bekraftade: 33 })); // 82,5 %
    expect(skal).toHaveLength(1);
    expect(skal[0]).toMatch(/andelen bekräftade fynd/);
  });

  it("slår till när mer än var tredje sajt trappas upp", () => {
    expect(bedomVakt(opus, matt({ granskade: 9, fynd: 36, bekraftade: 34, upptrappade: 3 }))).toEqual([]);
    const skal = bedomVakt(opus, matt({ granskade: 9, fynd: 36, bekraftade: 34, upptrappade: 4 }));
    expect(skal[0]).toMatch(/4 av 9 granskade sajter trappades upp/);
  });
});

describe("periodmått och paus", () => {
  it("räknar fynd, upptrappningar, stoppade utkast och kostnad i rätt period", () => {
    const d = testDb();
    const { id } = laggTillProspekt(d, { doman: "a.se" });
    d.prepare("UPDATE prospekt SET granskad = '2026-10-10 09:00:00' WHERE id = ?").run(id);
    const f1 = sparaFynd(d, fyndRad(id, "F1"));
    const f2 = sparaFynd(d, fyndRad(id, "F2"));
    sattVerifiering(d, f1, true, "kod", null);
    sattVerifiering(d, f2, false, "kod", "nej");
    d.prepare("INSERT INTO handelser (prospekt_id, typ, detaljer, tidpunkt) VALUES (?, 'upptrappning', '{}', '2026-10-10 09:05:00')").run(id);
    d.prepare("INSERT INTO handelser (prospekt_id, typ, detaljer, tidpunkt) VALUES (?, 'utkast_skapat', '{\"status\":\"utkast\",\"fel\":[\"x\"]}', '2026-10-10 09:06:00')").run(id);
    d.prepare("INSERT INTO handelser (prospekt_id, typ, detaljer, tidpunkt) VALUES (?, 'utkast_skapat', '{\"status\":\"koad\",\"fel\":[]}', '2026-10-10 09:07:00')").run(id);
    d.prepare("INSERT INTO mejl (prospekt_id, typ, amne, text, anvanda_fynd, sakerhet, status, skickad) VALUES (?, 'forsta', 'a', 'b', '[]', 0.9, 'skickad', '2026-10-10 11:00:00')").run(id);
    sparaKostnad(d, { prospekt_id: id, steg: "analys", modell: "m", tokens_in: 1, tokens_ut: 1, kostnad_usd: 0.2 });
    d.prepare("UPDATE kostnader SET tidpunkt = '2026-10-10 09:01:00'").run();
    // Utanför perioden
    d.prepare("INSERT INTO handelser (prospekt_id, typ, detaljer, tidpunkt) VALUES (?, 'upptrappning', '{}', '2026-10-20 09:05:00')").run(id);

    const m = periodMatt(d, "2026-10-09", "2026-10-11");
    expect(m.granskade).toBe(1);
    expect(m.fynd).toBe(2);
    expect(m.bekraftade).toBe(1);
    expect(m.upptrappade).toBe(1);
    expect(m.utkast).toBe(2);
    expect(m.stoppade).toBe(1);
    expect(m.skickade).toBe(1);
    expect(m.kostnad).toBeCloseTo(0.2, 6);
    expect(m.kostnadPerSteg.analys).toBeCloseTo(0.2, 6);
    expect(periodMatt(d, "2026-10-11", "2026-10-30").upptrappade).toBe(1);
    expect(periodMatt(d, "2026-10-11", "2026-10-30").fynd).toBe(0);
  });

  it("sparar och tar bort en paus", () => {
    const d = testDb();
    expect(pausad(d)).toBeNull();
    const p = pausa(d, ["test"], new Date(2026, 9, 12));
    expect(p.datum).toBe("2026-10-12");
    expect(pausad(d)?.skal).toEqual(["test"]);
    expect(avbrytPaus(d)).toBe(true);
    expect(pausad(d)).toBeNull();
    expect(avbrytPaus(d)).toBe(false);
  });
});

function fyndRad(prospektId: number, fyndId: string) {
  return {
    prospekt_id: prospektId,
    fynd_id: fyndId,
    omrade: "A",
    tjansteomrade: "strategi",
    rubrik: "r",
    observation: "o",
    belagg_url: "https://a.se/",
    belagg_typ: "citat",
    belagg_varde: "v",
    effekt: "e",
    atgard: "a",
    allvar: 2,
    sakerhet: 0.8,
    latt_att_forklara: 2,
    djup: 3,
    insikt: "",
    rotorsak: null,
    forslag_konkret: null,
    insats: "liten",
    kopplar_till_syfte: 1,
    belagg2_url: null,
    belagg2_typ: null,
    belagg2_varde: null,
  };
}
