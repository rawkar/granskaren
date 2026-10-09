/**
 * De fem justeringarna av tonreglerna: falskt larm om saknat innehåll, tvärsäkra påståenden om besökare,
 * huvudpoängen om huvudfyndet, exemplet som inte får upprepa ett förslag, rytmen, och den fasta meningen om fler fynd.
 */
import { describe, expect, it } from "vitest";
import { exempelfel, huvudpoangfel, meningar, rytmfel, sprakfel, tillaggsfel, tonfel, tvarsakerhetsfel } from "../src/email/grind.js";
import { valjFynd, valjHuvudfynd } from "../src/email/val.js";
import { flerFyndMening, flerFyndText, lasFlerFyndMeningar, medFlerFynd } from "../src/email/utkast.js";
import type { FyndRad } from "../src/db/fragor.js";

function fynd(delar: Partial<FyndRad>): FyndRad {
  return {
    id: 0, prospekt_id: 1, fynd_id: "f", omrade: "D", tjansteomrade: "webb", rubrik: "r", observation: "o",
    belagg_url: "https://exempel.se/", belagg_typ: "citat", belagg_varde: "b", effekt: "e", atgard: "a",
    allvar: 2, sakerhet: 0.9, latt_att_forklara: 3, verifierad: 1, verifieringsmetod: "kod", verifieringsnot: null, skapad: "",
    djup: 3, insikt: "i", rotorsak: null, forslag_konkret: null, insats: "liten", kopplar_till_syfte: 1,
    belagg2_url: null, belagg2_typ: null, belagg2_varde: null,
    ...delar,
  };
}

const inledning = `Hej Emilia,

Jag heter Rawaz Karim och är kommunikationskonsult. Jag har gått igenom din webbplats och har några förslag som jag tror kan ge dig fler bokade konsultationer.`;

describe("1. falskt larm: beskrivningar av vad som saknas är tillåtna", () => {
  const emiliashem = "Dina priser efter RUT-avdrag står på tjänstesidan. Startsidan nämner att flera tjänster ger RUT-avdrag men säger inget om vad hjälpen kostar.";
  const omdome = (text: string) => sprakfel("Ämne", `${inledning}\n\n${text}\n\nrkkommunikation.se`, "", undefined, [], 400).filter((f) => /kritiserar/.test(f));

  it("släpper igenom meningen från emiliashem.com", () => {
    expect(omdome(emiliashem)).toEqual([]);
  });
  it("släpper igenom nämner inte och står inte", () => {
    expect(omdome("Startsidan nämner inte priserna. Garantin står inte på bokningssidan. Sidan säger ingenting om leveranstid.")).toEqual([]);
  });
  it("stoppar fortfarande omdömet att en rubrik säger inget", () => {
    expect(omdome("Rubriken överst säger inget. Den kunde stå var som helst.")).toHaveLength(1);
    expect(omdome("Rubriken är intetsägande.")).toHaveLength(1);
  });
});

describe("2. påståenden om hur besökare beter sig", () => {
  it("stoppar aldrig och alltid i meningar om besökare", () => {
    expect(tvarsakerhetsfel(["Få som jämför verkstäder i Södertälje klickar sig fram dit, så fördelarna når dem aldrig."])).toHaveLength(1);
    expect(tvarsakerhetsfel(["Den som tvekar läser alltid omdömena först."])).toHaveLength(1);
  });
  it("släpper igenom försiktiga formuleringar och aldrig om annat än besökare", () => {
    expect(tvarsakerhetsfel(["Få som jämför verkstäder klickar sig fram dit.", "Den som funderar på att boka läser ofta bokningsdelen, inte nyheterna."])).toEqual([]);
    expect(tvarsakerhetsfel(["Priset har aldrig stått på startsidan."])).toEqual([]);
  });
  it("ingår i tonfel", () => {
    const text = `${inledning}\n\nGarantin står inte på startsidan. Den står bara på Om oss. Så fördelarna når dem aldrig.`;
    expect(tonfel(text)).toContainEqual(expect.stringMatching(/för tvärsäkert/));
  });
});

