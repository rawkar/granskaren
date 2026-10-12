import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { konfig, PROMPT_DIR } from "../config.js";
import type { Db } from "../db/index.js";
import { bildBlock, lasPrompt, strukturerat } from "./klient.js";
import { AnalysFordjupadSchema, AnalysSchema, OMRADEN, stadaFynd, type Analys, type AnalysFordjupad } from "./schema.js";
import { underlagForFordjupning, underlagForModell, type Underlag } from "./underlag.js";

/** Den lätta analysen tar fram tre till fyra fynd. Svar med fler fynd (till exempel äldre fördjupade analyser som tolkas om) behålls upp till sex. */
export const MAX_FYND = 4;
export const KLIPP_FYND = 6;

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

function medPerspektiv(system: string): string {
  const perspektiv = lasPerspektiv();
  if (perspektiv) system += `\n\n## Rawaz eget perspektiv\n\nDet här har Rawaz själv skrivit om hur han bedömer webbplatser. Väg in det i analysen och i valet av vad som är viktigast.\n\n${perspektiv}`;
  return system;
}

/** Systemprompten för den lätta analysen: prompts/analys.md och Rawaz perspektiv. Samma text i passet och i API-vägen. */
export function analysSystem(): string {
  return medPerspektiv(lasPrompt("analys"));
}

/** Uppgiften för den lätta analysen: det bantade underlaget, utan skärmbild. */
export function analysUppgift(u: Underlag): { text: string } {
  return {
    text: `Underlag för ${u.doman} i JSON. Nycklarna under kontroll, matt, lighthouse, axe och sajt är de som får användas som belägg av typen matvarde.\n\n${JSON.stringify(underlagForModell(u), null, 1)}`,
  };
}

/** Tolkar ett svar till en Analys och städar den. Okända fält tas bort, så äldre fördjupade svar går också att tolka. */
export function tolkaAnalys(svar: unknown): Analys {
  return stadaAnalys(AnalysSchema.parse(svar));
}

/** Efterstädning av ett analyssvar: allvar inom intervallet, städat förslag, unika id:n, högst KLIPP_FYND fynd. */
export function stadaAnalys(svar: Analys): Analys {
  const sedda = new Set<string>();
  svar.fynd = svar.fynd.slice(0, KLIPP_FYND).map((f, i) => {
    const s = stadaFynd(f);
    let id = s.id || `f-${String(i + 1).padStart(3, "0")}`;
    while (sedda.has(id)) id = `${id}b`;
    sedda.add(id);
    s.id = id;
    return s;
  });
  return svar;
}

/** Tjänsteområdet följer området. */
export function tjansteomradeFor(omrade: keyof typeof OMRADEN): string {
  return OMRADEN[omrade].tjansteomrade;
}

/** Ett analysanrop via API. Används inte i driften (TILLAT_API=false), finns kvar för ett medvetet undantag. */
export async function analysera(d: Db, prospektId: number, u: Underlag): Promise<Analys> {
  const k = konfig();
  const svar = await strukturerat({
    d,
    prospektId,
    steg: "analys",
    modell: k.MODEL_ANALYS,
    system: analysSystem(),
    innehall: [{ type: "text", text: analysUppgift(u).text }],
    schema: AnalysSchema,
    maxTokens: 8000,
    effort: "medium",
  });
  return stadaAnalys(svar);
}

// ---------- den fördjupade analysen (granskaren fordjupa) ----------

/** Systemprompten för den fördjupade analysen: prompts/analys-fordjupad.md och Rawaz perspektiv. */
export function fordjupadSystem(): string {
  return medPerspektiv(lasPrompt("analys-fordjupad"));
}

/** Uppgiften för den fördjupade analysen: hela underlaget plus skärmbilden av startsidan i mobil. */
export function fordjupadUppgift(u: Underlag): { skarmbildText: string | null; skarmbild: string | null; text: string } {
  const start = u.sidor.find((s) => s.roll === "start");
  const skarmbild = start?.skarmbild_mobil && fs.existsSync(start.skarmbild_mobil) ? start.skarmbild_mobil : null;
  return {
    skarmbildText: skarmbild ? `Skärmbild av startsidan i mobil (${start?.url ?? ""})` : null,
    skarmbild,
    text: `Underlag för ${u.doman} i JSON. Nycklarna under kontroll, matt, lighthouse, axe och sajt är de som får användas som belägg av typen matvarde.\n\n${JSON.stringify(underlagForFordjupning(u), null, 1)}`,
  };
}

/** Städar ett fördjupat svar: intervall, tjänsteområde efter område, unika id:n, högst åtta fynd. */
export function stadaFordjupad(svar: AnalysFordjupad): AnalysFordjupad {
  const sedda = new Set<string>();
  const heltal = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));
  svar.fynd = svar.fynd.slice(0, 8).map((f, i) => {
    const s = { ...stadaFynd(f), latt_att_forklara: heltal(f.latt_att_forklara, 1, 3), djup: heltal(f.djup, 1, 3), sakerhet: Math.min(1, Math.max(0, f.sakerhet)), rotorsak: f.rotorsak?.trim() || null };
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

export function tolkaFordjupad(svar: unknown): AnalysFordjupad {
  return stadaFordjupad(AnalysFordjupadSchema.parse(svar));
}

/** Ett fördjupat analysanrop via API. Används inte i driften. */
export async function analyseraFordjupat(d: Db, prospektId: number, u: Underlag): Promise<AnalysFordjupad> {
  const k = konfig();
  const innehall: Anthropic.ContentBlockParam[] = [];
  const uppgift = fordjupadUppgift(u);
  const bild = bildBlock(uppgift.skarmbild);
  if (bild && uppgift.skarmbildText) {
    innehall.push({ type: "text", text: uppgift.skarmbildText });
    innehall.push(bild);
  }
  innehall.push({ type: "text", text: uppgift.text });
  const svar = await strukturerat({ d, prospektId, steg: "analys_fordjupad", modell: k.MODEL_ANALYS, system: fordjupadSystem(), innehall, schema: AnalysFordjupadSchema, maxTokens: 20000, effort: "high" });
  return stadaFordjupad(svar);
}
