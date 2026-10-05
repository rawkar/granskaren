import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { konfig, USER_AGENT } from "../config.js";
import { dataMapp, filnamnSaker } from "../util/fil.js";
import { logg, paus } from "../util/logg.js";
import { farHamtas, tolkaRobots, type RobotsRegler } from "./robots.js";
import { valjSidor, type SidRoll } from "./sidurval.js";

export interface HamtadSida {
  roll: SidRoll;
  url: string;
  slutligUrl: string;
  statuskod: number | null;
  html: string;
  text: string;
  titel: string | null;
  svarstidMs: number | null;
  laddtidMs: number | null;
  htmlSokvag: string;
  textSokvag: string;
  skarmbildDator: string | null;
  skarmbildMobil: string | null;
  /** Anrop till kända spårningstjänster som gick iväg innan någon interaktion (vi godkänner aldrig kakor). */
  sparningsAnrop: string[];
  antalAnrop: number;
  overfordaBytes: number;
  fel: string | null;
}

const SPARNINGS_VARDAR = [
  /google-analytics\.com/, /analytics\.google\.com/, /googletagmanager\.com\/gtag/, /\/g\/collect/, /doubleclick\.net/,
  /facebook\.com\/tr\b/, /connect\.facebook\.net/, /matomo\.php/, /piwik\.php/, /hotjar\.com/, /clarity\.ms/,
  /linkedin\.com\/px/, /snap\.licdn\.com/, /tiktok\.com\/i18n\/pixel/, /plausible\.io\/api\/event/, /stats\.g\.doubleclick/,
];

export interface HamtningsResultat {
  startUrl: string;
  slutligStartUrl: string;
  sidor: HamtadSida[];
  robots: RobotsRegler;
  robotsTxt: string | null;
  sitemapXml: string | null;
  sitemapUrl: string | null;
  https: { ok: boolean; fel: string | null };
  blockerad: boolean;
}

const DESKTOP = { width: 1366, height: 900 };
const MOBIL = { width: 390, height: 844 };
const MAX_SKARMBILD_HOJD = 6000;

export async function hamtaText(url: string, timeoutMs = 15000): Promise<{ status: number; text: string } | null> {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/plain,text/xml,application/xml,text/html;q=0.8,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    return { status: r.status, text };
  } catch {
    return null;
  }
}

/** Hämtar en hel sajt: startsida, nyckelsidor, robots.txt och sitemap.xml. */
export async function hamtaSajt(doman: string): Promise<HamtningsResultat> {
  const k = konfig();
  const mapp = dataMapp("sidor", filnamnSaker(doman));
  const startUrl = `https://${doman}/`;

  // robots.txt och sitemap
  const robotsSvar = await hamtaText(`https://${doman}/robots.txt`);
  const robotsTxt = robotsSvar && robotsSvar.status === 200 && !/<html/i.test(robotsSvar.text.slice(0, 500)) ? robotsSvar.text : null;
  const robots = tolkaRobots(robotsTxt);
  if (robotsTxt) fs.writeFileSync(path.join(mapp, "robots.txt"), robotsTxt, "utf8");

  let sitemapXml: string | null = null;
  let sitemapUrl: string | null = null;
  const sitemapKandidater = [...robots.sitemaps, `https://${doman}/sitemap.xml`, `https://${doman}/sitemap_index.xml`];
  for (const su of sitemapKandidater) {
    const s = await hamtaText(su);
    if (s && s.status === 200 && /<(urlset|sitemapindex)/i.test(s.text)) {
      sitemapXml = s.text;
      sitemapUrl = su;
      fs.writeFileSync(path.join(mapp, "sitemap.xml"), s.text, "utf8");
      break;
    }
  }

  const resultat: HamtningsResultat = {
    startUrl,
    slutligStartUrl: startUrl,
    sidor: [],
    robots,
    robotsTxt,
    sitemapXml,
    sitemapUrl,
    https: { ok: true, fel: null },
    blockerad: false,
  };

  if (!farHamtas(robots, startUrl)) {
    resultat.blockerad = true;
    return resultat;
  }

  const pausMs = Math.max(k.PAUS_MELLAN_SIDOR_MS, robots.crawlDelayMs ?? 0);
  const browser = await chromium.launch({ headless: true });
  try {
    const ctxDator = await browser.newContext({ userAgent: USER_AGENT, viewport: DESKTOP, locale: "sv-SE", ignoreHTTPSErrors: false });
    const ctxMobil = await browser.newContext({
      userAgent: USER_AGENT.replace("Mozilla/5.0 (", "Mozilla/5.0 (Linux; Android 13; Pixel 7) "),
      viewport: MOBIL,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      locale: "sv-SE",
    });

    // Startsidan, med fallback till http om https inte fungerar
    let start = await hamtaSida(ctxDator, ctxMobil, startUrl, "start", mapp);
    if (start.fel && /ERR_CERT|SSL|certificate/i.test(start.fel)) {
      resultat.https = { ok: false, fel: start.fel };
      const ctxOsaker = await browser.newContext({ userAgent: USER_AGENT, viewport: DESKTOP, locale: "sv-SE", ignoreHTTPSErrors: true });
      start = await hamtaSida(ctxOsaker, ctxMobil, startUrl, "start", mapp);
      await ctxOsaker.close();
    } else if (start.fel) {
      const http = await hamtaSida(ctxDator, ctxMobil, `http://${doman}/`, "start", mapp);
      if (!http.fel) {
        start = http;
        if (!/^https:/.test(http.slutligUrl)) resultat.https = { ok: false, fel: "Sajten svarar bara över http" };
      }
    }
    resultat.sidor.push(start);
    resultat.slutligStartUrl = start.slutligUrl || startUrl;
    if (start.fel || !start.html) {
      await ctxDator.close();
      await ctxMobil.close();
      return resultat;
    }

    const kandidater = valjSidor(start.html, resultat.slutligStartUrl, k.MAX_SIDOR_PER_SAJT);
    for (const kand of kandidater) {
      if (resultat.sidor.length >= k.MAX_SIDOR_PER_SAJT) break;
      if (!farHamtas(robots, kand.url)) {
        logg.info(`   robots.txt tillåter inte ${kand.url}, hoppar`);
        continue;
      }
      await paus(pausMs);
      const sida = await hamtaSida(ctxDator, ctxMobil, kand.url, kand.roll, mapp);
      resultat.sidor.push(sida);
    }

    await ctxDator.close();
    await ctxMobil.close();
  } finally {
    await browser.close();
  }
  return resultat;
}