describe("3. huvudpoängen är fyndet med störst betydelse", () => {
  const knapp = fynd({ fynd_id: "knapp", omrade: "H", belagg_url: "https://exempel.se/", rubrik: "Knappen kan berätta att konsultationen är kostnadsfri", observation: "Knappen heter Boka en konsultation", belagg_varde: "Boka en konsultation", forslag_konkret: "Boka en kostnadsfri konsultation" });
  const priser = fynd({ fynd_id: "priser", omrade: "A", belagg_url: "https://exempel.se/tjanster", rubrik: "De tydliga priserna kan synas redan på startsidan", observation: "Priserna efter RUT-avdrag står bara på tjänstesidan", belagg_varde: "Praktisk hjälp i ditt hem, halvdag 3 timmar 1 200 kr" });
  const omdomen = fynd({ fynd_id: "omdomen", omrade: "G", belagg_url: "https://exempel.se/konsultation", rubrik: "Omdömena kan stå bredvid formuläret", observation: "Startsidan har fem omdömen, konsultationssidan inget", belagg_varde: "omdömen" });
  const hi = { text: "x", fynd_ids: ["knapp", "priser", "omdomen"] };

  it("väljer högst allvar bland djup 2 och 3, och en knapptext sist vid lika allvar", () => {
    expect(valjHuvudfynd([knapp, priser, omdomen], new Set(hi.fynd_ids))?.fynd_id).toBe("priser");
    expect(valjHuvudfynd([knapp, { ...priser, allvar: 1 }, { ...omdomen, allvar: 1 }], new Set(hi.fynd_ids))?.fynd_id).toBe("knapp");
    expect(valjHuvudfynd([{ ...knapp, allvar: 3 }, priser, omdomen], new Set(hi.fynd_ids))?.fynd_id).toBe("knapp");
    expect(valjHuvudfynd([fynd({ fynd_id: "grund", djup: 1, allvar: 3 }), priser], new Set())?.fynd_id).toBe("priser");
  });
  it("lägger huvudfyndet först bland de valda", () => {
    const v = valjFynd([knapp, priser, omdomen], hi);
    expect(v.orsak).toBeNull();
    expect(v.huvud?.fynd_id).toBe("priser");
    expect(v.fynd[0].fynd_id).toBe("priser");
  });
  it("stoppar ett mejl som öppnar med knappen när priserna är huvudfyndet", () => {
    const medKnapp = `${inledning}\n\nDet gäller huvudknappen på startsidan. Där står Boka en konsultation. Att den är kostnadsfri står i texten ovanför och på konsultationssidan, men inte på knappen.`;
    expect(huvudpoangfel(medKnapp, [priser, knapp, omdomen], "priser")).toHaveLength(1);
    const medPriser = `${inledning}\n\nDina priser efter RUT-avdrag syns inte på startsidan. Praktisk hjälp i ditt hem, halvdag 3 timmar 1 200 kr, står bara på tjänstesidan. Den som undrar vad hjälpen kostar hittar ofta inte dit.`;
    expect(huvudpoangfel(medPriser, [priser, knapp, omdomen], "priser")).toEqual([]);
    expect(huvudpoangfel(medKnapp, [priser, knapp, omdomen], null)).toEqual([]);
  });
  it("stoppar ett exempel som upprepar ett förslag med samma ord", () => {
    const forslag = "Boka en kostnadsfri konsultation hos Emilia";
    const upprepar = `${inledning}\n\nKnappen skulle kunna heta Boka en kostnadsfri konsultation hos Emilia redan på startsidan.\n\nEtt exempel på knapptext\n\n${forslag}\n\nJag hjälper gärna till.`;
    expect(exempelfel(upprepar, [forslag])).toHaveLength(1);
    const citerar = `${inledning}\n\nKnappen heter i dag Boka en konsultation. Att den är kostnadsfri står ovanför.\n\nEtt exempel på knapptext\n\n${forslag}\n\nJag hjälper gärna till.`;
    expect(exempelfel(citerar, [forslag])).toEqual([]);
    expect(exempelfel(`${inledning}\n\nKnappen kan heta Boka tid.\n\nBoka tid\n\nHej då.`, ["Boka tid"])).toEqual([]);
  });
});

