import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { konfig, PROMPT_DIR } from "../config.js";
import type { Db } from "../db/index.js";
import { arSparrad, harFattMejl, type FyndRad, type Prospekt } from "../db/fragor.js";
import { lasPrompt, strukturerat } from "../analyze/klient.js";
import { normaliseraText } from "../analyze/verifiering.js";
import { egennamn, faktafel, gallerIntefel, type Faktakallor } from "./fakta.js";
import { giltig } from "./kontakter.js";

export interface Grindresultat {
  godkand: boolean;
  fel: string[];
  varningar: string[];
  sakerhet: number;
  utfall: "koad" | "i_granskning" | "stoppad";
}

export type Tilltal = "du" | "ni";

export const MIN_ORD = 110;
export const MAX_ORD = 190;
export const MAX_AMNE = 60;

/** Räknar ord i brödtexten (före signatur). */
export function antalOrd(text: string): number {
  return text.split(/\s+/).filter((w) => /[a-zåäö0-9]/i.test(w)).length;
}

/** Bygger ämnesraden från mallen i .env. Över 60 tecken används organisationens namn i stället för domänen. */
export function byggAmne(mall: string, doman: string, namn: string | null): string {
  const ren = doman.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  const fyll = (s: string, d: string) => s.replace(/\{dom[aä]n\}/gi, d).replace(/\{namn\}/gi, namn ?? d).trim();
  let amne = fyll(mall, ren);
  if (amne.length > MAX_AMNE && namn) amne = fyll(mall.replace(/\{dom[aä]n\}/gi, "{namn}"), ren);
  return amne;
}

/**
 * Omdömen om mottagarens formuleringar som aldrig får förekomma. "Säger inget om", "nämner inte" och "står inte"
 * är beskrivningar av innehåll som saknas på en sida och är tillåtna; bara "säger inget" utan "om" är ett omdöme.
 */
const OMDOMEN = /som helst|intetsägande|allmän(t|na)? (rad|rubrik|formulering|slogan)|bara en slogan|säger (inget|ingenting)(?! om)|klyscha|tom fras/i;

/**
 * Språkregler som går att kontrollera med kod. Returnerar en lista med fel.
 * tilltal styr om du eller ni är det tillåtna tilltalet. Utelämnas det hoppas kontrollen över.
 */
