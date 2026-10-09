/**
 * Faktaspårning med kod: varje årtal, siffra, tidsuttryck, ortsnamn och egennamn i mejlet, även i det konkreta
 * förslaget, ska gå att spåra till ett bekräftat fynd, ett kodräknat mått eller en profilpunkt med belägg.
 * Annars stoppas utkastet. Gäller båda vägarna (API och pass) eftersom grinden anropar den.
 */
import type { Profil } from "../analyze/schema.js";
import type { Underlag } from "../analyze/underlag.js";
import { normaliseraText } from "../analyze/verifiering.js";
import type { FyndRad, Prospekt } from "../db/fragor.js";

export interface Faktakallor {
  /** Normaliserad text ur bekräftade fynd, profilpunkter med belägg och prospektets uppgifter. */
  text: string;
  /** Alla tal som förekommer i källtexterna och i de kodräknade måtten, som strängar. */
  tal: Set<string>;
}

/** Den fasta presentationen. Skrivs in av programmet, aldrig av modellen. */
export const PRESENTATION = "Jag heter Rawaz Karim och är kommunikationskonsult.";

/** Ord som får vara versala utan att spåras: avsändaren, hälsningar och vanliga egennamn i reglerna. */
const TILLATNA_EGENNAMN = new Set(
  [
    "rawaz", "karim", "rk", "kommunikation", "rkkommunikation.se", "google", "googles", "hej", "vänliga", "hälsningar", "jag", "ni", "er", "era", "ert", "du", "din", "dina", "ditt",
    "om", "oss", "kontakt", "hem", "start", "startsidan", "startsida", "välkommen", "anmäl", "intresse", "boka", "läs", "mer",
  ],
);

/** Tidsuttryck som måste finnas i källorna. */
const TIDSUTTRYCK = [
  "i höst", "i vår", "i sommar", "i vinter", "höst", "hösten", "vår", "våren", "sommar", "sommaren", "vinter", "vintern", "höstterminen", "vårterminen",
  "i år", "nästa år", "förra året", "i fjol", "nyligen", "just nu", "denna vecka", "den här veckan", "nästa vecka", "i dag", "idag", "i morgon",
  "januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december",
];

const RAKNEORD: Record<string, string> = {
  fyra: "4", fem: "5", sex: "6", sju: "7", åtta: "8", nio: "9", tio: "10", elva: "11", tolv: "12", tretton: "13", fjorton: "14", femton: "15",
  sexton: "16", sjutton: "17", arton: "18", nitton: "19", tjugo: "20", trettio: "30", fyrtio: "40", femtio: "50", sextio: "60", sjuttio: "70",
  åttio: "80", nittio: "90", hundra: "100", tusen: "1000",
};

/** Värderande ord om mottagaren som inte får läggas till av modellen. */
export const VARDERANDE = /\b(främsta|bästa|ledande|störst|största|unik|unika|unikt|prisbelön(t|ta|d|da)|välkänd|välkända|erkänd|erkända|populär|populära|älskad|älskade|framstående|förnäm(st|sta)|i världsklass)\b/i;

const ordgrans = (ord: string) => new RegExp(`(?<![a-zåäö0-9])${ord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-zåäö0-9])`, "i");

function samlaTal(text: string, tal: Set<string>): void {
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    tal.add(m[0]);
    tal.add(m[0].replace(",", "."));
    tal.add(m[0].replace(".", ","));
  }
}

function plattaTal(v: unknown, tal: Set<string>): void {
  if (typeof v === "number" && Number.isFinite(v)) {
    tal.add(String(v));
    tal.add(String(Math.round(v)));
    tal.add(String(v).replace(".", ","));
  } else if (Array.isArray(v)) v.forEach((x) => plattaTal(x, tal));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => plattaTal(x, tal));
}

/** Källorna mejlet får hämta uppgifter ur. */
export function byggFaktakallor(p: Pick<Prospekt, "namn" | "doman" | "ort" | "bransch">, fynd: FyndRad[], profil: Profil | null, underlag: Underlag | null): Faktakallor {
  const delar: string[] = [p.namn ?? "", p.doman, p.doman.replace(/^www\./, ""), p.ort ?? "", p.bransch ?? ""];
  for (const f of fynd) {
    if (f.verifierad !== 1) continue;
    delar.push(f.rubrik, f.observation, f.insikt ?? "", f.effekt, f.atgard, f.forslag_konkret ?? "", f.belagg_varde, f.belagg2_varde ?? "", f.rotorsak ?? "", f.belagg_url, f.belagg2_url ?? "");
  }
  if (profil) {
    for (const [nyckel, v] of Object.entries(profil)) {
      if (nyckel === "borja_med") continue;
      if (nyckel === "person") {
        const pers = v as Profil["person"];
        if (pers.fornamn && pers.belagg) delar.push(pers.fornamn, pers.belagg);
        continue;
      }
      const punkt = v as { varde: string; belagg: string | null; gissning: boolean };
      if (punkt && typeof punkt.varde === "string" && punkt.belagg && !punkt.gissning) delar.push(punkt.varde, punkt.belagg);
    }
  }
  const tal = new Set<string>();
  const text = normaliseraText(delar.join("\n"));
  samlaTal(text, tal);
  if (underlag) {
    plattaTal(underlag.sajt, tal);
    plattaTal(underlag.matt, tal);
    for (const s of underlag.sidor) {
      plattaTal(s.kontroll, tal);
      plattaTal(s.matt, tal);
      plattaTal(s.lighthouse, tal);
      plattaTal(s.axe, tal);
      if (s.laddtid_ms !== null) plattaTal(s.laddtid_ms, tal);
    }
  }
  return { text, tal };
}

