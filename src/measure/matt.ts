import * as cheerio from "cheerio";
import { internaLankar } from "../crawl/sidurval.js";

/**
 * Kodmått som inte kostar något modellanrop. Siffror i mejl ska komma härifrån,
 * aldrig från modellens egen räkning.
 */
export interface SidMatt {
  url: string;
  vi_ord: number;
  ni_ord: number;
  vi_andel: number | null; // andel vi-ord av vi+ni, 0 till 1
  lix: number | null;
  formular: { antal_falt: number; har_sandknapp: boolean; action: string | null }[];
  formularfalt_max: number;
  rubriker_etiketter: number; // rubriker som bara är etiketter (Välkommen, Tjänster, Om oss)
  rubriker_antal: number;
}

export interface SajtMatt {
  plattform: string | null;
  tema: string | null;
  tillagg: string[];
  generator: string | null;
  case_antal: number;
  case_urls: string[];
  tjanstesidor_antal: number;
}

const VI = /\b(vi|oss|vår|vårt|våra|vårat)\b/gi;
const NI = /\b(ni|er|era|ert|du|dig|din|ditt|dina)\b/gi;
const ETIKETT = /^(välkommen|välkommen till [a-zåäö ]+|hem|start|om oss|om [a-zåäö]+|tjänster|våra tjänster|kontakt|kontakta oss|nyheter|aktuellt|produkter|galleri|referenser|case|kundcase|länkar|info|information)$/i;

export function mattForSida(html: string, url: string, text: string): SidMatt {
  const $ = cheerio.load(html);
  const brod = text;
  const viOrd = (brod.match(VI) ?? []).length;
  const niOrd = (brod.match(NI) ?? []).length;

  const formular = $("form")
    .toArray()
    .map((f) => {
      const falt = $(f)
        .find("input, select, textarea")
        .toArray()
        .filter((el) => !["hidden", "submit", "button", "reset", "image"].includes(($(el).attr("type") ?? "text").toLowerCase()));
      const action = $(f).attr("action") ?? null;
      const sandknapp = $(f).find('button, input[type="submit"]').length > 0;
      return { antal_falt: falt.length, har_sandknapp: sandknapp, action };
    })
    .filter((f) => f.antal_falt > 0 && !/\/(sok|search)\b|[?&]s=/.test(f.action ?? ""));

  const rubriker = $("h1, h2").toArray().map((el) => $(el).text().replace(/\s+/g, " ").trim());

  return {
    url,
    vi_ord: viOrd,
    ni_ord: niOrd,
    vi_andel: viOrd + niOrd > 0 ? Math.round((viOrd / (viOrd + niOrd)) * 100) / 100 : null,
    lix: lix(brod),
    formular,
    formularfalt_max: formular.length ? Math.max(...formular.map((f) => f.antal_falt)) : 0,
    rubriker_etiketter: rubriker.filter((r) => ETIKETT.test(r)).length,
    rubriker_antal: rubriker.length,
  };
}

/** Läsbarhetsindex LIX: ord per mening plus andel långa ord (över sex bokstäver). */
export function lix(text: string): number | null {
  const ord = text.split(/\s+/).filter((w) => /[a-zåäö]/i.test(w));
  if (ord.length < 50) return null;
  const meningar = text.split(/[.!?]+(\s|$)/).filter((m) => m.trim().split(/\s+/).length >= 2).length || 1;
  const langa = ord.filter((w) => w.replace(/[^a-zåäö]/gi, "").length > 6).length;
  return Math.round(ord.length / meningar + (langa * 100) / ord.length);
}