export function sprakfel(amne: string, brodtext: string, bokningslank: string, tilltal?: Tilltal, undantagsrader: string[] = [], maxOrd = MAX_ORD): string[] {
  const fel: string[] = [];
  const hela = `${amne}\n${brodtext}`;
  // Det konkreta förslaget är text för sajten, inte för mottagaren, och undantas från tilltals- och omdömeskontrollen
  const undantag = new Set(undantagsrader.map((r) => normaliseraText(r)));
  const egenText = brodtext
    .split(/\r?\n/)
    .filter((r) => !undantag.has(normaliseraText(r)))
    .join("\n");
  if (/[–—]/.test(hela)) fel.push("innehåller tankstreck");
  if (/ - /.test(hela)) fel.push("innehåller bindestreck använt som tankstreck");
  if (/:/.test(amne)) fel.push("ämnesraden innehåller kolon");
  const utanLankar = brodtext.replace(/https?:\/\/\S+/g, "");
  if (/:/.test(utanLankar.replace(/\b\d{1,2}:\d{2}\b/g, ""))) fel.push("brödtexten innehåller kolon");
  if (/!/.test(hela)) fel.push("innehåller utropstecken");
  if (/\?/.test(brodtext)) fel.push("innehåller frågetecken (retorisk fråga?)");
  if (/^\s*[-*•\d]+[.)]?\s/m.test(brodtext)) fel.push("innehåller punktlista");
  if (/[*_#>`]/.test(brodtext)) fel.push("innehåller formateringstecken");
  const ord = antalOrd(brodtext);
  if (ord < MIN_ORD || ord > maxOrd) fel.push(`brödtexten är ${ord} ord, ska vara ${MIN_ORD} till ${maxOrd}`);
  if (amne.length > MAX_AMNE) fel.push(`ämnesraden är ${amne.length} tecken, högst ${MAX_AMNE}`);
  if (amne.length < 10) fel.push("ämnesraden är för kort");
  if (amne === amne.toUpperCase() && /[A-ZÅÄÖ]/.test(amne)) fel.push("ämnesraden är skriven med versaler");
  const lankar = [...brodtext.matchAll(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/\S*)?/gi)]
    .map((m) => m[0].toLowerCase().replace(/[.,;:)]+$/, ""))
    .filter((l) => !/@/.test(l));
  const tillatna = ["rkkommunikation.se"];
  if (bokningslank) tillatna.push(bokningslank.toLowerCase().replace(/^https?:\/\//, ""));
  for (const l of lankar) {
    const ren = l.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const ok = tillatna.some((t) => ren === t.replace(/\/$/, "") || ren.startsWith(`${t.replace(/\/$/, "")}/`));
    if (!ok && !/^[a-z0-9-]+\.(se|nu|com|org|net)$/.test(ren)) fel.push(`otillåten länk: ${l}`);
  }
  if (!/rkkommunikation\.se/i.test(brodtext)) fel.push("hänvisning till rkkommunikation.se saknas");
  // Egna ordgränser: \b i JavaScript känner inte å, ä och ö, så "reklambyråer" skulle annars matcha "er"
  const ordgrans = (lista: string) => new RegExp(`(?<![a-zåäö])(${lista})(?![a-zåäö])`, "i");
  if (tilltal === "ni" && ordgrans("du|dig|din|ditt|dina").test(egenText)) fel.push("tilltalar med du i stället för ni");
  if (tilltal === "du" && ordgrans("ni|er|era|ert").test(egenText)) fel.push("tilltalar med ni i stället för du");
  if (tilltal === "du" && !/^Hej [A-ZÅÄÖ][a-zåäöé-]+,/m.test(brodtext)) fel.push("hälsar inte med förnamn");
  if (/\bAI\b|språkmodell|artificiell/i.test(brodtext)) fel.push("nämner AI");
  if (/mätning saknas|statistik saknas|saknar\b[^.]{0,30}\b(mätning|statistik)|ingen mätning|ingen statistik|utan mätning/i.test(brodtext)) {
    fel.push("påstår att mätning saknas, ska vara att inget mätverktyg syns");
  }
  const omdome = egenText.match(OMDOMEN);
  if (omdome) fel.push(`kritiserar mottagarens formulering ("${omdome[0]}")`);
  return fel;
}

/** Formuleringar som påstår att det finns fler saker att förbättra. Får bara finnas när det finns fler bekräftade fynd. */
export const FLER_FYND = /fler (saker|förbättringar|punkter|iakttagelser|detaljer|möjligheter|förslag|ställen|områden)|flera (andra )?(saker|förbättringar|iakttagelser)|mer (som|att) (går att )?förbättra|ytterligare (saker|förbättringar|iakttagelser|punkter)/i;

/** Läser prompts/forbjudna-fraser.md: rader som börjar med "- ", parenteser bortskalade, varianter skilda med " / ". */
export function lasForbjudnaFraser(): string[] {
  const fil = path.join(PROMPT_DIR, "forbjudna-fraser.md");
  if (!fs.existsSync(fil)) return [];
  const ut: string[] = [];
  for (const rad of fs.readFileSync(fil, "utf8").split(/\r?\n/)) {
    if (!rad.trim().startsWith("- ")) continue;
    const utanParentes = rad.trim().slice(2).replace(/\([^)]*\)/g, "");
    for (const del of utanParentes.split(" / ")) {
      const f = del.trim();
      if (f) ut.push(f);
    }
  }
  return ut;
}

export const MAX_ORD_HUVUDPOANG = 12;
/** En mening med högst så många ord räknas som kort i rytmkontrollen. */
export const KORT_MENING = 8;
/** Fler meningar än så i ett stycke stoppas: det som hör ihop ska bindas ihop. */
export const MAX_MENINGAR_PER_STYCKE = 4;

/** Ord som gör att en mening handlar om hur besökare beter sig. */
const BETEENDE = /besök|läsare|läser|kund|den som|de som|få som|många|(?<![a-zåäö])dem(?![a-zåäö])|någon|hittar|klickar|skrollar|når|hinner|letar|jämför|stannar|väljer|bokar|tvekar|hör av sig/i;
const TVARSAKERT = /(?<![a-zåäö])(aldrig|alltid)(?![a-zåäö])/i;

/** Delar brödtexten i stycken utan hälsningsraden. */
export function stycken(brodtext: string): string[] {
  const alla = brodtext
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return alla.filter((s, i) => !(i === 0 && /^hej\b/i.test(s)));
}

