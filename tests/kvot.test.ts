import { describe, expect, it } from "vitest";
import { kvotSammanfattning, kvotSnitt, rymsPass, rymsSajter, type Kvotrad } from "../src/pass/kvot.js";

const rad = (sajter: number, session: number, vecka: number): Kvotrad => ({
  datum: "2026-10-12", sajter, klara: sajter, fore: { session: 100, vecka: 80 }, efter: { session: 100 - session * sajter, vecka: 80 - vecka * sajter },
  forbrukning: { session: session * sajter, vecka: vecka * sajter }, per_sajt: { session, vecka }, kommentar: "",
});

describe("kvotmätningen", () => {
  it("räknar antal sajter som ryms i sessionen med en femtedels marginal", () => {
    expect(rymsSajter(100, 10)).toBe(8);
    expect(rymsSajter(45, 10)).toBe(3);
    expect(rymsSajter(100, 0)).toBe(0);
    expect(rymsSajter(10, 12)).toBe(0);
  });
  it("räknar antal pass på åtta sajter som veckan räcker till", () => {
    expect(rymsPass(100, 2)).toBe(6);
    expect(rymsPass(50, 2)).toBe(3);
    expect(rymsPass(100, 0)).toBe(0);
    expect(rymsPass(100, 2, 4)).toBe(12);
  });
  it("snittar per sajt över passen för båda gränserna och sammanfattar", () => {
    const snitt = kvotSnitt([rad(2, 10, 2), rad(4, 8, 1)]);
    expect(snitt).toEqual({ antalPass: 2, perSajt: { session: 9, vecka: 1.5 } });
    const text = kvotSammanfattning(snitt, { session: 90, vecka: 60 });
    expect(text).toContain("9 procentenheter av sessionen och 1.5 av veckan per sajt");
    expect(text).toContain("ryms 8 sajter");
    expect(text).toContain("drar 12 procent av veckan");
    expect(text).toContain("räcker veckan till 5 sådana pass, en hel vecka till 8");
    expect(kvotSammanfattning(kvotSnitt([]), { session: 100, vecka: 100 })).toContain("Ingen tidigare mätning");
  });
});
