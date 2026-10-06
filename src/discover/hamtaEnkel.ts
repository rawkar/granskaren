import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { USER_AGENT } from "../config.js";
import { internaLankar } from "../crawl/sidurval.js";
import { farHamtas, tolkaRobots } from "../crawl/robots.js";
import { hittaAdresser } from "../email/kontakter.js";
import { normaliseraDoman } from "../util/domain.js";
import { paus } from "../util/logg.js";

/**
 * Lätt hämtning för urval och förfiltrering: startsida plus om- och kontaktsida,
 * med fetch i första hand och Playwright bara när sidan kräver JavaScript.
 */
export interface EnkelSida {
  url: string;
  roll: string;
  status: number | null;
  html: string;
  text: string;
  titel: string | null;
}

export interface EnkelSajt {
  doman: string;
  svarar: boolean;
  fel: string | null;
  sidor: EnkelSida[];
  text: string; // all text ihop, kortad
  adresser: string[];
  externaDomaner: string[];
  plattformTecken: string | null;
}

const ROLLER: { roll: string; re: RegExp }[] = [
  { roll: "om", re: /om[- ]?(oss|mig|foretaget|företaget|foreningen|föreningen)|about/i },
  { roll: "kontakt", re: /kontakt|contact/i },
  { roll: "tjanst", re: /tjanster|tjänster|services|erbjudande|vad-vi-gor/i },
];

const SOCIALA = /(facebook|instagram|linkedin|youtube|tiktok|twitter|x|threads|pinterest|vimeo|spotify|apple|google|wikipedia|wordpress|wix|squarespace|webflow|shopify|mailchimp|cookiebot|onetrust|gstatic|googleapis|cloudflare|github|behance|dribbble|bokadirekt|tripadvisor|hitta|eniro|allabolag|ratsit|bolagsverket|skatteverket|microsoft|apple|adobe|canva|zoom|teams|calendly|hubspot|trustpilot|reco)\./i;

export async function hamtaEnkel(doman: string, maxSidor = 3, pausMs = 1500): Promise<EnkelSajt> {
  const ut: EnkelSajt = { doman, svarar: false, fel: null, sidor: [], text: "", adresser: [], externaDomaner: [], plattformTecken: null };
  const robotsSvar = await hamtaRa(`https://${doman}/robots.txt`);
  const robots = tolkaRobots(robotsSvar && robotsSvar.status === 200 && !/<html/i.test(robotsSvar.text.slice(0, 300)) ? robotsSvar.text : null);
  const startUrl = `https://${doman}/`;
  if (!farHamtas(robots, startUrl)) {
    ut.fel = "robots.txt tillåter inte hämtning";
    return ut;
  }
  const start = await hamtaSida(startUrl, "start");
  if (!start || start.status === null || start.status >= 400 || !start.html) {
    ut.fel = start?.status ? `status ${start.status}` : "svarar inte";
    return ut;
  }
  ut.svarar = true;
  ut.sidor.push(start);

  const lankar = internaLankar(start.html, start.url);
  for (const r of ROLLER) {
    if (ut.sidor.length >= maxSidor) break;
    const traff = lankar.find((l) => (l.text.length <= 40 && r.re.test(l.text)) || r.re.test(new URL(l.url).pathname));
    if (!traff || ut.sidor.some((s) => s.url === traff.url) || !farHamtas(robots, traff.url)) continue;
    await paus(pausMs);
    const s = await hamtaSida(traff.url, r.roll);
    if (s && s.html) ut.sidor.push(s);
  }

  const alltHtml = ut.sidor.map((s) => s.html).join("\n");
  const alltText = ut.sidor.map((s) => `[${s.roll}] ${s.text}`).join("\n\n");
  ut.text = alltText.length > 9000 ? `${alltText.slice(0, 9000)} [...]` : alltText;
  ut.adresser = [...new Set(ut.sidor.flatMap((s) => hittaAdresser(s.html, s.text)))];

  const externa = new Set<string>();
  const $ = cheerio.load(alltHtml);
  $("a[href^='http']").each((_, el) => {
    const d = normaliseraDoman($(el).attr("href") ?? "");
    if (d && d !== doman && !d.endsWith(`.${doman}`) && !SOCIALA.test(`${d}.`)) externa.add(d);
  });
  ut.externaDomaner = [...externa];
  ut.plattformTecken = /wp-content/.test(alltHtml) ? "WordPress" : /wixstatic/.test(alltHtml) ? "Wix" : /squarespace/.test(alltHtml) ? "Squarespace" : null;
  return ut;
}

async function hamtaRa(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    return { status: r.status, text: await r.text() };
  } catch {
    return null;
  }
}

async function hamtaSida(url: string, roll: string): Promise<EnkelSida | null> {
  const ra = await hamtaRa(url);
  if (!ra) return null;
  let html = ra.text;
  let text = textUr(html);
  // Sidor som bygger allt med JavaScript ger nästan ingen text, då renderas de
  if (ra.status < 400 && text.split(/\s+/).length < 60 && /<script/i.test(html)) {
    const renderad = await rendera(url);
    if (renderad) {
      html = renderad.html;
      text = renderad.text;
    }
  }
  const $ = cheerio.load(html);
  return { url, roll, status: ra.status, html, text, titel: $("title").first().text().trim() || null };
}

function textUr(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, template").remove();
  return $("body").text().replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

async function rendera(url: string): Promise<{ html: string; text: string } | null> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT, viewport: { width: 1366, height: 900 } });
    await page.goto(url, { waitUntil: "load", timeout: 25000 });
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => undefined);
    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return { html, text: text.replace(/\n\s*\n+/g, "\n").trim() };
  } catch {
    return null;
  } finally {
    await browser.close();
  }
}