/** Delar ett stycke i meningar. Punkt följd av liten bokstav (fil. kand., t.ex.) avslutar ingen mening. */
export function meningar(stycke: string): string[] {
  return stycke
    .split(/(?<=[.!?])\s+(?=[A-ZÅÄÖ0-9"“(])/)
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * Tonreglerna som kontrolleras med kod: första stycket är presentationen plus en mening om att Rawaz har gått igenom
 * webbplatsen och har förslag, utan årtal, ortsnamn eller egennamn; huvudpoängens första mening är högst tolv ord;
 * inga förbjudna fraser någonstans.
 */
export function tonfel(brodtext: string, forbjudna: string[] = lasForbjudnaFraser()): string[] {
  const fel: string[] = [];
  const normal = normaliseraText(brodtext);
  for (const fras of forbjudna) {
    const n = normaliseraText(fras);
    if (n && normal.includes(n)) fel.push(`förbjuden fras: "${fras}"`);
  }
  const s = stycken(brodtext);
  const forsta = s[0] ?? "";
  const m1 = meningar(forsta);
  if (m1.length !== 2) fel.push(`första stycket har ${m1.length} meningar, ska vara två: presentationen och att Rawaz har gått igenom webbplatsen och har förslag`);
  if (!/gått igenom (er|din) webbplats/i.test(forsta)) fel.push('första stycket saknar "Jag har gått igenom er/din webbplats"');
  if (!/förslag/i.test(forsta)) fel.push("första stycket säger inte att Rawaz har förslag");
  if (/(?<!\d)(1[89]\d{2}|20\d{2})(?!\d)/.test(forsta)) fel.push("första stycket innehåller ett årtal");
  const namn = egennamn(forsta);
  if (namn.length) fel.push(`första stycket innehåller ortsnamn eller egennamn: ${namn.join(", ")}`);
  if (/\b(som funnits|sedan \d|ligger i|erbjuder|tar emot|driver|säljer|tillverkar)\b/i.test(forsta)) fel.push("första stycket beskriver mottagarens verksamhet");
  const andra = s[1] ?? "";
  const m2 = meningar(andra);
  if (m2.length) {
    const ord = antalOrd(m2[0]);
    if (ord > MAX_ORD_HUVUDPOANG) fel.push(`huvudpoängens första mening är ${ord} ord, högst ${MAX_ORD_HUVUDPOANG}`);
    if (/den som jämför/i.test(m2[0])) fel.push('huvudpoängens första mening har "den som jämför" som subjekt');
  }
  fel.push(...rytmfel(s.slice(1)), ...tvarsakerhetsfel(s.slice(1)));
  return fel;
}

/**
 * Rytmen: högst två korta meningar i rad och högst fyra meningar i ett stycke. Det konkreta exemplet är ett eget
 * stycke med en mening och berörs inte.
 */
export function rytmfel(stycken: string[]): string[] {
  const fel: string[] = [];
  for (const st of stycken) {
    const m = meningar(st);
    if (m.length > MAX_MENINGAR_PER_STYCKE) fel.push(`ett stycke har ${m.length} meningar, högst ${MAX_MENINGAR_PER_STYCKE}, bind ihop det som hör ihop ("${m[0]}")`);
    let korta = 0;
    for (const mening of m) {
      korta = antalOrd(mening) <= KORT_MENING ? korta + 1 : 0;
      if (korta === 3) {
        fel.push(`tre korta meningar i rad, högst två ("${mening}")`);
        break;
      }
    }
  }
  return fel;
}

/** Påståenden om hur besökare beter sig skrivs försiktigt: aldrig och alltid stoppas i sådana meningar. */
export function tvarsakerhetsfel(stycken: string[]): string[] {
  const fel: string[] = [];
  for (const st of stycken) {
    for (const m of meningar(st)) {
      if (TVARSAKERT.test(m) && BETEENDE.test(m)) fel.push(`för tvärsäkert om hur besökare beter sig ("${m}"), skriv sällan, ofta, många eller få`);
    }
  }
  return fel;
}

/** Ord som förekommer i nästan alla fynd och därför inte säger vilket fynd ett stycke handlar om. */
const ALLMANNA_ORD = new Set([
  "startsidan", "startsida", "sidan", "sidor", "sidorna", "undersidor", "undersidorna", "webbplats", "webbplatsen", "sajten", "besökare", "besökaren", "texten",
  "finns", "står", "saknar", "saknas", "innehåller", "nämner", "visar", "berättar", "syns", "mellan", "också", "eller", "endast", "ingen", "inget", "ingenting",
  "någon", "något", "några", "redan", "sedan", "efter", "genom", "under", "vilket", "vilka", "detta", "denna", "dessa", "skulle", "kunna", "gärna", "bara",
  "inte", "utan", "från", "till", "hela", "andra", "första", "samma", "direkt", "ligger", "vara", "blir", "vill", "mycket", "därför", "eftersom", "kommer",
  "behöver", "istället", "stället", "längre", "högst", "överst", "nedanför", "ovanför", "bredvid", "exempel", "mening", "meningen", "rubrik", "rubriken",
  "huvudrubrik", "huvudrubriken", "knapp", "knappen", "knappar", "knapparna", "länk", "länken", "länkar", "mottagaren", "lättare", "svårare", "idag",
]);

/** Ordstammar (första sex bokstäverna i ord på minst fem) som säger vad en text handlar om. */
function stammar(text: string): Set<string> {
  return new Set(
    normaliseraText(text.replace(/https?:\/\/\S+/g, " "))
      .split(/[^a-zåäöé]+/)
      .filter((w) => w.length >= 5 && !ALLMANNA_ORD.has(w))
      .map((w) => w.slice(0, 6)),
  );
}

/**
 * Huvudpoängen (andra stycket) ska handla om huvudfyndet: det fynd som har störst betydelse för mottagaren.
 * Stycket måste dela minst två ordstammar med huvudfyndet och inte fler med något annat av fynden.
 */
export function huvudpoangfel(brodtext: string, fynd: FyndRad[], huvudId: string | null | undefined): string[] {
  const huvud = huvudId ? fynd.find((f) => f.fynd_id === huvudId) : undefined;
  if (!huvud) return [];
  const stycke = stammar(stycken(brodtext)[1] ?? "");
  const text = (f: FyndRad) => `${f.rubrik} ${f.observation} ${f.insikt ?? ""} ${f.effekt} ${f.atgard} ${f.belagg_varde} ${f.belagg2_varde ?? ""} ${f.forslag_konkret ?? ""}`;
  const traffar = (f: FyndRad) => [...stammar(text(f))].filter((st) => stycke.has(st)).length;
  const egna = traffar(huvud);
  const basta = Math.max(0, ...fynd.filter((f) => f !== huvud).map(traffar));
  if (egna < 2 || basta > egna) return [`huvudpoängen (andra stycket) handlar inte om huvudfyndet "${huvud.rubrik}"`];
  return [];
}

/** Ord som gör en mening till ett förslag snarare än en beskrivning av vad som står på sajten i dag. */
const FORSLAGSORD = /skulle|kunde|kan |förslag|exempel|göra mer nytta|i stället|istället|hellre|som (huvud)?rubrik|på knappen/i;

/**
 * Det konkreta exemplet får inte upprepa ett förslag som redan står i texten med samma ord: fem ord i följd ur
 * exemplet (hela exemplet om det är kortare, men minst fyra ord) får inte finnas i en annan mening som är ett förslag.
 */
export function exempelfel(brodtext: string, forslag: string[]): string[] {
  const rader = brodtext.split(/\r?\n/);
  const rensa = (t: string) => normaliseraText(t).replace(/[.,;:!?"“”]/g, "");
  for (const fo of forslag) {
    const n = rensa(fo);
    const idx = rader.findIndex((r) => rensa(r) === n);
    if (idx < 0) continue;
    const ord = n.split(" ").filter(Boolean);
    if (ord.length < 4) continue;
    const bredd = Math.min(5, ord.length);
    const andraMeningar = rader
      .filter((_, i) => i !== idx)
      .flatMap((r) => meningar(r))
      .filter((m) => FORSLAGSORD.test(m))
      .map(rensa);
    for (let i = 0; i + bredd <= ord.length; i++) {
      const fras = ord.slice(i, i + bredd).join(" ");
      if (andraMeningar.some((m) => m.includes(fras))) return [`det konkreta exemplet upprepar ett förslag som redan står i texten med samma ord ("${fras}")`];
    }
  }
  return [];
}

/**
 * Regler som kontrolleras med kod: konkret förslag på egen rad när det finns, siffror ur fynden.
 * flerFynd är antalet bekräftade fynd utanför mejlet när MEJL_FLER_FYND är på (null när den är av). Är den på
 * skriver programmet självt meningen om fler fynd, så modellen får inte skriva någon sådan mening.
 */
export function tillaggsfel(brodtext: string, fynd: FyndRad[], flerFynd: number | null = null): string[] {
  const fel: string[] = [];
  if (flerFynd !== null) {
    const traff = brodtext.match(FLER_FYND);
    if (traff && flerFynd === 0) fel.push(`påstår att det finns fler saker att förbättra ("${traff[0]}") fast inga fler fynd är bekräftade`);
    else if (traff) fel.push(`skriver själv att det finns fler saker att förbättra ("${traff[0]}"), den meningen lägger programmet till`);
  }
  // Det konkreta exemplet tas med när något av fynden har ett, annars utelämnas det
  const forslag = fynd.map((f) => f.forslag_konkret).filter((x): x is string => !!x);
  if (forslag.length > 0) {
    const rader = brodtext.split(/\r?\n/).map((r) => normaliseraText(r));
    const finns = forslag.some((fo) => rader.includes(normaliseraText(fo)));
    if (!finns) fel.push("det konkreta förslaget står inte ordagrant på en egen rad");
  }
  const kalla = normaliseraText(fynd.map((f) => `${f.observation} ${f.insikt ?? ""} ${f.effekt} ${f.belagg_varde} ${f.belagg2_varde ?? ""} ${f.forslag_konkret ?? ""}`).join(" "));
  const siffror = [...brodtext.replace(/rkkommunikation\.se|https?:\/\/\S+/g, "").matchAll(/\b\d+(?:[.,]\d+)?\b/g)].map((m) => m[0]);
  for (const s of new Set(siffror)) {
    if (!kalla.includes(s.toLowerCase()) && !kalla.includes(s.replace(",", "."))) fel.push(`siffran ${s} finns inte i fynden`);
  }
  return fel;
}

export const GrindSchema = z.object({
  pastaenden_utan_stod: z.array(z.string()),
  siffror_utan_stod: z.array(z.string()),
  tonproblem: z.array(z.string()),
});
export type Grindsvar = z.infer<typeof GrindSchema>;

export interface GrindAlternativ {
  testlage?: boolean;
  profil?: string | null;
  /** Påståenden som verifieringen underkände (galler_inte). Siffror, namn och fraser därifrån får inte förekomma. */
  gallerInte?: (string | null)[];
  tilltal?: Tilltal;
  flerFynd?: number | null;
  /** Källor för faktaspårningen. Utan källor görs ingen spårning. */
  kallor?: Faktakallor | null;
  /** Fel som uppstod innan grinden, till exempel att modellen skrev presentationen själv. */
  extraFel?: string[];
  /** fynd_id för huvudfyndet, det mejlet ska öppna med. Utan det görs ingen kontroll av huvudpoängen. */
  huvudfynd?: string | null;
}

/** Grindens kodkontroller: språkregler, tilläggets regler, faktaspårning, ämnesrad, antal fynd, verifiering, mottagare och spärrlista. */
export function grindKodfel(d: Db, p: Prospekt, utkast: { amne: string; brodtext: string }, fynd: FyndRad[], mottagare: string | null, alt: GrindAlternativ = {}): string[] {
  const k = konfig();
  const fel: string[] = [...(alt.extraFel ?? [])];
  fel.push(...sprakfel(utkast.amne, utkast.brodtext, k.BOKNINGSLANK, alt.tilltal, fynd.map((f) => f.forslag_konkret).filter((x): x is string => !!x), k.MEJL_MAX_ORD || MAX_ORD));
  fel.push(...tillaggsfel(utkast.brodtext, fynd, alt.flerFynd ?? null));
  fel.push(...tonfel(utkast.brodtext));
  fel.push(...huvudpoangfel(utkast.brodtext, fynd, alt.huvudfynd));
  fel.push(...exempelfel(utkast.brodtext, fynd.map((f) => f.forslag_konkret).filter((x): x is string => !!x)));
  fel.push(...gallerIntefel(utkast.brodtext, alt.gallerInte ?? fynd.map((f) => f.galler_inte)));
  if (alt.kallor) fel.push(...faktafel(utkast.brodtext, alt.kallor));

  const namnEllerDoman = [p.namn, p.doman].filter((x): x is string => !!x);
  if (!namnEllerDoman.some((n) => utkast.amne.toLowerCase().includes(n.toLowerCase().replace(/^www\./, "")))) {
    fel.push("ämnesraden innehåller varken organisationens namn eller domän");
  }
  if (fynd.length < 2 || fynd.length > 3) fel.push(`mejlet bygger på ${fynd.length} fynd, ska vara två eller tre`);
  if (fynd.some((f) => f.verifierad !== 1)) fel.push("ett eller flera fynd är inte verifierade");

  if (!alt.testlage) {
    if (!mottagare) fel.push("mottagaradress saknas");
    else if (!giltig(mottagare)) fel.push(`mottagaradressen ${mottagare} är ogiltig`);
    else if (arSparrad(d, mottagare)) fel.push("mottagaren finns på spärrlistan");
    if (arSparrad(d, p.doman)) fel.push("domänen finns på spärrlistan");
    if (harFattMejl(d, p.id)) fel.push("domänen har redan fått ett mejl");
  }
  return fel;
}

/** Det grindens modell får se: mejlet, tilltalet, profilen och fynden med det som inte får användas. */
export function grindUppgift(utkast: { amne: string; brodtext: string }, fynd: FyndRad[], _bra: { text: string }[], alt: GrindAlternativ = {}): string {
  return `Mejl:\nÄmne: ${utkast.amne}\n\n${utkast.brodtext}\n\nTilltal som gäller: ${alt.tilltal ?? "okänt"}\n\nProfil (fakta om organisationen som får användas):\n${alt.profil ?? "(ingen)"}\n\nFynd:\n${JSON.stringify(
    fynd.map((f) => ({ rubrik: f.rubrik, observation: f.observation, effekt: f.effekt, forslag_konkret: f.forslag_konkret, belagg: { url: f.belagg_url, typ: f.belagg_typ, varde: f.belagg_varde }, galler_inte: f.galler_inte })),
    null,
    1,
  )}`;
}

/** Lägger modellens svar till fel och varningar. */
export function tillampaGrindsvar(svar: Grindsvar, fel: string[], varningar: string[]): void {
  for (const s of svar.pastaenden_utan_stod) fel.push(`påstående utan stöd i fynd: "${s}"`);
  for (const s of svar.siffror_utan_stod) varningar.push(`siffra utan stöd: "${s}"`);
  for (const s of svar.tonproblem) varningar.push(`ton: ${s}`);
}

/** Utfallet: stoppad vid fel, köad i auto-läge utan varningar och med tillräcklig säkerhet, annars granskningskön. */
export function grindUtfall(fel: string[], varningar: string[], fynd: FyndRad[]): Grindresultat {
  const k = konfig();
  const sakerhet = fynd.length ? Math.min(...fynd.map((f) => f.sakerhet)) : 0;
  const godkand = fel.length === 0;
  let utfall: Grindresultat["utfall"];
  if (!godkand) utfall = "stoppad";
  else if (k.SANDLAGE === "auto" && sakerhet >= k.MIN_SAKERHET_AUTO && varningar.length === 0) utfall = "koad";
  else utfall = "i_granskning";
  return { godkand, fel, varningar, sakerhet, utfall };
}

/** Kvalitetsgrind enligt avsnitt 9.5 i briefen och avsnitt 8 till 9 i tillägget. */
export async function kvalitetsgrind(
  d: Db,
  p: Prospekt,
  utkast: { amne: string; brodtext: string },
  fynd: FyndRad[],
  bra: { text: string }[],
  mottagare: string | null,
  alt: GrindAlternativ = {},
): Promise<Grindresultat> {
  const k = konfig();
  const fel = grindKodfel(d, p, utkast, fynd, mottagare, alt);
  const varningar: string[] = [];

  // Påståenden mot fynd, med den snabba modellen
  try {
    const svar = await strukturerat({
      d,
      prospektId: p.id,
      steg: "grind",
      modell: k.MODEL_SNABB,
      system: lasPrompt("grind"),
      innehall: [{ type: "text", text: grindUppgift(utkast, fynd, bra, alt) }],
      schema: GrindSchema,
      maxTokens: 2000,
    });
    tillampaGrindsvar(svar, fel, varningar);
  } catch (e) {
    varningar.push(`kontrollen av påståenden kunde inte köras: ${e instanceof Error ? e.message : String(e)}`);
  }
  return grindUtfall(fel, varningar, fynd);
}