async function hamtaSida(
  ctxDator: BrowserContext,
  ctxMobil: BrowserContext,
  url: string,
  roll: SidRoll,
  mapp: string,
): Promise<HamtadSida> {
  const bas = filnamnSaker(`${roll}_${new URL(url).pathname.replace(/\/$/, "") || "start"}`);
  const sida: HamtadSida = {
    roll,
    url,
    slutligUrl: url,
    statuskod: null,
    html: "",
    text: "",
    titel: null,
    svarstidMs: null,
    laddtidMs: null,
    htmlSokvag: path.join(mapp, `${bas}.html`),
    textSokvag: path.join(mapp, `${bas}.txt`),
    skarmbildDator: null,
    skarmbildMobil: null,
    sparningsAnrop: [],
    antalAnrop: 0,
    overfordaBytes: 0,
    fel: null,
  };

  const page = await ctxDator.newPage();
  const sparning = new Set<string>();
  page.on("request", (req) => {
    sida.antalAnrop++;
    const u = req.url();
    if (SPARNINGS_VARDAR.some((re) => re.test(u))) {
      try {
        sparning.add(new URL(u).hostname + new URL(u).pathname.slice(0, 40));
      } catch {
        // ignorera
      }
    }
  });
  page.on("response", (res) => {
    res
      .body()
      .then((b) => {
        sida.overfordaBytes += b.length;
      })
      .catch(() => undefined);
  });
  try {
    const t0 = Date.now();
    const svar = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    sida.svarstidMs = Date.now() - t0;
    sida.statuskod = svar?.status() ?? null;
    await page.waitForLoadState("load", { timeout: 20000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    sida.laddtidMs = Date.now() - t0;
    sida.sparningsAnrop = [...sparning];
    await stangCookieRuta(page);
    sida.slutligUrl = page.url();
    sida.titel = (await page.title()) || null;
    sida.html = await page.content();
    sida.text = await page.evaluate(() => {
      const klon = document.body?.cloneNode(true) as HTMLElement | null;
      if (!klon) return "";
      klon.querySelectorAll("script, style, noscript, svg, template").forEach((e) => e.remove());
      return (klon.innerText ?? klon.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    });
    fs.writeFileSync(sida.htmlSokvag, sida.html, "utf8");
    fs.writeFileSync(sida.textSokvag, sida.text, "utf8");

    sida.skarmbildDator = await skarmbild(page, path.join(mapp, `${bas}_dator.jpg`));
  } catch (e) {
    sida.fel = e instanceof Error ? e.message : String(e);
  } finally {
    await page.close();
  }

  if (!sida.fel) {
    const mobil = await ctxMobil.newPage();
    try {
      await mobil.goto(url, { waitUntil: "load", timeout: 30000 });
      await mobil.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      await stangCookieRuta(mobil);
      sida.skarmbildMobil = await skarmbild(mobil, path.join(mapp, `${bas}_mobil.jpg`), 3800);
    } catch {
      // mobilskärmbild är inte kritisk
    } finally {
      await mobil.close();
    }
  }
  return sida;
}

/**
 * Skärmbild av hela sidan, begränsad i höjd så att bilden kan skickas till modellen
 * (högst 8000 px per sida). Sparas som jpeg för att hålla storleken nere.
 */
async function skarmbild(page: Page, sokvag: string, maxHojd = MAX_SKARMBILD_HOJD): Promise<string | null> {
  try {
    const hojd = await page.evaluate(() => Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight));
    const vp = page.viewportSize() ?? DESKTOP;
    await page.screenshot({
      path: sokvag,
      type: "jpeg",
      quality: 80,
      clip: { x: 0, y: 0, width: vp.width, height: Math.max(vp.height, Math.min(hojd, maxHojd)) },
      fullPage: true,
      animations: "disabled",
      timeout: 20000,
    });
    return sokvag;
  } catch {
    try {
      await page.screenshot({ path: sokvag, type: "jpeg", quality: 80, timeout: 15000 });
      return sokvag;
    } catch {
      return null;
    }
  }
}

/** Försöker klicka bort en kakruta så att skärmbilderna visar själva sidan. Vi accepterar aldrig spårning. */
async function stangCookieRuta(page: Page): Promise<void> {
  const knappar = [
    "button:has-text('Avvisa')", "button:has-text('Neka')", "button:has-text('Endast nödvändiga')",
    "button:has-text('Bara nödvändiga')", "button:has-text('Nödvändiga')", "button:has-text('Avböj')",
    "button:has-text('Reject')", "button:has-text('Decline')", "button:has-text('Necessary only')",
    "#CybotCookiebotDialogBodyButtonDecline", ".cky-btn-reject", "#onetrust-reject-all-handler",
  ];
  for (const sel of knappar) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 300 })) {
        await el.click({ timeout: 1000 });
        await paus(500);
        return;
      }
    } catch {
      // nästa
    }
  }
}

export type { Browser };
