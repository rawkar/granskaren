import * as cheerio from "cheerio";

/**
 * Egna kontroller på en renderad sida. Allt här är rena fakta som går att
 * kontrollera för hand i sidans HTML eller text. Nycklarna används som belägg
 * i fynd (belagg.typ = matvarde, varde = "nyckel=värde").
 */
export interface SidKontroll {
  url: string;
  https: boolean;

  titel: string | null;
  titel_langd: number;
  titel_saknas: boolean;
  metabeskrivning: string | null;
  metabeskrivning_langd: number;
  metabeskrivning_saknas: boolean;

  h1_antal: number;
  h1_text: string[];
  rubriker: string[];
  rubrikordning_hoppar: boolean;
  mellanrubriker_antal: number;

  bilder_antal: number;
  bilder_utan_alt: number;
  bilder_utan_alt_exempel: string[];

  kanonisk: string | null;
  kanonisk_saknas: boolean;
  robots_meta: string | null;
  noindex: boolean;

  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  og_saknas: boolean;

  strukturerad_data_typer: string[];
  strukturerad_data_saknas: boolean;

  lang: string | null;
  lang_saknas: boolean;
  viewport_saknas: boolean;

  formular_antal: number;
  formularfalt_antal: number;
  formularfalt_utan_etikett: number;

  analysverktyg: string[];
  analysverktyg_saknas: boolean;
  samtyckesverktyg: string | null;

  mailto_adresser: string[];
  telefonnummer: string[];
  organisationsnummer: string | null;
  sociala_lankar: string[];
  integritetspolicy_lank: boolean;
  nyhetsbrev: boolean;
  sokfunktion: boolean;

  menyval_antal: number;
  menyord: string[];

  ordantal: number;
  stycken_antal: number;
  langsta_stycke_ord: number;
  otydliga_lanktexter: number;
  otydliga_lanktexter_exempel: string[];
  platshallartext: boolean;
  arstal_i_sidfot: number | null;
  datum_i_text: string[];
  senaste_datum: string | null;

  html_kb: number;
}

