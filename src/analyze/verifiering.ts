import fs from "node:fs";
import * as cheerio from "cheerio";
import { konfig } from "../config.js";
import type { Db } from "../db/index.js";
import { forslagsfel } from "../email/fakta.js";
import type { LankKontroll } from "../measure/lankar.js";
import { lasPrompt, strukturerat } from "./klient.js";
import { VerifieringSchema, type Belagg, type Fynd, type Verifiering } from "./schema.js";
import { hittaSida, korta, nycklarForSida, rensaText, type SidUnderlag, type Underlag } from "./underlag.js";

export interface VerifieringsResultat {
  verifierad: boolean;
  metod: "kod" | "modell" | "kod+modell" | "ingen";
  not: string;
  /** Påstående i fyndet som inte får användas i mejlet (verifieringen svarade delvis). */
  gallerInte: string | null;
}

/** Områden där fyndet handlar om vad texten säger och därför kontrolleras av modellen efter kodkontrollen. */
const BEDOMNINGSOMRADEN = new Set(["A", "C", "G", "H"]);

/**
 * Kontrollerar ett fynd mot rådata. Mätvärden, saknade element, statuskoder och citat kontrolleras med kod.
 * Fynd om vad texten säger kontrolleras dessutom av modellen, som bedömer fakta, inte nivå.
 */
export async function verifieraFynd(d: Db, prospektId: number, u: Underlag, f: Fynd, lankar: LankKontroll[], anvandModell = true): Promise<VerifieringsResultat> {
  const steg = verifieraMedKod(u, f, lankar);
  if (steg.klar) return steg.klar;
  if (!anvandModell) return { verifierad: false, metod: "ingen", not: "Modellkontroll avstängd.", gallerInte: null };
  const modell = await kontrolleraMedModell(d, prospektId, steg.sida, f);
  return kombineraVerifiering(steg, modell);
}

/**
 * Stryker konkreta förslag med värderande påståenden om mottagaren som inte står ordagrant på sajten.
 * Returnerar en rad per struket förslag. Körs före verifieringen.
 */
export function rensaForslag(u: Underlag, fynd: Pick<Fynd, "id" | "forslag_konkret">[]): string[] {
  const sidtexter = u.sidor.map((s) => s.text);
  const ut: string[] = [];
  for (const f of fynd) {
    const orsak = forslagsfel(f.forslag_konkret, sidtexter);
    if (orsak) {
      ut.push(`${f.id}: förslaget "${f.forslag_konkret}" ströks, ${orsak}`);
      f.forslag_konkret = null;
    }
  }
  return ut;
}

/** Kodkontrollen är klar och avgjorde fyndet, eller så behöver fyndet modellens bedömning av den här sidan. */
export type KodSteg = { klar: VerifieringsResultat } | { klar?: undefined; kodNot: string; metod: "kod+modell" | "modell"; sida: SidUnderlag };

/**
 * Kodkontrollen, som alltid går före modellen: belägg av typerna matvarde, saknat_element, statuskod och citat
 * kontrolleras mot rådata. Fynd som faller här når aldrig modellen.
 */
export function verifieraMedKod(u: Underlag, f: Fynd, lankar: LankKontroll[]): KodSteg {
  const kod = kontrolleraMedKod(u, f.belagg, lankar);
  if (kod && !kod.ok) return { klar: { verifierad: false, metod: "kod", not: kod.not, gallerInte: null } };
  const kodNot = kod?.not ?? "";

  const behoverModell = f.belagg.typ === "skarmbild" || BEDOMNINGSOMRADEN.has(f.omrade);
  if (!behoverModell) {
    return { klar: kod ? { verifierad: true, metod: "kod", not: kodNot, gallerInte: null } : { verifierad: false, metod: "ingen", not: "Ingen kontroll kunde göras.", gallerInte: null } };
  }
  const sida = hittaSida(u, f.belagg.url);
  if (!sida) return { klar: { verifierad: false, metod: "kod", not: `URL:en ${f.belagg.url} finns inte bland hämtade sidor.`, gallerInte: null } };
  return { kodNot, metod: kod ? "kod+modell" : "modell", sida };
}

