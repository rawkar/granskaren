import type { HamtadSida } from "../crawl/hamta.js";
import type { AxeSammanfattning } from "../measure/axe.js";
import type { SajtKontroll, SidKontroll } from "../measure/kontroller.js";
import type { LighthouseSammanfattning } from "../measure/lighthouse.js";
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
  sidor: SidUnderlag[];
}

/** Plattar ut mätvärden för en sida till nyckel=värde, så att fynd kan kontrolleras med kod. */
export function nycklarForSida(u: Underlag, sida: SidUnderlag): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sida.kontroll)) m[`kontroll.${k}`] = v;
  if (sida.lighthouse) for (const [k, v] of Object.entries(sida.lighthouse)) m[`lighthouse.${k}`] = v;
  if (sida.axe) for (const [k, v] of Object.entries(sida.axe)) m[`axe.${k}`] = v;
  m["sida.statuskod"] = sida.statuskod;
  m["sida.laddtid_ms"] = sida.laddtid_ms;
  if (sida.roll === "start") for (const [k, v] of Object.entries(u.sajt)) m[`sajt.${k}`] = v;
  return m;
}

export function hittaSida(u: Underlag, url: string): SidUnderlag | undefined {
  const n = normaliseraUrl(url);
  return u.sidor.find((s) => normaliseraUrl(s.url) === n || normaliseraUrl(s.slutlig_url) === n);
}

/** Det modellen får se. Texter kortas och tunga fält tas bort så att underlaget håller sig rimligt. */
export function underlagForModell(u: Underlag): unknown {
  const viktiga = new Set(["start", "handling", "om", "kontakt"]);
  return {
    doman: u.doman,
    namn: u.namn,
    bransch: u.bransch,
    ort: u.ort,
    sajt: u.sajt,
    sidor: u.sidor.map((s) => ({
      roll: s.roll,
      url: s.url,
      slutlig_url: s.slutlig_url,
      statuskod: s.statuskod,
      titel: s.titel,
      laddtid_ms: s.laddtid_ms,
      text: korta(s.text, viktiga.has(s.roll) ? 6000 : 2500),
      kontroll: s.kontroll,
      lighthouse: s.lighthouse
        ? { ...s.lighthouse, misslyckade_revisioner: s.lighthouse.misslyckade_revisioner.slice(0, 15) }
        : null,
      axe: s.axe ? { ...s.axe, brister: s.axe.brister.slice(0, 10) } : null,
    })),
  };
}

export function korta(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... texten är avkortad, ${text.length - max} tecken till ...]`;
}

export function byggSidUnderlag(
  s: HamtadSida,
  kontroll: SidKontroll,
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
    lighthouse,
    axe,
    skarmbild_dator: s.skarmbildDator,
    skarmbild_mobil: s.skarmbildMobil,
    html_sokvag: s.htmlSokvag,
  };
}