describe("4. rytmen", () => {
  const hackigt = "Det som skiljer dig från andra syns först på Om-sidan. Där står att du är fil. kand. i psykologi och har många år i försäljning bakom dig. Du har också ett eget kapitel i boken Sälj med stil. Startsidan nämner inget av det. Den som ska sälja sin bostad väljer stylist på förtroende, och den kunskapen kan avgöra valet.";
  const bundet = "Det som skiljer dig från andra står bara på Om-sidan. Där berättar du att du är fil. kand. i psykologi, har många år i försäljning bakom dig och har skrivit ett kapitel i boken Sälj med stil, men startsidan nämner inget av det. Den som ska sälja sin bostad väljer ofta stylist på förtroende, och då väger just den bakgrunden tungt.";

  it("delar inte meningar vid fil. kand.", () => {
    expect(meningar(hackigt)).toHaveLength(5);
    expect(meningar(bundet)).toHaveLength(3);
  });
  it("stoppar stycket från caseinterior.se och tre korta meningar i rad", () => {
    expect(rytmfel([hackigt])).toContainEqual(expect.stringMatching(/5 meningar, högst 4/));
    expect(rytmfel(["Garantin står på Om oss. Priset står där också. Startsidan har inget av det. Den som jämför läser sällan så långt."])).toContainEqual(expect.stringMatching(/tre korta meningar i rad/));
  });
  it("släpper igenom den ihopbundna versionen och två korta i rad", () => {
    expect(rytmfel([bundet])).toEqual([]);
    expect(rytmfel(["Garantin står på Om oss. Priset står där också. Den som jämför verkstäder läser sällan så långt ner på sidan."])).toEqual([]);
  });
});

describe("5. den fasta meningen om fler fynd", () => {
  it("läser fem pluralvarianter och en singularvariant per tilltal ur prompts/fler-fynd.md", () => {
    const m = lasFlerFyndMeningar();
    expect(m.du.flera).toHaveLength(5);
    expect(m.ni.flera).toHaveLength(5);
    expect(m.du.ett).toEqual(["Jag såg en sak till som jag gärna berättar om i ett samtal."]);
    expect(m.ni.ett).toHaveLength(1);
    expect(m.du.flera.every((x) => !/\b(ni|er|era)\b/i.test(x))).toBe(true);
    expect(m.ni.flera.every((x) => !/\b(du|dig|din)\b/i.test(x))).toBe(true);
    expect(m.du.flera[2]).toBe("Jag såg fler saker som går att förbättra, och dem berättar jag gärna om i ett samtal.");
  });
  it("väljer singular vid ett fynd, plural vid minst två, inget vid noll", () => {
    const m = lasFlerFyndMeningar();
    expect(flerFyndMening("ni", 7, 1)).toBe(m.ni.ett[0]);
    expect(flerFyndMening("ni", 7, 2)).toBe(m.ni.flera[2]);
    expect(flerFyndMening("ni", 7, 3)).toBe(flerFyndMening("ni", 7, 2));
    expect(flerFyndMening("du", 7, 0)).toBeNull();
  });
  it("lägger meningen som eget stycke före erbjudandet", () => {
    const brod = `${inledning}\n\nGarantin står inte på startsidan.\n\nTre års garanti\n\nJag hjälper gärna till. Mer finns på rkkommunikation.se.\n\nVänliga hälsningar`;
    const ut = medFlerFynd(brod, "Jag såg några saker till.");
    const s = ut.split("\n\n");
    expect(s[s.indexOf("Jag såg några saker till.") + 1]).toMatch(/rkkommunikation\.se/);
    expect(medFlerFynd(brod, null)).toBe(brod);
  });
  it("säger till modellen att inte skriva meningen själv och stoppar den om den gör det", () => {
    expect(flerFyndText(null)).toBe("");
    expect(flerFyndText(2)).toContain("Skriv inte att Rawaz såg fler saker");
    expect(flerFyndText(0)).toContain("Skriv inte att Rawaz såg fler saker");
    const brod = `${inledning}\n\nDet finns fler saker som går att förbättra.`;
    const f = [fynd({ forslag_konkret: "Tre års garanti" })];
    expect(tillaggsfel(`${brod}\n\nTre års garanti`, f, 2)).toContainEqual(expect.stringMatching(/skriver själv att det finns fler saker/));
    expect(tillaggsfel(`${brod}\n\nTre års garanti`, f, 0)).toContainEqual(expect.stringMatching(/fast inga fler fynd/));
    expect(tillaggsfel(`${brod}\n\nTre års garanti`, f, null).filter((x) => /fler saker/.test(x))).toEqual([]);
  });
});
