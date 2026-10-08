import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { konfig, PROMPT_DIR } from "../config.js";
import type { Db } from "../db/index.js";
import { bildBlock, lasPrompt, strukturerat } from "./klient.js";
import { AnalysKortSchema, AnalysSchema, franKortAnalys, OMRADEN, stadaFynd, type Analys } from "./schema.js";
import { underlagForModell, type Underlag } from "./underlag.js";

/** Standardomfång enligt prompts/analys.md: fyra till sex fynd med alla fält. */
export const STANDARD_MAX_FYND = 6;

/**
 * Tillägg till systemprompten när .env begär färre fynd (ANALYS_MAX_FYND) eller kortare fynd (ANALYS_KORT).
 * Tom sträng när inget avviker från prompten som den är skriven.
 */
export function omfangsText(maxFynd: number, kort: boolean): string {
  if (maxFynd >= STANDARD_MAX_FYND && !kort) return "";
  const rader = ["## Omfång för den här körningen", ""];
  if (maxFynd < STANDARD_MAX_FYND) {
    rader.push(
      `Ta fram högst ${maxFynd} fynd, de som har störst betydelse för sajtens syfte. Det gäller i stället för fyra till sex ovan. Minst ett av fynden ska ha djup 3, med två belägg som vanligt. Hellre färre fynd än ett fynd som är fel.`,
    );
  }
  if (kort) {
    rader.push(
      "Fälten insikt och rotorsak finns inte i svaret. Skriv i stället observation så att den rymmer själva observationen, varför det spelar roll för den här organisationens syfte och den troliga orsaken, i högst två meningar. Belägg, djup, effekt, åtgärd och det konkreta förslaget är oförändrade.",
    );
  }
  return `\n\n${rader.join("\n")}`;
}

export interface AnalysAlternativ {
  /** Modell att använda i stället för MODEL_ANALYS, till exempel vid upptrappning. */
  modell?: string;
  /** Namn på steget i kostnadsloggen. Standard analys. */
  steg?: string;
}

/**
 * Läser prompts/rawaz-perspektiv.md och returnerar det Rawaz har fyllt i.
 * Rader som börjar med > är anvisningar och skickas inte med. Tomma avsnitt hoppas över.
 */
export function lasPerspektiv(): string | null {
  const fil = path.join(PROMPT_DIR, "rawaz-perspektiv.md");
  if (!fs.existsSync(fil)) return null;
  const rader = fs.readFileSync(fil, "utf8").split(/\r?\n/);
  // Text före första avsnittet räknas som inledning
  const avsnitt: { rubrik: string; text: string[] }[] = [{ rubrik: "Inledning", text: [] }];
  for (const rad of rader) {
    if (rad.startsWith("## ")) avsnitt.push({ rubrik: rad.slice(3).trim(), text: [] });
    else if (rad.startsWith("#") || rad.startsWith(">")) continue;
    else if (rad.trim()) avsnitt[avsnitt.length - 1].text.push(rad.trim());
  }
  const ifyllda = avsnitt.filter((a) => a.text.length > 0);
  if (ifyllda.length === 0) return null;
  return ifyllda.map((a) => `### ${a.rubrik}\n${a.text.join("\n")}`).join("\n\n");
}

/** Ett analysanrop som ger profil, fynd och huvudinsikt i samma svar. */
export async function analysera(d: Db, prospektId: number, u: Underlag, alt: AnalysAlternativ = {}): Promise<Analys> {
  const k = konfig();
  const maxFynd = k.ANALYS_MAX_FYND;
  const innehall: Anthropic.ContentBlockParam[] = [];

  // Högst en skärmbild: startsidan i mobil
  const start = u.sidor.find((s) => s.roll === "start");
  const bild = bildBlock(start?.skarmbild_mobil ?? null);
  if (bild) {
    innehall.push({ type: "text", text: `Skärmbild av startsidan i mobil (${start?.url ?? ""})` });
    innehall.push(bild);
  }

  innehall.push({
    type: "text",
    text: `Underlag för ${u.doman} i JSON. Nycklarna under kontroll, matt, lighthouse, axe och sajt är de som får användas som belägg av typen matvarde.\n\n${JSON.stringify(underlagForModell(u), null, 1)}`,
  });

  let system = lasPrompt("analys");
  const perspektiv = lasPerspektiv();
  if (perspektiv) system += `\n\n## Rawaz eget perspektiv\n\nDet här har Rawaz själv skrivit om hur han bedömer webbplatser. Väg in det i analysen och i valet av vad som är viktigast.\n\n${perspektiv}`;
  system += omfangsText(maxFynd, k.ANALYS_KORT);

  const bas = {
    d,
    prospektId,
    steg: alt.steg ?? "analys",
    modell: alt.modell ?? k.MODEL_ANALYS,
    system,
    innehall,
    maxTokens: 20000,
    effort: "high" as const,
  };
  const svar: Analys = k.ANALYS_KORT
    ? franKortAnalys(await strukturerat({ ...bas, schema: AnalysKortSchema }))
    : await strukturerat({ ...bas, schema: AnalysSchema });

  // Efterstädning: intervall, tjänsteområde enligt område, unika id:n
  const sedda = new Set<string>();
  svar.fynd = svar.fynd.slice(0, maxFynd < STANDARD_MAX_FYND ? maxFynd : 8).map((f, i) => {
    const s = stadaFynd(f);
    s.tjansteomrade = OMRADEN[s.omrade].tjansteomrade;
    let id = s.id || `f-${String(i + 1).padStart(3, "0")}`;
    while (sedda.has(id)) id = `${id}b`;
    sedda.add(id);
    s.id = id;
    return s;
  });
  svar.bra = svar.bra.slice(0, 3);
  svar.borja_med = svar.borja_med.slice(0, 3);
  if (svar.huvudinsikt) {
    svar.huvudinsikt.fynd_ids = svar.huvudinsikt.fynd_ids.filter((id) => sedda.has(id));
    if (svar.huvudinsikt.fynd_ids.length < 2 || !svar.huvudinsikt.text.trim()) svar.huvudinsikt = null;
  }
  return svar;
}