/** Egennamn: ord med stor bokstav som inte inleder en mening. */
export function egennamn(brodtext: string): string[] {
  const ut: string[] = [];
  const text = brodtext.replace(/https?:\/\/\S+/g, " ");
  // Dela i meningar så att första ordet i varje mening inte räknas
  const meningar = text.split(/(?:[.!?]\s+|\n+)/);
  for (const mening of meningar) {
    const ord = mening.trim().split(/\s+/).filter(Boolean);
    for (let i = 1; i < ord.length; i++) {
      const rent = ord[i].replace(/^[("'“”‘’«»]+|[)"'“”‘’«».,;:!?]+$/g, "");
      if (!/^[A-ZÅÄÖ][a-zåäöé]/.test(rent)) continue;
      if (ord[i - 1].endsWith(":") || ord[i - 1].endsWith('"')) continue; // efter kolon eller citat kan en mening börja
      if (TILLATNA_EGENNAMN.has(rent.toLowerCase())) continue;
      ut.push(rent);
    }
  }
  return [...new Set(ut)];
}

/** Finns ordet i texten, med tolerans för genitiv och vanliga böjningar: Sveriges/Sverige, Luddes/Ludde, Lektionsschema/lektionsschemat. */
function finnsOrd(ord: string, text: string): boolean {
  const n = normaliseraText(ord);
  const stam = (s: string) => `(?<![a-zåäö0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|t|n|en|et|er|na|ar|or|arna|erna)?(?![a-zåäö0-9])`;
  if (new RegExp(stam(n), "i").test(text)) return true;
  if (/s$/.test(n) && new RegExp(stam(n.slice(0, -1)), "i").test(text)) return true;
  return false;
}

/** Fel som gör att utkastet stoppas: uppgifter som inte går att spåra till källorna. */
export function faktafel(brodtext: string, k: Faktakallor): string[] {
  const fel: string[] = [];
  const text = brodtext.replace(/rkkommunikation\.se|https?:\/\/\S+/g, " ");
  const normal = normaliseraText(text);

  for (const ar of new Set([...text.matchAll(/(?<!\d)(1[89]\d{2}|20\d{2})(?!\d)/g)].map((m) => m[1]))) {
    if (!k.tal.has(ar)) fel.push(`årtalet ${ar} finns inte i fynden, måtten eller profilen`);
  }
  for (const s of new Set([...text.matchAll(/(?<![\d.,])\d+(?:[.,]\d+)?(?![\d.,])/g)].map((m) => m[0]))) {
    if (/^(1[89]\d{2}|20\d{2})$/.test(s)) continue;
    if (!k.tal.has(s) && !k.tal.has(s.replace(",", "."))) fel.push(`siffran ${s} finns inte i fynden, måtten eller profilen`);
  }
  for (const [ord, varde] of Object.entries(RAKNEORD)) {
    if (!ordgrans(ord).test(normal)) continue;
    if (!k.tal.has(varde) && !ordgrans(ord).test(k.text)) fel.push(`räkneordet ${ord} (${varde}) finns inte i fynden, måtten eller profilen`);
  }
  for (const uttryck of TIDSUTTRYCK) {
    if (!ordgrans(uttryck).test(normal)) continue;
    if (!ordgrans(uttryck).test(k.text)) fel.push(`tidsuttrycket "${uttryck}" finns inte i fynden eller profilen`);
  }
  for (const namn of egennamn(text)) {
    if (!finnsOrd(namn, k.text)) fel.push(`egennamnet ${namn} finns inte i fynden eller profilen`);
  }
  const varderande = normal.match(VARDERANDE);
  if (varderande && !ordgrans(varderande[0]).test(k.text)) fel.push(`värderande ord "${varderande[0]}" utan stöd i fynden eller profilen`);
  return fel;
}

/**
 * Lägger in den fasta presentationen direkt efter hälsningen. Returnerar fel om modellen själv skrev en
 * presentation eller om hälsningen saknas.
 */
export function medPresentation(raw: string): { brodtext: string; fel: string[] } {
  const fel: string[] = [];
  if (/jag heter|mitt namn är/i.test(raw)) fel.push("presentationen skrivs av programmet, modellen skrev en egen");
  const rader = raw.replace(/\r\n/g, "\n").split("\n");
  const halsning = rader.findIndex((r) => /^hej\b/i.test(r.trim()));
  if (halsning < 0) {
    fel.push("brödtexten börjar inte med en hälsning");
    return { brodtext: raw, fel };
  }
  let i = halsning + 1;
  while (i < rader.length && !rader[i].trim()) i++;
  if (i >= rader.length) {
    fel.push("brödtexten saknar text efter hälsningen");
    return { brodtext: raw, fel };
  }
  rader[i] = `${PRESENTATION} ${rader[i].trim()}`;
  return { brodtext: rader.join("\n"), fel };
}

/**
 * Ett konkret förslag får inte innehålla värderande påståenden om mottagaren, om inte formuleringen finns
 * ordagrant på deras egen sajt. Returnerar orsak om förslaget ska strykas, annars null.
 */
export function forslagsfel(forslag: string | null, sidtexter: string[]): string | null {
  if (!forslag) return null;
  const traff = forslag.match(VARDERANDE);
  if (!traff) return null;
  const n = normaliseraText(forslag.replace(/[.!?]$/, ""));
  for (const t of sidtexter) if (normaliseraText(t).includes(n)) return null;
  return `värderande påstående "${traff[0]}" som inte står ordagrant på sajten`;
}
