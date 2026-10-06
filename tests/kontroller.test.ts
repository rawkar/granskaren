import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { kontrolleraSida, kontrolleraSajt } from "../src/measure/kontroller.js";
import { valjSidor, internaLankar } from "../src/crawl/sidurval.js";
import { farHamtas, tolkaRobots } from "../src/crawl/robots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const las = (f: string) => fs.readFileSync(path.join(here, "fixtures", f), "utf8");
const text = (html: string) => cheerio.load(html)("body").text().replace(/\s+/g, " ").trim();

describe("egna kontroller på sida med brister", () => {
  const html = las("brister.html");
  const k = kontrolleraSida(html, "http://exempelforeningen.se/", text(html));

  it("hittar saknad metabeskrivning, flera h1 och hoppande rubriknivåer", () => {
    expect(k.metabeskrivning_saknas).toBe(true);
    expect(k.h1_antal).toBe(2);
    expect(k.rubrikordning_hoppar).toBe(true);
  });
  it("räknar bilder utan alt", () => {
    expect(k.bilder_antal).toBe(3);
    expect(k.bilder_utan_alt).toBe(2);
  });
  it("saknar kanonisk adress, open graph, strukturerad data, lang och viewport", () => {
    expect(k.kanonisk_saknas).toBe(true);
    expect(k.og_saknas).toBe(true);
    expect(k.strukturerad_data_saknas).toBe(true);
    expect(k.lang_saknas).toBe(true);
    expect(k.viewport_saknas).toBe(true);
  });
  it("hittar Google Analytics utan samtyckesverktyg", () => {
    expect(k.analysverktyg).toContain("Google Analytics");
    expect(k.samtyckesverktyg).toBeNull();
  });
  it("hittar formulärfält utan etikett", () => {
    expect(k.formularfalt_antal).toBe(3);
    expect(k.formularfalt_utan_etikett).toBe(2);
  });
  it("hittar mejladress, organisationsnummer, årtal och otydliga länktexter", () => {
    expect(k.mailto_adresser).toEqual(["info@exempelforeningen.se"]);
    expect(k.organisationsnummer).toBe("802400-1234");
    expect(k.arstal_i_sidfot).toBe(2019);
    expect(k.otydliga_lanktexter).toBe(2);
    expect(k.senaste_datum).toBe("2021-03-12");
    expect(k.platshallartext).toBe(true);
    expect(k.https).toBe(false);
  });
});

describe("egna kontroller på välskött sida", () => {
  const html = las("valskott.html");
  const k = kontrolleraSida(html, "https://exempelforeningen.se/", text(html));

  it("hittar inga brister i grunderna", () => {
    expect(k.metabeskrivning_saknas).toBe(false);
    expect(k.titel_langd).toBeGreaterThan(20);
    expect(k.h1_antal).toBe(1);
    expect(k.bilder_utan_alt).toBe(0);
    expect(k.kanonisk).toBe("https://exempelforeningen.se/");
    expect(k.og_saknas).toBe(false);
    expect(k.strukturerad_data_typer).toEqual(["SportsOrganization"]);
    expect(k.lang).toBe("sv");
    expect(k.viewport_saknas).toBe(false);
    expect(k.formularfalt_utan_etikett).toBe(0);
    expect(k.analysverktyg).toEqual(["Matomo"]);
    expect(k.samtyckesverktyg).toBe("Cookiebot");
    expect(k.integritetspolicy_lank).toBe(true);
    expect(k.nyhetsbrev).toBe(true);
    expect(k.sociala_lankar[0]).toContain("instagram.com");
    expect(k.senaste_datum).toBe("2026-02-03");
    expect(k.otydliga_lanktexter).toBe(0);
  });
});

describe("sajtkontroll", () => {
  it("summerar dubbletter och döda länkar", () => {
    const html = las("brister.html");
    const k = kontrolleraSida(html, "https://exempelforeningen.se/", text(html));
    const s = kontrolleraSajt(
      [
        { url: "https://exempelforeningen.se/", roll: "start", kontroll: k, sparningsAnrop: ["www.google-analytics.com/g/collect"] },
        { url: "https://exempelforeningen.se/kontakt", roll: "kontakt", kontroll: { ...k, titel: "Startsida" }, sparningsAnrop: [] },
      ],
      {
        sitemapUrl: null,
        robotsFinns: false,
        https: { ok: true, fel: null },
        lankar: [
          { url: "https://exempelforeningen.se/verksamhet", status: 404, fran: "https://exempelforeningen.se/" },
          { url: "https://exempelforeningen.se/nyheter", status: 200, fran: "https://exempelforeningen.se/" },
        ],
        antalKontrolleradeLankar: 2,
      },
    );
    expect(s.titlar_dubbletter).toEqual(["Startsida"]);
    expect(s.sidor_utan_metabeskrivning).toHaveLength(2);
    expect(s.doda_lankar).toHaveLength(1);
    expect(s.sparning_fore_samtycke).toEqual(["www.google-analytics.com/g/collect"]);
    expect(s.kontakt_klick_fran_start).toBe(1);
    expect(s.handling_klick_fran_start).toBeNull();
  });
});

describe("sidurval", () => {
  const html = las("brister.html");
  it("hittar interna länkar och hoppar över filer", () => {
    const l = internaLankar(html, "https://exempelforeningen.se/");
    expect(l.map((x) => x.url)).not.toContain("https://exempelforeningen.se/dokument.pdf");
    expect(l.find((x) => x.url === "https://exempelforeningen.se/kontakt")?.iMeny).toBe(true);
  });
  it("väljer kontakt, om, handling, nyhet och menysidor inom max", () => {
    const v = valjSidor(html, "https://exempelforeningen.se/", 8);
    const roller = v.map((x) => x.roll);
    expect(roller.slice(0, 4)).toEqual(["kontakt", "om", "handling", "tjanst"]);
    expect(roller).toContain("nyhet");
    expect(v.find((x) => x.roll === "tjanst")?.url).toBe("https://exempelforeningen.se/verksamhet");
    expect(v.find((x) => x.roll === "handling")?.url).toBe("https://exempelforeningen.se/bli-medlem");
    expect(v.length).toBeLessThanOrEqual(7);
    expect(new Set(v.map((x) => x.url)).size).toBe(v.length);
  });
});

describe("robots.txt", () => {
  it("följer regler för * och egen agent", () => {
    const r = tolkaRobots("User-agent: *\nDisallow: /privat/\nAllow: /privat/oppen\nCrawl-delay: 5\nSitemap: https://x.se/sitemap.xml\n");
    expect(farHamtas(r, "https://x.se/")).toBe(true);
    expect(farHamtas(r, "https://x.se/privat/sida")).toBe(false);
    expect(farHamtas(r, "https://x.se/privat/oppen")).toBe(true);
    expect(r.crawlDelayMs).toBe(5000);
    expect(r.sitemaps).toEqual(["https://x.se/sitemap.xml"]);
  });
  it("prioriterar regler för granskaren", () => {
    const r = tolkaRobots("User-agent: *\nDisallow:\n\nUser-agent: granskaren\nDisallow: /\n");
    expect(farHamtas(r, "https://x.se/")).toBe(false);
  });
  it("tillåter allt när robots.txt saknas", () => {
    expect(farHamtas(tolkaRobots(null), "https://x.se/vad-som-helst")).toBe(true);
  });
});
