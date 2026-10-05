import { describe, expect, it } from "vitest";
import { normaliseraDoman, sammaSajt } from "../src/util/domain.js";
import { tolkaCsv, importeraRader } from "../src/discover/import.js";
import { testDb } from "../src/db/index.js";
import { allaProspekt } from "../src/db/fragor.js";

describe("normaliseraDoman", () => {
  it("tar bort protokoll, www, sökväg och port", () => {
    expect(normaliseraDoman("https://www.Exempel.se/om-oss?x=1")).toBe("exempel.se");
    expect(normaliseraDoman("http://exempel.se:8080/")).toBe("exempel.se");
    expect(normaliseraDoman("exempel.se")).toBe("exempel.se");
    expect(normaliseraDoman("  WWW.EXEMPEL.SE  ")).toBe("exempel.se");
  });
  it("behåller underdomäner som inte är www", () => {
    expect(normaliseraDoman("https://kansli.exempel.se")).toBe("kansli.exempel.se");
  });
  it("ger null för ogiltiga värden", () => {
    expect(normaliseraDoman("")).toBeNull();
    expect(normaliseraDoman("bara text")).toBeNull();
    expect(normaliseraDoman("localhost")).toBeNull();
  });
  it("känner igen samma sajt", () => {
    expect(sammaSajt("https://www.exempel.se/a", "http://exempel.se/b")).toBe(true);
    expect(sammaSajt("https://exempel.se", "https://annan.se")).toBe(false);
  });
});

describe("import", () => {
  it("tolkar csv med citattecken och semikolon", () => {
    const rader = tolkaCsv('url;namn;ort\nexempel.se;"Förening, AB";Uppsala\n');
    expect(rader).toEqual([{ url: "exempel.se", namn: "Förening, AB", ort: "Uppsala" }]);
  });
  it("hoppar över dubbletter och ogiltiga rader", () => {
    const d = testDb();
    const r = importeraRader(d, [
      { url: "https://www.exempel.se/", namn: "Exempel" },
      { url: "exempel.se" },
      { url: "annan.se" },
      { url: "ogiltig" },
    ]);
    expect(r.tillagda).toEqual(["exempel.se", "annan.se"]);
    expect(r.dubbletter).toEqual(["exempel.se"]);
    expect(r.ogiltiga).toEqual(["ogiltig"]);
    expect(allaProspekt(d).map((p) => p.doman)).toEqual(["exempel.se", "annan.se"]);
    const igen = importeraRader(d, [{ url: "exempel.se" }]);
    expect(igen.dubbletter).toEqual(["exempel.se"]);
  });
});