const ANALYS: { namn: string; re: RegExp }[] = [
  { namn: "Google Analytics", re: /google-analytics\.com\/analytics\.js|gtag\(|G-[A-Z0-9]{6,}|UA-\d{4,}-\d/ },
  { namn: "Google Tag Manager", re: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/ },
  { namn: "Matomo", re: /matomo\.js|piwik\.js|_paq\.push/ },
  { namn: "Plausible", re: /plausible\.io\/js/ },
  { namn: "Fathom", re: /cdn\.usefathom\.com/ },
  { namn: "Hotjar", re: /static\.hotjar\.com/ },
  { namn: "Microsoft Clarity", re: /clarity\.ms\/tag/ },
  { namn: "Meta-pixel", re: /connect\.facebook\.net\/[a-z_]+\/fbevents\.js|fbq\(/ },
];

const SAMTYCKE: { namn: string; re: RegExp }[] = [
  { namn: "Cookiebot", re: /cookiebot/i },
  { namn: "OneTrust", re: /onetrust|optanon/i },
  { namn: "CookieYes", re: /cookieyes|cky-/i },
  { namn: "Complianz", re: /complianz|cmplz/i },
  { namn: "Cookie Information", re: /cookieinformation/i },
  { namn: "Klaro", re: /klaro/i },
  { namn: "Osano", re: /osano/i },
  { namn: "Iubenda", re: /iubenda/i },
  { namn: "Cookie Notice", re: /cookie-notice|cookie_notice|cookieconsent|cookie-consent/i },
];

export function kontrolleraSida(html: string, url: string, text: string): SidKontroll {
  const $ = cheerio.load(html);
  const meta = (sel: string) => ($(sel).first().attr("content") ?? "").trim() || null;

  const titel = ($("title").first().text() ?? "").replace(/\s+/g, " ").trim() || null;
  const metabeskrivning = meta('meta[name="description"]');

  const rubrikEl = $("h1, h2, h3, h4, h5, h6").toArray();
  const rubriker = rubrikEl.map((el) => `${el.tagName.toLowerCase()}: ${$(el).text().replace(/\s+/g, " ").trim().slice(0, 80)}`);
  let forraNiva = 0;
  let hoppar = false;
  for (const el of rubrikEl) {
    const niva = Number.parseInt(el.tagName.slice(1), 10);
    if (forraNiva && niva > forraNiva + 1) hoppar = true;
    forraNiva = niva;
  }
  const h1 = $("h1").toArray().map((el) => $(el).text().replace(/\s+/g, " ").trim());

  const bilder = $("img").toArray();
  const utanAlt = bilder.filter((el) => {
    const alt = $(el).attr("alt");
    const role = $(el).attr("role");
    return alt === undefined && role !== "presentation";
  });

  const ld: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const samla = (o: unknown) => {
        if (Array.isArray(o)) o.forEach(samla);
        else if (o && typeof o === "object") {
          const t = (o as Record<string, unknown>)["@type"];
          if (typeof t === "string") ld.push(t);
          else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && ld.push(x));
          const g = (o as Record<string, unknown>)["@graph"];
          if (g) samla(g);
        }
      };
      samla(data);
    } catch {
      // ogiltig JSON-LD
    }
  });

  const formular = $("form").toArray();
  let faltAntal = 0;
  let utanEtikett = 0;
  $("form input, form select, form textarea").each((_, el) => {
    const typ = ($(el).attr("type") ?? "text").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(typ)) return;
    faltAntal++;
    const id = $(el).attr("id");
    const harLabel =
      (id && $(`label[for="${id}"]`).length > 0) ||
      $(el).closest("label").length > 0 ||
      !!$(el).attr("aria-label") ||
      !!$(el).attr("aria-labelledby") ||
      !!$(el).attr("title");
    if (!harLabel) utanEtikett++;
  });

  const analysverktyg = ANALYS.filter((a) => a.re.test(html)).map((a) => a.namn);
  const samtycke = SAMTYCKE.find((s) => s.re.test(html))?.namn ?? null;

  const mailto = new Set<string>();
  $('a[href^="mailto:"]').each((_, el) => {
    const adr = ($(el).attr("href") ?? "").replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
    if (adr.includes("@")) mailto.add(adr);
  });

  const telefon = new Set<string>();
  $('a[href^="tel:"]').each((_, el) => {
    telefon.add(($(el).attr("href") ?? "").replace(/^tel:/i, "").trim());
  });
  for (const m of text.matchAll(/(?:\+46|0)[\s-]?\d{1,3}[\s-]?\d{2,3}[\s-]?\d{2,3}[\s-]?\d{2,3}\b/g)) {
    if (telefon.size < 5) telefon.add(m[0].trim());
  }

  const orgnr = text.match(/\b(\d{6})[-\s]?(\d{4})\b/g)?.find((s) => /^(5|7|8|2|1|3|6|9)/.test(s)) ?? null;

  const sociala = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/https?:\/\/(?:www\.)?(facebook|instagram|linkedin|youtube|tiktok|x|twitter|threads)\.com\/[^\s"']*/i);
    if (m) sociala.add(m[0]);
  });

  const lanktexter = $("a[href]").toArray().map((el) => $(el).text().replace(/\s+/g, " ").trim().toLowerCase());
  const otydliga = lanktexter.filter((t) => /^(läs mer|las mer|klicka här|här|mer|här\.|read more|click here|länk|more)$/.test(t));

  const integritet = $("a[href]").toArray().some((el) => /integritet|personuppgift|privacy|gdpr|kakor|cookies/i.test($(el).text() + " " + ($(el).attr("href") ?? "")));
  const nyhetsbrev = /nyhetsbrev|newsletter|prenumerera/i.test(html);
  const sokfunktion = $('input[type="search"], form[role="search"], input[name="s"], input[name="q"], [class*="search"] input').length > 0;

  const menyLankar = $("nav a[href], header a[href], [role=navigation] a[href]").toArray();
  const menyord = [...new Set(menyLankar.map((el) => $(el).text().replace(/\s+/g, " ").trim()).filter((t) => t && t.length < 40))];

  const stycken = text.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 5);
  const styckeOrd = stycken.map((s) => s.split(/\s+/).length);
  const ordantal = text.split(/\s+/).filter(Boolean).length;

  const sidfot = $("footer").text() || text.slice(-600);
  const arstal = [...sidfot.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number.parseInt(m[0], 10));
  const arstalSidfot = arstal.length ? Math.max(...arstal) : null;

  const datumRe = /\b(\d{1,2})\s+(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\s+(20\d{2})\b|\b(20\d{2})-(\d{2})-(\d{2})\b|\b(\d{1,2})\/(\d{1,2})[\/-](20\d{2})\b/gi;
  const datum: string[] = [];
  for (const m of text.matchAll(datumRe)) {
    if (datum.length >= 20) break;
    datum.push(m[0]);
  }
  const iso = datum.map(tillIso).filter((x): x is string => !!x).sort();
  const senasteDatum = iso.length ? iso[iso.length - 1] : null;

  const platshallare = /lorem ipsum|platshållartext|under uppbyggnad|under construction|kommer snart|coming soon|hello world|exempelsida|sample page/i.test(text);

  return {
    url,
    https: url.startsWith("https://"),
    titel,
    titel_langd: titel?.length ?? 0,
    titel_saknas: !titel,
    metabeskrivning,
    metabeskrivning_langd: metabeskrivning?.length ?? 0,
    metabeskrivning_saknas: !metabeskrivning,
    h1_antal: h1.length,
    h1_text: h1,
    rubriker: rubriker.slice(0, 40),
    rubrikordning_hoppar: hoppar,
    mellanrubriker_antal: $("h2, h3").length,
    bilder_antal: bilder.length,
    bilder_utan_alt: utanAlt.length,
    bilder_utan_alt_exempel: utanAlt.slice(0, 5).map((el) => ($(el).attr("src") ?? "").slice(0, 120)),
    kanonisk: $('link[rel="canonical"]').first().attr("href") ?? null,
    kanonisk_saknas: $('link[rel="canonical"]').length === 0,
    robots_meta: meta('meta[name="robots"]'),
    noindex: /noindex/i.test(meta('meta[name="robots"]') ?? ""),
    og_title: meta('meta[property="og:title"]'),
    og_description: meta('meta[property="og:description"]'),
    og_image: meta('meta[property="og:image"]'),
    og_saknas: $('meta[property^="og:"]').length === 0,
    strukturerad_data_typer: [...new Set(ld)],
    strukturerad_data_saknas: ld.length === 0,
    lang: $("html").attr("lang") ?? null,
    lang_saknas: !$("html").attr("lang"),
    viewport_saknas: $('meta[name="viewport"]').length === 0,
    formular_antal: formular.length,
    formularfalt_antal: faltAntal,
    formularfalt_utan_etikett: utanEtikett,
    analysverktyg,
    analysverktyg_saknas: analysverktyg.length === 0,
    samtyckesverktyg: samtycke,
    mailto_adresser: [...mailto],
    telefonnummer: [...telefon].slice(0, 5),
    organisationsnummer: orgnr,
    sociala_lankar: [...sociala].slice(0, 10),
    integritetspolicy_lank: integritet,
    nyhetsbrev,
    sokfunktion,
    menyval_antal: menyord.length,
    menyord: menyord.slice(0, 25),
    ordantal,
    stycken_antal: stycken.length,
    langsta_stycke_ord: styckeOrd.length ? Math.max(...styckeOrd) : 0,
    otydliga_lanktexter: otydliga.length,
    otydliga_lanktexter_exempel: [...new Set(otydliga)].slice(0, 5),
    platshallartext: platshallare,
    arstal_i_sidfot: arstalSidfot,
    datum_i_text: datum.slice(0, 10),
    senaste_datum: senasteDatum,
    html_kb: Math.round(Buffer.byteLength(html, "utf8") / 1024),
  };
}