/** Slår ihop kodkontrollens not med modellens bedömning. bekraftat och delvis räknas som verifierade, delvis med galler_inte. */
export function kombineraVerifiering(steg: Exclude<KodSteg, { klar: VerifieringsResultat }>, modell: Verifiering): VerifieringsResultat {
  const gallerInte = modell.bedomning === "delvis" ? modell.galler_inte?.trim() || null : null;
  const not = [steg.kodNot, `Modell: ${modell.bedomning}. ${modell.motivering}`, gallerInte ? `Gäller inte: ${gallerInte}` : ""].filter(Boolean).join(" ");
  return { verifierad: modell.bedomning !== "fel", metod: steg.metod, not, gallerInte };
}

/** Det modellen får se för ett fynd: fyndet, sidans kontroller och text. Ingen skärmbild. */
export function verifieringsUppgift(sida: SidUnderlag, f: Fynd): { text: string } {
  return {
    text: [
      `Fynd att kontrollera:\n${JSON.stringify(f, null, 1)}`,
      `Sidans URL: ${sida.url} (roll: ${sida.roll}, titel: ${sida.titel ?? "saknas"})`,
      `Automatiska kontroller och mått:\n${JSON.stringify({ ...sida.kontroll, rubriker: sida.kontroll.rubriker.slice(0, 20), matt: sida.matt }, null, 1)}`,
      `Sidans fullständiga text:\n${korta(rensaText(sida.text), 12000)}`,
    ].join("\n\n"),
  };
}

/** Returnerar null om belägget inte går att kontrollera med kod. */
export function kontrolleraMedKod(u: Underlag, b: Belagg, lankar: LankKontroll[]): { ok: boolean; not: string } | null {
  const sida = hittaSida(u, b.url);
  const typ = b.typ;
  const varde = b.varde.trim();

  if (typ === "statuskod") {
    const forvantad = Number.parseInt(varde.replace(/\D/g, ""), 10);
    if (!Number.isFinite(forvantad)) return { ok: false, not: `Statuskoden "${varde}" är inte ett tal.` };
    const faktisk = sida?.statuskod ?? lankar.find((l) => normalisera(l.url) === normalisera(b.url))?.status;
    if (faktisk === undefined) return { ok: false, not: `URL:en ${b.url} har inte kontrollerats.` };
    if (faktisk === null) return { ok: forvantad >= 500 || forvantad === 0, not: `Anropet till ${b.url} misslyckades helt (ingen statuskod).` };
    return faktisk === forvantad ? { ok: true, not: `Statuskod ${faktisk} bekräftad.` } : { ok: false, not: `Påstådd statuskod ${forvantad}, faktisk ${faktisk}.` };
  }

  if (!sida) return { ok: false, not: `URL:en ${b.url} finns inte bland hämtade sidor.` };

  if (typ === "saknat_element") {
    if (!fs.existsSync(sida.html_sokvag)) return { ok: false, not: "Sparad HTML saknas." };
    const $ = cheerio.load(fs.readFileSync(sida.html_sokvag, "utf8"));
    let antal: number;
    try {
      antal = $(varde).length;
    } catch {
      return { ok: false, not: `"${varde}" är inte en giltig CSS-selektor.` };
    }
    if (antal > 0 && /^title$/i.test(varde)) antal = $("title").text().trim() ? antal : 0;
    if (antal > 0 && /meta\[name=.?description.?\]/i.test(varde)) antal = ($('meta[name="description"]').attr("content") ?? "").trim() ? antal : 0;
    return antal === 0 ? { ok: true, not: `Selektorn ${varde} ger noll träffar i renderad HTML.` } : { ok: false, not: `Selektorn ${varde} ger ${antal} träffar, elementet saknas inte.` };
  }

  if (typ === "matvarde") {
    const m = varde.match(/^([a-z_.0-9]+)\s*=\s*(.*)$/i);
    if (!m) return { ok: false, not: `Belägget "${varde}" följer inte formen nyckel=värde.` };
    const nyckel = m[1];
    const pastatt = m[2].trim();
    const nycklar = nycklarForSida(u, sida);
    if (!(nyckel in nycklar)) {
      const start = u.sidor.find((s) => s.roll === "start");
      if (nyckel.startsWith("sajt.") && start) {
        const alla = nycklarForSida(u, start);
        if (nyckel in alla) return jamfor(nyckel, alla[nyckel], pastatt);
      }
      return { ok: false, not: `Nyckeln ${nyckel} finns inte i underlaget för ${sida.url}.` };
    }
    return jamfor(nyckel, nycklar[nyckel], pastatt);
  }

  if (typ === "citat") {
    const text = normaliseraText(sida.text);
    const citat = normaliseraText(varde.replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""));
    if (citat.length < 3) return { ok: false, not: "Citatet är för kort." };
    if (text.includes(citat)) return { ok: true, not: "Citatet finns ordagrant i sidans text." };
    const extra = normaliseraText([sida.titel ?? "", ...sida.kontroll.h1_text, ...sida.kontroll.rubriker.map((r) => r.replace(/^h\d: /, ""))].join("\n"));
    if (extra.includes(citat)) return { ok: true, not: "Citatet finns i sidans titel eller rubriker." };
    return { ok: false, not: "Citatet finns inte ordagrant i sidans text." };
  }

  return null; // skarmbild kontrolleras av modell
}