const PLATTFORMAR: { namn: string; re: RegExp }[] = [
  { namn: "WordPress", re: /wp-content\/|wp-includes\/|<meta name="generator" content="WordPress/i },
  { namn: "Wix", re: /static\.wixstatic\.com|wix\.com\/|X-Wix-/i },
  { namn: "Squarespace", re: /squarespace\.com|static1\.squarespace/i },
  { namn: "Webflow", re: /webflow\.com|data-wf-site/i },
  { namn: "Shopify", re: /cdn\.shopify\.com|Shopify\.theme/i },
  { namn: "HubSpot", re: /hs-sites\.com|hubspot\.com\/hub/i },
  { namn: "Joomla", re: /<meta name="generator" content="Joomla/i },
  { namn: "Drupal", re: /<meta name="generator" content="Drupal|\/sites\/default\/files\//i },
  { namn: "SiteVision", re: /sitevision/i },
  { namn: "Episerver/Optimizely", re: /episerver|optimizely/i },
  { namn: "Umbraco", re: /umbraco/i },
  { namn: "Weebly", re: /weebly\.com/i },
  { namn: "Jimdo", re: /jimdo\.com/i },
  { namn: "one.com Website Builder", re: /onewebstatic|one\.com/i },
  { namn: "Framer", re: /framerusercontent\.com/i },
  { namn: "Ghost", re: /<meta name="generator" content="Ghost/i },
  { namn: "Next.js", re: /_next\/static/i },
  { namn: "Nuxt", re: /_nuxt\//i },
  { namn: "Hugo", re: /<meta name="generator" content="Hugo/i },
  { namn: "Gatsby", re: /gatsby-/i },
  { namn: "Laget.se", re: /laget\.se/i },
  { namn: "Svenskalag.se", re: /svenskalag\.se/i },
  { namn: "IdrottOnline", re: /idrottonline\.se/i },
];

const CASE_RE = /\/(case|cases|kundcase|referens|referenser|projekt|uppdrag|portfolio|portfolj|vart-arbete|vaart-arbete|arbeten|kunder|work)(\/|$)/i;
const TJANST_RE = /\/(tjanster|tjaenster|tjanst|services|erbjudande|vad-vi-gor|det-har-gor-vi)(\/|$)/i;

export function mattForSajt(
  sidor: { url: string; html: string }[],
  sitemapXml: string | null,
): SajtMatt {
  const start = sidor[0];
  const html = start?.html ?? "";
  const $ = cheerio.load(html);
  const generator = $('meta[name="generator"]').attr("content") ?? null;
  const plattform = PLATTFORMAR.find((p) => p.re.test(html))?.namn ?? (generator ? generator.split(" ")[0] : null);
  const tema = html.match(/\/wp-content\/themes\/([a-z0-9_-]+)\//i)?.[1] ?? null;
  const tillagg = [...new Set([...html.matchAll(/\/wp-content\/plugins\/([a-z0-9_-]+)\//gi)].map((m) => m[1]))].slice(0, 12);

  // Case räknas som unika interna adresser som ser ut som case, från länkar och sitemap
  const kandidater = new Set<string>();
  for (const s of sidor) {
    for (const l of internaLankar(s.html, s.url)) {
      const p = new URL(l.url).pathname;
      if (CASE_RE.test(p) && p.split("/").filter(Boolean).length >= 2) kandidater.add(l.url.replace(/\/$/, ""));
    }
  }
  const tjanster = new Set<string>();
  for (const s of sidor) {
    for (const l of internaLankar(s.html, s.url)) {
      const p = new URL(l.url).pathname;
      if (TJANST_RE.test(p) && p.split("/").filter(Boolean).length >= 2) tjanster.add(l.url.replace(/\/$/, ""));
    }
  }
  if (sitemapXml) {
    for (const m of sitemapXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      try {
        const p = new URL(m[1]).pathname;
        if (CASE_RE.test(p) && p.split("/").filter(Boolean).length >= 2) kandidater.add(m[1].replace(/\/$/, ""));
        if (TJANST_RE.test(p) && p.split("/").filter(Boolean).length >= 2) tjanster.add(m[1].replace(/\/$/, ""));
      } catch {
        // hoppa
      }
    }
  }
  return {
    plattform,
    tema,
    tillagg,
    generator,
    case_antal: kandidater.size,
    case_urls: [...kandidater].slice(0, 15),
    tjanstesidor_antal: tjanster.size,
  };
}
