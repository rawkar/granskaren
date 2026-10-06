import * as cheerio from "cheerio";
import { normaliseraDoman } from "../util/domain.js";

export type SidRoll = "start" | "kontakt" | "om" | "handling" | "tjanst" | "case" | "nyhet" | "meny" | "sitemap";

export interface Kandidat {
  url: string;
  roll: SidRoll;
  ankartext: string;
}

const MONSTER: { roll: SidRoll; ord: RegExp }[] = [
  { roll: "kontakt", ord: /kontakt|contact|kontakta|hitta hit|n[aå] oss/i },
  { roll: "om", ord: /om[- ]?oss|om f[oö]reningen|om f[oö]retaget|om stiftelsen|om klubben|about|vilka [aä]r vi|v[aå]r historia|om [a-zåäö]+$/i },
  {
    roll: "handling",
    ord: /bli[- ]?medlem|medlemskap|medlem|boka|bokning|st[oö]d oss|st[oö]tta|skänk|sk[aä]nk|ge en g[aå]va|g[aå]va|donera|bidra|priser|prislista|anm[aä]l|anm[aä]lan|offert|k[oö]p|webshop|butik|boka tid|volont[aä]r|engagera dig|bli sponsor|sponsor/i,
  },
  { roll: "tjanst", ord: /tj[aä]nster|tjanster|v[aå]ra tj[aä]nster|services|erbjudande|vad vi g[oö]r|det h[aä]r g[oö]r vi|s[aå] arbetar vi|verksamhet/i },
  { roll: "case", ord: /\bcase\b|kundcase|referens|referenser|projekt|uppdrag|portfolio|portf[oö]lj|v[aå]rt arbete|arbeten|kunder|work/i },
  { roll: "nyhet", ord: /nyhet|aktuellt|blogg|blog|press|nytt|senaste|kalender|evenemang|event|p[aå] g[aå]ng/i },
];

/** Tar fram absoluta, interna länkar från en sida. */
export function internaLankar(html: string, basUrl: string): { url: string; text: string; iMeny: boolean }[] {
  const $ = cheerio.load(html);
  const basDoman = normaliseraDoman(basUrl);
  const resultat: { url: string; text: string; iMeny: boolean }[] = [];
  const sedda = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|sms):/i.test(href)) return;
    let abs: URL;
    try {
      abs = new URL(href, basUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(abs.protocol)) return;
    if (normaliseraDoman(abs.href) !== basDoman) return;
    abs.hash = "";
    const url = abs.href;
    if (sedda.has(url)) return;
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|mp3)(\?|$)/i.test(abs.pathname)) return;
    if (/\/(wp-admin|wp-login|wp-json|feed|xmlrpc|cart|varukorg|logga-in|login|logout)\b/i.test(abs.pathname)) return;
    sedda.add(url);
    const text = $(el).text().replace(/\s+/g, " ").trim() || ($(el).attr("aria-label") ?? "").trim();
    const iMeny = $(el).closest("nav, header, [role=navigation], .menu, .nav, .navbar, #menu, #nav").length > 0;
    resultat.push({ url, text, iMeny });
  });
  return resultat;
}

/**
 * Väljer ut vilka sidor som ska hämtas utifrån startsidans länkar:
 * kontakt, om oss, viktigaste handlingssida, senaste nyhet och upp till tre menysidor.
 */
export function valjSidor(html: string, startUrl: string, max = 8): Kandidat[] {
  const lankar = internaLankar(html, startUrl);
  const start = new URL(startUrl);
  const valda: Kandidat[] = [];
  const anvanda = new Set<string>([normaliseraUrl(startUrl)]);

  const poang = (l: { url: string; text: string; iMeny: boolean }, re: RegExp): number => {
    let p = 0;
    const sokvag = decodeURIComponent(new URL(l.url).pathname).toLowerCase();
    const sistaDel = sokvag.split("/").filter(Boolean).pop() ?? "";
    // Länktexten räknas bara om den är kort (en menyrubrik), inte en hel ingress som råkar innehålla ordet
    if (l.text.length <= 40 && re.test(l.text)) p += 2;
    if (re.test(sistaDel)) p += 2;
    else if (re.test(sokvag)) p += 1;
    if (p === 0) return 0; // ingen träff på nyckelord, då är sidan inte aktuell för rollen
    if (l.iMeny) p += 0.5;
    // kortare sökväg = troligare huvudsida
    p -= sokvag.split("/").filter(Boolean).length * 0.3;
    return p;
  };

  // Tjänstesida och case prioriteras före nyheter och menysidor
  for (const roll of ["kontakt", "om", "handling", "tjanst", "case", "nyhet"] as const) {
    const re = MONSTER.find((m) => m.roll === roll)!.ord;
    const basta = lankar
      .filter((l) => !anvanda.has(normaliseraUrl(l.url)))
      .map((l) => ({ l, p: poang(l, re) }))
      .filter((x) => x.p > 0)
      .sort((a, b) => b.p - a.p)[0];
    if (basta) {
      valda.push({ url: basta.l.url, roll, ankartext: basta.l.text });
      anvanda.add(normaliseraUrl(basta.l.url));
    }
  }

  // Upp till tre sidor från huvudmenyn som inte redan är valda
  const meny = lankar.filter((l) => l.iMeny && !anvanda.has(normaliseraUrl(l.url)) && l.url !== start.href);
  for (const l of meny) {
    if (valda.length >= max - 1) break;
    if (valda.filter((v) => v.roll === "meny").length >= 3) break;
    valda.push({ url: l.url, roll: "meny", ankartext: l.text });
    anvanda.add(normaliseraUrl(l.url));
  }

  return valda.slice(0, max - 1);
}

export function normaliseraUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    let s = u.href;
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return url;
  }
}
