import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { kontrolleraMedKod, verifieraFynd } from "../src/analyze/verifiering.js";
import type { Belagg, Fynd } from "../src/analyze/schema.js";
import type { Underlag } from "../src/analyze/underlag.js";
import { kontrolleraSida, kontrolleraSajt } from "../src/measure/kontroller.js";
import { mattForSida } from "../src/measure/matt.js";
import { testDb } from "../src/db/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "fixtures", "brister.html"), "utf8");
const text = cheerio.load(html)("body").text().replace(/[ \t]+/g, " ").trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "granskaren-"));
const htmlSokvag = path.join(tmp, "start.html");
fs.writeFileSync(htmlSokvag, html);

const url = "https://exempelforeningen.se/";
const kontroll = kontrolleraSida(html, url, text);
const sajt = kontrolleraSajt([{ url, roll: "start", kontroll, sparningsAnrop: [] }], {
  sitemapUrl: null,
  robotsFinns: false,
  https: { ok: true, fel: null },
  lankar: [{ url: "https://exempelforeningen.se/verksamhet", status: 404, fran: url }],
  antalKontrolleradeLankar: 1,
});
const underlag: Underlag = {
  doman: "exempelforeningen.se",
  namn: null,
  bransch: null,
  ort: null,
  granskad: new Date().toISOString(),
  sajt,
  matt: null,
  sidor: [
    {
      roll: "start",
      url,
      slutlig_url: url,
      statuskod: 200,
      titel: "Startsida",
      laddtid_ms: 1200,
      text,
      kontroll,
      matt: mattForSida(html, url, text),
      lighthouse: null,
      axe: null,
      skarmbild_dator: null,
      skarmbild_mobil: null,
      html_sokvag: htmlSokvag,
    },
  ],
};

const bas: Omit<Fynd, "belagg" | "omrade"> = {
  id: "f-001",
  rubrik: "Test",
  observation: "Test",
  effekt: "Test",
  allvar: 2,
  forslag_konkret: null,
};
const belagg = (typ: Belagg["typ"], varde: string, u = url): Belagg => ({ url: u, typ, varde });
const fynd = (omrade: Fynd["omrade"], typ: Belagg["typ"], varde: string, u = url, extra: Partial<Fynd> = {}): Fynd => ({
  ...bas,
  omrade,
  belagg: belagg(typ, varde, u),
  ...extra,
});

describe("verifiering med kod", () => {
  it("bekräftar saknat element när selektorn ger noll träffar", () => {
    expect(kontrolleraMedKod(underlag, belagg("saknat_element", 'meta[name="description"]'), [])?.ok).toBe(true);
    expect(kontrolleraMedKod(underlag, belagg("saknat_element", "h1"), [])?.ok).toBe(false);
  });
  it("bekräftar mätvärden mot underlaget med tolerans", () => {
    expect(kontrolleraMedKod(underlag, belagg("matvarde", "kontroll.bilder_utan_alt=2"), [])?.ok).toBe(true);
    expect(kontrolleraMedKod(underlag, belagg("matvarde", "kontroll.bilder_utan_alt=7"), [])?.ok).toBe(false);
    expect(kontrolleraMedKod(underlag, belagg("matvarde", "kontroll.metabeskrivning_saknas=true"), [])?.ok).toBe(true);
    expect(kontrolleraMedKod(underlag, belagg("matvarde", "kontroll.analysverktyg=Google Analytics"), [])?.ok).toBe(true);
    expect(kontrolleraMedKod(underlag, belagg("matvarde", "sajt.sitemap_finns=false"), [])?.ok).toBe(true);
    expect(kontrolleraMedKod(underlag, belagg("matvarde", "kontroll.finns_inte=1"), [])?.ok).toBe(false);
    expect(kontrolleraMedKod(underlag, belagg("matvarde", "lighthouse.lcp_ms=6000"), [])?.ok).toBe(false);
    expect(kontrolleraMedKod(underlag, belagg("matvarde", "matt.formular_1_falt=3"), [])?.ok).toBe(true);
    expect(kontrolleraMedKod(underlag, belagg("matvarde", "matt.formular_1_falt=9"), [])?.ok).toBe(false);
  });
  it("bekräftar citat bara när det finns ordagrant", () => {
    expect(kontrolleraMedKod(underlag, belagg("citat", "Senaste nyheten publicerades 12 mars 2021"), [])?.ok).toBe(true);
    expect(kontrolleraMedKod(underlag, belagg("citat", "“Senaste nyheten publicerades 12 mars 2021”"), [])?.ok).toBe(true);
    expect(kontrolleraMedKod(underlag, belagg("citat", "Senaste nyheten publicerades 12 mars 2022"), [])?.ok).toBe(false);
  });
  it("bekräftar statuskoder från sidor och länkkontroll", () => {
    const lankar = [{ url: "https://exempelforeningen.se/verksamhet", status: 404, fran: url }];
    expect(kontrolleraMedKod(underlag, belagg("statuskod", "404", "https://exempelforeningen.se/verksamhet"), lankar)?.ok).toBe(true);
    expect(kontrolleraMedKod(underlag, belagg("statuskod", "404", "https://exempelforeningen.se/okand"), lankar)?.ok).toBe(false);
    expect(kontrolleraMedKod(underlag, belagg("statuskod", "200"), lankar)?.ok).toBe(true);
  });
  it("underkänner belägg som pekar på en sida som inte hämtats", () => {
    expect(kontrolleraMedKod(underlag, belagg("saknat_element", "h1", "https://exempelforeningen.se/annan"), [])?.ok).toBe(false);
  });
  it("lämnar skärmbildsbelägg till modellen", () => {
    expect(kontrolleraMedKod(underlag, belagg("skarmbild", "texten är liten i mobil"), [])).toBeNull();
  });
});

describe("verifieraFynd utan modell", () => {
  it("bekräftar aldrig bedömningsfynd utan modellkontroll", async () => {
    const d = testDb();
    const r = await verifieraFynd(d, 1, underlag, fynd("A", "citat", "Välkommen"), [], false);
    expect(r.verifierad).toBe(false);
  });
  it("bekräftar tekniska fynd med kod", async () => {
    const d = testDb();
    const r = await verifieraFynd(d, 1, underlag, fynd("D", "saknat_element", 'meta[name="description"]'), [], false);
    expect(r.verifierad).toBe(true);
    expect(r.metod).toBe("kod");
  });
  it("skickar fynd om vad texten säger till modellen även när citatet finns", async () => {
    const d = testDb();
    const r = await verifieraFynd(d, 1, underlag, fynd("G", "citat", "Välkommen"), [], false);
    expect(r.verifierad).toBe(false);
    expect(r.metod).toBe("ingen");
  });
  it("underkänner ett citat som inte finns innan modellen behövs", async () => {
    const d = testDb();
    const r = await verifieraFynd(d, 1, underlag, fynd("A", "citat", "finns inte alls på sidan"), [], false);
    expect(r.verifierad).toBe(false);
    expect(r.metod).toBe("kod");
  });
});
