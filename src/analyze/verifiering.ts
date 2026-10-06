import fs from "node:fs";
import * as cheerio from "cheerio";
import type Anthropic from "@anthropic-ai/sdk";
import { konfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { LankKontroll } from "../measure/lankar.js";
import { bildBlock, lasPrompt, strukturerat } from "./klient.js";
import { VerifieringSchema, type Belagg, type Fynd } from "./schema.js";
import { hittaSida, korta, nycklarForSida, rensaText, type SidUnderlag, type Underlag } from "./underlag.js";

export interface VerifieringsResultat {
  verifierad: boolean;
  metod: "kod" | "modell" | "kod+modell" | "ingen";
  not: string;
}

/** Områden där fyndet är en bedömning och därför alltid kontrolleras av ett andra modellanrop. */
const BEDOMNINGSOMRADEN = new Set(["A", "C", "H"]);

/**
 * Kontrollerar ett fynd mot rådata. Mätvärden, saknade element, statuskoder och citat
 * kontrolleras med kod. Bedömningsfynd, fynd med djup 3 och skärmbildsbelägg kontrolleras
 * dessutom med modell. Fynd med djup 3 kräver två belägg som båda håller.
 */
export async function verifieraFynd(
  d: Db,
  prospektId: number,
  u: Underlag,
  f: Fynd,
  lankar: LankKontroll[],
  anvandModell = true,
): Promise<VerifieringsResultat> {
  const kod = kontrolleraMedKod(u, f.belagg, lankar);
  if (kod && !kod.ok) return { verifierad: false, metod: "kod", not: kod.not };

  let kod2: { ok: boolean; not: string } | null = null;
  if (f.djup >= 3) {
    if (!f.belagg2) return { verifierad: false, metod: "kod", not: "Fynd med djup 3 kräver två belägg, bara ett angavs." };
    kod2 = kontrolleraMedKod(u, f.belagg2, lankar);
    if (kod2 && !kod2.ok) return { verifierad: false, metod: "kod", not: `Andra belägget: ${kod2.not}` };
  }
  const kodNot = [kod?.not, kod2 ? `Andra belägget: ${kod2.not}` : null].filter(Boolean).join(" ");

  const behoverModell = f.belagg.typ === "skarmbild" || f.belagg2?.typ === "skarmbild" || BEDOMNINGSOMRADEN.has(f.omrade) || f.djup >= 3;
  if (!behoverModell) {
    return kod ? { verifierad: true, metod: "kod", not: kodNot } : { verifierad: false, metod: "ingen", not: "Ingen kontroll kunde göras." };
  }
  if (!anvandModell) return { verifierad: false, metod: "ingen", not: "Modellkontroll avstängd." };

  const sida = hittaSida(u, f.belagg.url);
  if (!sida) return { verifierad: false, metod: "kod", not: `URL:en ${f.belagg.url} finns inte bland hämtade sidor.` };
  const sida2 = f.belagg2 ? hittaSida(u, f.belagg2.url) : undefined;

  const modell = await kontrolleraMedModell(d, prospektId, sida, sida2 && sida2 !== sida ? sida2 : undefined, f);
  const metod = kod ? "kod+modell" : "modell";
  const not = [kodNot, `Modell: ${modell.bedomning}. ${modell.motivering}`].filter(Boolean).join(" ");
  return { verifierad: modell.bedomning === "bekraftat", metod, not };
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
    return faktisk === forvantad
      ? { ok: true, not: `Statuskod ${faktisk} bekräftad.` }
      : { ok: false, not: `Påstådd statuskod ${forvantad}, faktisk ${faktisk}.` };
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
    return antal === 0
      ? { ok: true, not: `Selektorn ${varde} ger noll träffar i renderad HTML.` }
      : { ok: false, not: `Selektorn ${varde} ger ${antal} träffar, elementet saknas inte.` };
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
    return Math.abs(tal - faktiskt) <= tolerans
      ? { ok: true, not: `${nyckel}=${faktiskt} bekräftat.` }
      : { ok: false, not: `${nyckel} är ${faktiskt}, inte ${pastatt}.` };
  }
  if (typeof faktiskt === "boolean") {
    const b = p === "true" || p === "ja" || p === "sant";
    const f = p === "false" || p === "nej" || p === "falskt";
    if (!b && !f) return { ok: false, not: `${nyckel} är ${faktiskt}, påståendet "${pastatt}" är inte ett sanningsvärde.` };
    return (b ? true : false) === faktiskt ? { ok: true, not: `${nyckel}=${faktiskt} bekräftat.` } : { ok: false, not: `${nyckel} är ${faktiskt}, inte ${pastatt}.` };
  }
  if (faktiskt === null || faktiskt === undefined) {
    return p === "null" || p === "saknas" || p === "" || p === "none"
      ? { ok: true, not: `${nyckel} saknar värde, bekräftat.` }
      : { ok: false, not: `${nyckel} saknar värde, påståendet var "${pastatt}".` };
  }
  if (Array.isArray(faktiskt)) {
    if (/^\d+$/.test(p)) {
      return Number.parseInt(p, 10) === faktiskt.length
        ? { ok: true, not: `${nyckel} har ${faktiskt.length} poster, bekräftat.` }
        : { ok: false, not: `${nyckel} har ${faktiskt.length} poster, inte ${p}.` };
    }
    if (p === "[]" || p === "tom" || p === "inga") return faktiskt.length === 0 ? { ok: true, not: `${nyckel} är tom, bekräftat.` } : { ok: false, not: `${nyckel} är inte tom.` };
    const finns = faktiskt.some((x) => JSON.stringify(x).toLowerCase().includes(p));
    return finns ? { ok: true, not: `"${pastatt}" finns i ${nyckel}.` } : { ok: false, not: `"${pastatt}" finns inte i ${nyckel}.` };
  }
  const s = String(faktiskt).toLowerCase().trim();
  return s === p || s.includes(p)
    ? { ok: true, not: `${nyckel} bekräftat.` }
    : { ok: false, not: `${nyckel} är "${String(faktiskt).slice(0, 80)}", inte "${pastatt}".` };
}

async function kontrolleraMedModell(d: Db, prospektId: number, sida: SidUnderlag, sida2: SidUnderlag | undefined, f: Fynd) {
  const k = konfig();
  const innehall: Anthropic.ContentBlockParam[] = [];
  if (f.belagg.typ === "skarmbild" || f.belagg2?.typ === "skarmbild") {
    const b = bildBlock(sida.skarmbild_mobil);
    if (b) {
      innehall.push({ type: "text", text: `Skärmbild i mobil av ${sida.url}` });
      innehall.push(b);
    }
  }
  const sidtext = (s: SidUnderlag) =>
    [
      `Sidans URL: ${s.url} (roll: ${s.roll}, titel: ${s.titel ?? "saknas"})`,
      `Automatiska kontroller och mått:\n${JSON.stringify({ ...s.kontroll, rubriker: s.kontroll.rubriker.slice(0, 20), matt: s.matt }, null, 1)}`,
      `Sidans fullständiga text:\n${korta(rensaText(s.text), 14000)}`,
    ].join("\n\n");
  innehall.push({
    type: "text",
    text: [`Fynd att kontrollera:\n${JSON.stringify(f, null, 1)}`, sidtext(sida), sida2 ? `Andra beläggets sida.\n${sidtext(sida2)}` : ""].filter(Boolean).join("\n\n"),
  });
  return strukturerat({
    d,
    prospektId,
    steg: "verifiering",
    modell: k.MODEL_SNABB,
    system: lasPrompt("verifiering"),
    innehall,
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
    .replace(/ /g, " ")
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
