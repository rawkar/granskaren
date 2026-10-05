/**
 * Minimal tolk för robots.txt enligt RFC 9309. Vi letar efter regler för vår egen
 * user agent ("granskaren") och faller tillbaka på "*".
 */
export interface RobotsRegler {
  finns: boolean;
  allow: string[];
  disallow: string[];
  crawlDelayMs: number | null;
  sitemaps: string[];
  ratext: string;
}

export function tolkaRobots(text: string | null, agentNamn = "granskaren"): RobotsRegler {
  const regler: RobotsRegler = { finns: text !== null, allow: [], disallow: [], crawlDelayMs: null, sitemaps: [] , ratext: text ?? "" };
  if (!text) return regler;

  type Grupp = { agenter: string[]; allow: string[]; disallow: string[]; delay: number | null };
  const grupper: Grupp[] = [];
  let aktuell: Grupp | null = null;
  let senasteVarAgent = false;

  for (const raRad of text.split(/\r?\n/)) {
    const rad = raRad.replace(/#.*$/, "").trim();
    if (!rad) continue;
    const idx = rad.indexOf(":");
    if (idx < 0) continue;
    const nyckel = rad.slice(0, idx).trim().toLowerCase();
    const varde = rad.slice(idx + 1).trim();

    if (nyckel === "sitemap") {
      if (varde) regler.sitemaps.push(varde);
      continue;
    }
    if (nyckel === "user-agent") {
      if (!aktuell || !senasteVarAgent) {
        aktuell = { agenter: [], allow: [], disallow: [], delay: null };
        grupper.push(aktuell);
      }
      aktuell.agenter.push(varde.toLowerCase());
      senasteVarAgent = true;
      continue;
    }
    senasteVarAgent = false;
    if (!aktuell) continue;
    if (nyckel === "allow") aktuell.allow.push(varde);
    else if (nyckel === "disallow") aktuell.disallow.push(varde);
    else if (nyckel === "crawl-delay") {
      const n = Number.parseFloat(varde);
      if (Number.isFinite(n)) aktuell.delay = Math.round(n * 1000);
    }
  }

  const egen = grupper.find((g) => g.agenter.some((a) => a !== "*" && agentNamn.toLowerCase().includes(a)));
  const alla = grupper.find((g) => g.agenter.includes("*"));
  const vald = egen ?? alla;
  if (vald) {
    regler.allow = vald.allow;
    regler.disallow = vald.disallow;
    regler.crawlDelayMs = vald.delay;
  }
  return regler;
}

/** Omvandlar ett robots-mönster (med * och $) till ett reguljärt uttryck. */
function monsterTillRegex(monster: string): RegExp {
  let m = monster.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const slut = m.endsWith("\\$");
  if (slut) m = m.slice(0, -2) + "$";
  return new RegExp(`^${m}`);
}

/** Avgör om en sökväg får hämtas. Längsta matchande regel vinner, allow vinner vid lika längd. */
export function farHamtas(regler: RobotsRegler, url: string): boolean {
  if (!regler.finns) return true;
  let sokvag: string;
  try {
    const u = new URL(url);
    sokvag = u.pathname + u.search;
  } catch {
    return false;
  }
  let bastaLangd = -1;
  let tillaten = true;
  for (const a of regler.allow) {
    if (a && monsterTillRegex(a).test(sokvag) && a.length > bastaLangd) {
      bastaLangd = a.length;
      tillaten = true;
    }
  }
  for (const dis of regler.disallow) {
    if (!dis) continue;
    if (monsterTillRegex(dis).test(sokvag) && dis.length > bastaLangd) {
      bastaLangd = dis.length;
      tillaten = false;
    } else if (monsterTillRegex(dis).test(sokvag) && dis.length === bastaLangd) {
      // allow vinner vid lika längd
    }
  }
  return tillaten;
}
