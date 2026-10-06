import { z } from "zod";
import { konfig } from "../config.js";
import type { Db } from "../db/index.js";
import { arSparrad, harFattMejl, type FyndRad, type Prospekt } from "../db/fragor.js";
import { lasPrompt, strukturerat } from "../analyze/klient.js";
import { normaliseraText } from "../analyze/verifiering.js";
import { giltig } from "./kontakter.js";

export interface Grindresultat {
  godkand: boolean;
  fel: string[];
  varningar: string[];
  sakerhet: number;
  utfall: "koad" | "i_granskning" | "stoppad";
}

export type Tilltal = "du" | "ni";

export const MIN_ORD = 150;
export const MAX_ORD = 220;
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

/** Omdömen om mottagarens formuleringar som aldrig får förekomma. */
const OMDOMEN = /som helst|intetsägande|allmän(t|na)? (rad|rubrik|formulering|slogan)|bara en slogan|säger (inget|ingenting)|klyscha|tom fras/i;

/**
 * Språkregler som går att kontrollera med kod. Returnerar en lista med fel.
 * tilltal styr om du eller ni är det tillåtna tilltalet. Utelämnas det hoppas kontrollen över.
 */
export function sprakfel(amne: string, brodtext: string, bokningslank: string, tilltal?: Tilltal, undantagsrader: string[] = []): string[] {
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
  if (ord < MIN_ORD || ord > MAX_ORD) fel.push(`brödtexten är ${ord} ord, ska vara ${MIN_ORD} till ${MAX_ORD}`);
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

/** Regler från tillägget som kontrolleras med kod: fyndens djup, konkret förslag på egen rad, siffror. */
export function tillaggsfel(brodtext: string, fynd: FyndRad[]): string[] {
  const fel: string[] = [];
  if (!fynd.some((f) => f.djup === 3)) fel.push("inget av fynden har djup 3");
  if (fynd.filter((f) => f.djup === 1).length > 1) fel.push("fler än ett fynd med djup 1");
  const forslag = fynd.map((f) => f.forslag_konkret).filter((x): x is string => !!x);
  if (forslag.length === 0) fel.push("inget av fynden har ett konkret förslag");
  else {
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

const GrindSchema = z.object({
  pastaenden_utan_stod: z.array(z.string()),
  siffror_utan_stod: z.array(z.string()),
  tonproblem: z.array(z.string()),
});

/** Kvalitetsgrind enligt avsnitt 9.5 i briefen och avsnitt 8 till 9 i tillägget. */
export async function kvalitetsgrind(
  d: Db,
  p: Prospekt,
  utkast: { amne: string; brodtext: string },
  fynd: FyndRad[],
  bra: { text: string }[],
  mottagare: string | null,
  alt: { testlage?: boolean; huvudinsikt?: string | null; profil?: string | null; tilltal?: Tilltal } = {},
): Promise<Grindresultat> {
  const k = konfig();
  const fel: string[] = [];
  const varningar: string[] = [];

  fel.push(...sprakfel(utkast.amne, utkast.brodtext, k.BOKNINGSLANK, alt.tilltal, fynd.map((f) => f.forslag_konkret).filter((x): x is string => !!x)));
  fel.push(...tillaggsfel(utkast.brodtext, fynd));

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

  // Påståenden mot fynd, med den snabba modellen
  try {
    const svar = await strukturerat({
      d,
      prospektId: p.id,
      steg: "grind",
      modell: k.MODEL_SNABB,
      system: lasPrompt("grind"),
      innehall: [
        {
          type: "text",
          text: `Mejl:\nÄmne: ${utkast.amne}\n\n${utkast.brodtext}\n\nTilltal som gäller: ${alt.tilltal ?? "okänt"}\n\nHuvudinsikt:\n${alt.huvudinsikt ?? "(ingen)"}\n\nProfil (fakta om organisationen som får användas):\n${alt.profil ?? "(ingen)"}\n\nFynd:\n${JSON.stringify(
            fynd.map((f) => ({ rubrik: f.rubrik, observation: f.observation, insikt: f.insikt, effekt: f.effekt, forslag_konkret: f.forslag_konkret, belagg: { url: f.belagg_url, typ: f.belagg_typ, varde: f.belagg_varde }, belagg2: f.belagg2_varde })),
            null,
            1,
          )}\n\nDet som fungerar bra:\n${JSON.stringify(bra.map((b) => b.text))}`,
        },
      ],
      schema: GrindSchema,
      maxTokens: 2000,
    });
    for (const s of svar.pastaenden_utan_stod) fel.push(`påstående utan stöd i fynd: "${s}"`);
    for (const s of svar.siffror_utan_stod) varningar.push(`siffra utan stöd: "${s}"`);
    for (const s of svar.tonproblem) varningar.push(`ton: ${s}`);
  } catch (e) {
    varningar.push(`kontrollen av påståenden kunde inte köras: ${e instanceof Error ? e.message : String(e)}`);
  }

  const sakerhet = fynd.length ? Math.min(...fynd.map((f) => f.sakerhet)) : 0;
  const godkand = fel.length === 0;
  let utfall: Grindresultat["utfall"];
  if (!godkand) utfall = "stoppad";
  else if (k.SANDLAGE === "auto" && sakerhet >= k.MIN_SAKERHET_AUTO && varningar.length === 0) utfall = "koad";
  else utfall = "i_granskning";
  return { godkand, fel, varningar, sakerhet, utfall };
}
