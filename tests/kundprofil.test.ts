import { describe, expect, it } from "vitest";
import { fordelaAntal, justeraFordelning, lasKundprofil } from "../src/discover/kundprofil.js";
import { tilltalFor } from "../src/email/utkast.js";

const fil = `# Kundprofil

## Förebilder
Text.
- wolfcreative.se (art director, eget företag)
- [Linda Jägerströms sajt] (stylist, eget företag)
- https://www.exempel.se/ (förening)

> anvisning som inte ska läsas

## Kundtyp 1: Egenföretagare
Personer som säljer sin egen kompetens.

## Kundtyp 2: Mindre organisationer
Föreningar och stiftelser.

## Var
Stockholm och Mälardalen.

## Välj bort
- Myndigheter
- Byråer

## Inställningar
fordelning: 1=60, 2=40
minsta_andel: 20
min_likhet: 0.7
`;

describe("kundprofil", () => {
  const kp = lasKundprofil(fil);
  it("läser förebilder med giltig domän och hoppar över platshållare", () => {
    expect(kp.forebilder).toEqual([
      { doman: "wolfcreative.se", beskrivning: "art director, eget företag" },
      { doman: "exempel.se", beskrivning: "förening" },
    ]);
  });
  it("läser kundtyper, var, välj bort och inställningar", () => {
    expect(kp.kundtyper.map((k) => [k.nr, k.namn])).toEqual([
      [1, "Egenföretagare"],
      [2, "Mindre organisationer"],
    ]);
    expect(kp.var).toBe("Stockholm och Mälardalen.");
    expect(kp.valjBort).toEqual(["Myndigheter", "Byråer"]);
    expect(kp.fordelning).toEqual({ 1: 60, 2: 40 });
    expect(kp.minstaAndel).toBe(20);
    expect(kp.minLikhet).toBe(0.7);
    expect(kp.text).not.toContain("anvisning som inte ska läsas");
  });
});

describe("fördelning", () => {
  it("fördelar antal enligt procent med största rest först", () => {
    expect(fordelaAntal(20, { 1: 50, 2: 25, 3: 25 })).toEqual({ 1: 10, 2: 5, 3: 5 });
    expect(fordelaAntal(7, { 1: 50, 2: 25, 3: 25 })).toEqual({ 1: 3, 2: 2, 3: 2 });
    expect(fordelaAntal(9, { 1: 50, 2: 25, 3: 25 })).toEqual({ 1: 5, 2: 2, 3: 2 });
    expect(fordelaAntal(1, { 1: 50, 2: 25, 3: 25 })).toEqual({ 1: 1, 2: 0, 3: 0 });
  });
  it("ändrar inte fördelningen utan underlag", () => {
    expect(justeraFordelning({ 1: 50, 2: 25, 3: 25 }, { 1: { skickade: 3, svar: 1 } }, 15)).toEqual({ 1: 50, 2: 25, 3: 25 });
  });
  it("viktar mot svar men låter ingen typ gå under minsta andel", () => {
    const ny = justeraFordelning(
      { 1: 50, 2: 25, 3: 25 },
      { 1: { skickade: 20, svar: 6 }, 2: { skickade: 20, svar: 0 }, 3: { skickade: 20, svar: 2 } },
      15,
    );
    expect(ny[1]).toBeGreaterThan(50);
    expect(ny[2]).toBe(15);
    expect(ny[3]).toBeGreaterThanOrEqual(15);
    expect(ny[1] + ny[2] + ny[3]).toBe(100);
  });
  it("ger typer utan underlag genomsnittets vikt", () => {
    const ny = justeraFordelning({ 1: 50, 2: 25, 3: 25 }, { 1: { skickade: 20, svar: 4 }, 2: { skickade: 20, svar: 4 } }, 15);
    for (const t of [1, 2, 3]) expect(ny[t]).toBeGreaterThanOrEqual(33);
    expect(ny[1] + ny[2] + ny[3]).toBe(100);
  });
});

describe("tilltal per kundtyp", () => {
  const profil = {
    person: { drivs_av_namngiven_person: true, fornamn: "Pernilla Wolf", sakerhet: 0.9, belagg: null },
  } as unknown as Parameters<typeof tilltalFor>[0];
  it("kundtyp 1 får förnamn och du, övriga ni", () => {
    expect(tilltalFor(profil, 1)).toEqual({ tilltal: "du", fornamn: "Pernilla" });
    expect(tilltalFor(profil, 2)).toEqual({ tilltal: "ni", fornamn: null });
    expect(tilltalFor(profil, 3)).toEqual({ tilltal: "ni", fornamn: null });
  });
  it("utan kundtyp avgör profilen", () => {
    expect(tilltalFor(profil, null)).toEqual({ tilltal: "du", fornamn: "Pernilla" });
    expect(tilltalFor(null, null)).toEqual({ tilltal: "ni", fornamn: null });
    expect(tilltalFor(null, 1)).toEqual({ tilltal: "du", fornamn: null });
  });
});
