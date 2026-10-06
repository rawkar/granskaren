import type { HamtadSida } from "../crawl/hamta.js";
import type { AxeSammanfattning } from "../measure/axe.js";
import type { SajtKontroll, SidKontroll } from "../measure/kontroller.js";
import type { LighthouseSammanfattning } from "../measure/lighthouse.js";
import type { SajtMatt, SidMatt } from "../measure/matt.js";
import { normaliseraUrl } from "../crawl/sidurval.js";

/** Allt insamlat material för en sajt. Sparas som JSON och används av analys, verifiering och rapport. */
export interface SidUnderlag {
  roll: string;
  url: string;
  slutlig_url: string;
  statuskod: number | null;
  titel: string | null;
  laddtid_ms: number | null;
  text: string;
  kontroll: SidKontroll;
  matt: SidMatt | null;
  lighthouse: LighthouseSammanfattning | null;
  axe: AxeSammanfattning | null;
  skarmbild_dator: string | null;
  skarmbild_mobil: string | null;
  html_sokvag: string;
}

export interface Underlag {
  doman: string;
  namn: string | null;
  bransch: string | null;
  ort: string | null;
  granskad: string;
  sajt: SajtKontroll;
  matt: SajtMatt | null;
  sidor: SidUnderlag[];
}

/** Plattar ut mätvärden för en sida till nyckel=värde, så att fynd kan kontrolleras med kod. */
export function nycklarForSida(u: Underlag, sida: SidUnderlag): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sida.kontroll)) m[`kontroll.${k}`] = v;
  if (sida.matt) {
    for (const [k, v] of Object.entries(sida.matt)) m[`matt.${k}`] = v;
    sida.matt.formular.forEach((f, i) => {
      m[`matt.formular_${i + 1}_falt`] = f.antal_falt;
    });
  }
  if (sida.lighthouse) for (const [k, v] of Object.entries(sida.lighthouse)) m[`lighthouse.${k}`] = v;
  if (sida.axe) for (const [k, v] of Object.entries(sida.axe)) m[`axe.${k}`] = v;
  m["sida.statuskod"] = sida.statuskod;
  m["sida.laddtid_ms"] = sida.laddtid_ms;
  if (sida.roll === "start") {
    for (const [k, v] of Object.entries(u.sajt)) m[`sajt.${k}`] = v;
    if (u.matt) for (const [k, v] of Object.entries(u.matt)) m[`sajt.${k}`] = v;
  }
  return m;
}

export function hittaSida(u: Underlag, url: string): SidUnderlag | undefined {
  const n = normaliseraUrl(url);
  return u.sidor.find((s) => normaliseraUrl(s.url) === n || normaliseraUrl(s.slutlig_url) === n);
}

/**
 * Det modellen får se. Sidtext i stället för skärmbilder, kortad till det väsentliga,
 * och bara de mätvärden som behövs. Håller kostnaden per sajt nere.
 */
export function underlagForModell(u: Underlag): unknown {
  const viktiga = new Set(["start", "handling", "tjanst", "case", "om"]);
  return {
    doman: u.doman,
    namn: u.namn,
    bransch: u.bransch,
    ort: u.ort,
    sajt: {
      ...u.sajt,
      doda_lankar: u.sajt.doda_lankar.slice(0, 8),
      plattform: u.matt?.plattform ?? null,
      tema: u.matt?.tema ?? null,
      tillagg: u.matt?.tillagg ?? [],
      case_antal: u.matt?.case_antal ?? 0,
      case_urls: u.matt?.case_urls.slice(0, 8) ?? [],
      tjanstesidor_antal: u.matt?.tjanstesidor_antal ?? 0,
    },
    sidor: u.sidor.map((s) => ({
      roll: s.roll,
      url: s.url,
      statuskod: s.statuskod,
      titel: s.titel,
      laddtid_ms: s.laddtid_ms,
      text: korta(rensaText(s.text), viktiga.has(s.roll) ? 4500 : 1500),
      kontroll: slimKontroll(s.kontroll),
      matt: s.matt
        ? { vi_ord: s.matt.vi_ord, ni_ord: s.matt.ni_ord, vi_andel: s.matt.vi_andel, lix: s.matt.lix, formular: s.matt.formular, rubriker_etiketter: s.matt.rubriker_etiketter, rubriker_antal: s.matt.rubriker_antal }
        : null,
      lighthouse: s.lighthouse
        ? {
            poang_prestanda: s.lighthouse.poang_prestanda,
            poang_seo: s.lighthouse.poang_seo,
            poang_tillganglighet: s.lighthouse.poang_tillganglighet,
            lcp_ms: s.lighthouse.lcp_ms,
            cls: s.lighthouse.cls,
            sidvikt_kb: s.lighthouse.sidvikt_kb,
            bilder_kb: s.lighthouse.bilder_kb,
            bildbesparing_kb: s.lighthouse.bildbesparing_kb,
            bildbesparing_exempel: s.lighthouse.bildbesparing_exempel.slice(0, 3),
            klickytor_for_tata: s.lighthouse.klickytor_for_tata,
            textstorlek_for_liten: s.lighthouse.textstorlek_for_liten,
            kontrast_ok: s.lighthouse.kontrast_ok,
            misslyckade_revisioner: s.lighthouse.misslyckade_revisioner.slice(0, 8).map((m) => m.titel),
          }
        : null,
      axe: s.axe
        ? {
            critical_antal: s.axe.critical_antal,
            serious_antal: s.axe.serious_antal,
            moderate_antal: s.axe.moderate_antal,
            brister: s.axe.brister.slice(0, 5).map((b) => ({ id: b.id, allvar: b.allvar, hjalp: b.hjalp, antal_element: b.antal_element })),
          }
        : null,
    })),
  };
}

function slimKontroll(k: SidKontroll): Partial<SidKontroll> {
  const { rubriker, menyord, datum_i_text, bilder_utan_alt_exempel, otydliga_lanktexter_exempel, ...rest } = k;
  return {
    ...rest,
    rubriker: rubriker.slice(0, 15),
    menyord: menyord.slice(0, 12),
    datum_i_text: datum_i_text.slice(0, 4),
    bilder_utan_alt_exempel: bilder_utan_alt_exempel.slice(0, 2),
    otydliga_lanktexter_exempel: otydliga_lanktexter_exempel.slice(0, 3),
  };
}

/** Tar bort upprepade tomma rader och mycket korta rader (menyrester) ur sidtexten. */
export function rensaText(text: string): string {
  return text
    .split("\n")
    .map((r) => r.trim())
    .filter((r, i, arr) => r.length > 0 && arr.indexOf(r) === i)
    .join("\n");
}

export function korta(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... texten är avkortad, ${text.length - max} tecken till ...]`;
}

export function byggSidUnderlag(
  s: HamtadSida,
  kontroll: SidKontroll,
  matt: SidMatt | null,
  lighthouse: LighthouseSammanfattning | null,
  axe: AxeSammanfattning | null,
): SidUnderlag {
  return {
    roll: s.roll,
    url: s.url,
    slutlig_url: s.slutligUrl,
    statuskod: s.statuskod,
    titel: s.titel,
    laddtid_ms: s.laddtidMs,
    text: s.text,
    kontroll,
    matt,
    lighthouse,
    axe,
    skarmbild_dator: s.skarmbildDator,
    skarmbild_mobil: s.skarmbildMobil,
    html_sokvag: s.htmlSokvag,
  };
}
