import { describe, expect, it } from "vitest";
import { testDb } from "../src/db/index.js";
import {
  kostnadDennaManad,
  markeraSoktraffBehandlad,
  obehandladeSoktraffar,
  segmentSoktNyligen,
  sparaKostnad,
  sparaSoktraffar,
} from "../src/db/fragor.js";

describe("kostnad per månad", () => {
  it("räknar bara anrop i den innevarande månaden", () => {
    const d = testDb();
    sparaKostnad(d, { prospekt_id: null, steg: "analys", modell: "claude-opus-5-5", tokens_in: 10, tokens_ut: 5, kostnad_usd: 0.3 });
    sparaKostnad(d, { prospekt_id: null, steg: "utkast", modell: "claude-opus-5-5", tokens_in: 10, tokens_ut: 5, kostnad_usd: 0.2 });
    // En gammal post från förra månaden
    d.prepare("INSERT INTO kostnader (steg, modell, tokens_in, tokens_ut, kostnad_usd, tidpunkt) VALUES ('analys', 'x', 1, 1, 5, datetime('now', '-40 days'))").run();
    expect(kostnadDennaManad(d)).toBeCloseTo(0.5, 6);
  });

  it("sparar antal webbsökningar", () => {
    const d = testDb();
    sparaKostnad(d, { prospekt_id: null, steg: "discover_webb", modell: "claude-opus-5-5", tokens_in: 10, tokens_ut: 5, sokningar: 4, kostnad_usd: 0.1 });
    const r = d.prepare("SELECT sokningar FROM kostnader").get() as { sokningar: number };
    expect(r.sokningar).toBe(4);
  });
});

describe("sparade sökträffar", () => {
  const traff = (doman: string, segment_id: number, kundtyp: number) => ({ segment_id, kundtyp, kalla: "discover:webb", doman, namn: null, varfor: null });

  it("sparar träffar, hoppar över dubbletter och lämnar ut bara obehandlade", () => {
    const d = testDb();
    d.prepare("INSERT INTO segment (id, kundtyp, yrke, ort, sokfras) VALUES (1, 1, 'fotograf', 'Uppsala', 'fotograf Uppsala')").run();
    expect(sparaSoktraffar(d, [traff("a.se", 1, 1), traff("b.se", 1, 1), traff("a.se", 1, 1)])).toBe(2);
    expect(obehandladeSoktraffar(d, { kundtyp: 1 }).map((t) => t.doman)).toEqual(["a.se", "b.se"]);
    expect(obehandladeSoktraffar(d, { kundtyp: 2 })).toHaveLength(0);
    markeraSoktraffBehandlad(d, "a.se");
    expect(obehandladeSoktraffar(d, { kundtyp: 1 }).map((t) => t.doman)).toEqual(["b.se"]);
    expect(obehandladeSoktraffar(d, { segmentId: 1 }).map((t) => t.doman)).toEqual(["b.se"]);
  });

  it("räknar träffar äldre än 30 dagar som för gamla", () => {
    const d = testDb();
    d.prepare("INSERT INTO segment (id, kundtyp, yrke, ort, sokfras) VALUES (1, 1, 'fotograf', 'Uppsala', 'fotograf Uppsala')").run();
    sparaSoktraffar(d, [traff("ny.se", 1, 1)]);
    d.prepare("INSERT INTO soktraffar (segment_id, kundtyp, kalla, doman, hittad) VALUES (1, 1, 'discover:webb', 'gammal.se', datetime('now', '-31 days'))").run();
    expect(obehandladeSoktraffar(d, { kundtyp: 1 }).map((t) => t.doman)).toEqual(["ny.se"]);
    expect(segmentSoktNyligen(d, 1)).not.toBeNull();
    expect(segmentSoktNyligen(d, 2)).toBeNull();
  });

  it("ett segment som bara söktes för länge sedan räknas inte som nyligen sökt", () => {
    const d = testDb();
    d.prepare("INSERT INTO segment (id, kundtyp, yrke, ort, sokfras) VALUES (1, 1, 'fotograf', 'Uppsala', 'fotograf Uppsala')").run();
    d.prepare("INSERT INTO soktraffar (segment_id, kundtyp, kalla, doman, hittad) VALUES (1, 1, 'discover:webb', 'gammal.se', datetime('now', '-31 days'))").run();
    expect(segmentSoktNyligen(d, 1)).toBeNull();
  });
});