const MANADER: Record<string, string> = {
  januari: "01", februari: "02", mars: "03", april: "04", maj: "05", juni: "06",
  juli: "07", augusti: "08", september: "09", oktober: "10", november: "11", december: "12",
};

function tillIso(s: string): string | null {
  let m = s.match(/^(\d{1,2})\s+([a-zåäö]+)\s+(20\d{2})$/i);
  if (m) {
    const mon = MANADER[m[2].toLowerCase()];
    return mon ? `${m[3]}-${mon}-${m[1].padStart(2, "0")}` : null;
  }
  m = s.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})[\/-](20\d{2})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/** Sajtövergripande kontroller som bygger på flera sidor. */
export interface SajtKontroll {
  sitemap_finns: boolean;
  sitemap_url: string | null;
  robots_finns: boolean;
  https_ok: boolean;
  https_fel: string | null;
  titlar_dubbletter: string[];
  metabeskrivningar_dubbletter: string[];
  sidor_utan_metabeskrivning: string[];
  sidor_utan_h1: string[];
  sidor_med_flera_h1: string[];
  kontakt_klick_fran_start: number | null;
  handling_klick_fran_start: number | null;
  analysverktyg: string[];
  sparning_fore_samtycke: string[];
  samtyckesverktyg: string | null;
  doda_lankar: { url: string; status: number | null; fran: string }[];
  antal_kontrollerade_lankar: number;
}