function jamfor(nyckel: string, faktiskt: unknown, pastatt: string): { ok: boolean; not: string } {
  const p = pastatt.toLowerCase().replace(/^["']|["']$/g, "").trim();
  if (typeof faktiskt === "number") {
    const tal = Number.parseFloat(p.replace(",", ".").replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(tal)) return { ok: false, not: `${nyckel} är ${faktiskt}, påståendet "${pastatt}" är inte ett tal.` };
    const tolerans = Math.max(Number.isInteger(faktiskt) ? 1 : 0.02, Math.abs(faktiskt) * 0.1);
    return Math.abs(tal - faktiskt) <= tolerans ? { ok: true, not: `${nyckel}=${faktiskt} bekräftat.` } : { ok: false, not: `${nyckel} är ${faktiskt}, inte ${pastatt}.` };
  }
  if (typeof faktiskt === "boolean") {
    const b = p === "true" || p === "ja" || p === "sant";
    const f = p === "false" || p === "nej" || p === "falskt";
    if (!b && !f) return { ok: false, not: `${nyckel} är ${faktiskt}, påståendet "${pastatt}" är inte ett sanningsvärde.` };
    return (b ? true : false) === faktiskt ? { ok: true, not: `${nyckel}=${faktiskt} bekräftat.` } : { ok: false, not: `${nyckel} är ${faktiskt}, inte ${pastatt}.` };
  }
  if (faktiskt === null || faktiskt === undefined) {
    return p === "null" || p === "saknas" || p === "" || p === "none" ? { ok: true, not: `${nyckel} saknar värde, bekräftat.` } : { ok: false, not: `${nyckel} saknar värde, påståendet var "${pastatt}".` };
  }
  if (Array.isArray(faktiskt)) {
    if (/^\d+$/.test(p)) {
      return Number.parseInt(p, 10) === faktiskt.length ? { ok: true, not: `${nyckel} har ${faktiskt.length} poster, bekräftat.` } : { ok: false, not: `${nyckel} har ${faktiskt.length} poster, inte ${p}.` };
    }
    if (p === "[]" || p === "tom" || p === "inga") return faktiskt.length === 0 ? { ok: true, not: `${nyckel} är tom, bekräftat.` } : { ok: false, not: `${nyckel} är inte tom.` };
    const finns = faktiskt.some((x) => JSON.stringify(x).toLowerCase().includes(p));
    return finns ? { ok: true, not: `"${pastatt}" finns i ${nyckel}.` } : { ok: false, not: `"${pastatt}" finns inte i ${nyckel}.` };
  }
  const s = String(faktiskt).toLowerCase().trim();
  return s === p || s.includes(p) ? { ok: true, not: `${nyckel} bekräftat.` } : { ok: false, not: `${nyckel} är "${String(faktiskt).slice(0, 80)}", inte "${pastatt}".` };
}

async function kontrolleraMedModell(d: Db, prospektId: number, sida: SidUnderlag, f: Fynd): Promise<Verifiering> {
  const k = konfig();
  return strukturerat({
    d,
    prospektId,
    steg: "verifiering",
    modell: k.MODEL_SNABB,
    system: lasPrompt("verifiering"),
    innehall: [{ type: "text", text: verifieringsUppgift(sida, f).text }],
    schema: VerifieringSchema,
    maxTokens: 1500,
  });
}

export function normaliseraText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalisera(url: string): string {
  try {
    const x = new URL(url);
    x.hash = "";
    return x.href.replace(/\/$/, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