export function kontrolleraSajt(
  sidor: { url: string; roll: string; kontroll: SidKontroll; sparningsAnrop: string[] }[],
  extra: {
    sitemapUrl: string | null;
    robotsFinns: boolean;
    https: { ok: boolean; fel: string | null };
    lankar: { url: string; status: number | null; fran: string }[];
    antalKontrolleradeLankar: number;
  },
): SajtKontroll {
  const grupp = (f: (k: SidKontroll) => string | null) => {
    const m = new Map<string, number>();
    for (const s of sidor) {
      const v = f(s.kontroll);
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()].filter(([, n]) => n > 1).map(([v]) => v);
  };
  const start = sidor.find((s) => s.roll === "start");
  const harRoll = (roll: string) => sidor.some((s) => s.roll === roll);
  return {
    sitemap_finns: !!extra.sitemapUrl,
    sitemap_url: extra.sitemapUrl,
    robots_finns: extra.robotsFinns,
    https_ok: extra.https.ok,
    https_fel: extra.https.fel,
    titlar_dubbletter: grupp((k) => k.titel),
    metabeskrivningar_dubbletter: grupp((k) => k.metabeskrivning),
    sidor_utan_metabeskrivning: sidor.filter((s) => s.kontroll.metabeskrivning_saknas).map((s) => s.url),
    sidor_utan_h1: sidor.filter((s) => s.kontroll.h1_antal === 0).map((s) => s.url),
    sidor_med_flera_h1: sidor.filter((s) => s.kontroll.h1_antal > 1).map((s) => s.url),
    kontakt_klick_fran_start: harRoll("kontakt") ? 1 : null,
    handling_klick_fran_start: harRoll("handling") ? 1 : null,
    analysverktyg: [...new Set(sidor.flatMap((s) => s.kontroll.analysverktyg))],
    sparning_fore_samtycke: [...new Set(sidor.flatMap((s) => s.sparningsAnrop))],
    samtyckesverktyg: start?.kontroll.samtyckesverktyg ?? sidor.find((s) => s.kontroll.samtyckesverktyg)?.kontroll.samtyckesverktyg ?? null,
    doda_lankar: extra.lankar.filter((l) => l.status === null || l.status >= 400),
    antal_kontrollerade_lankar: extra.antalKontrolleradeLankar,
  };
}
