import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { lasPrompt, strukturerat } from "../analyze/klient.js";
import type { Huvudinsikt, Profil } from "../analyze/schema.js";
import { konfig } from "../config.js";
import type { Db } from "../db/index.js";
import {
  braForProspekt,
  fyndForProspekt,
  harFattMejl,
  loggaHandelse,
  sattStatus,
  sidorForProspekt,
  type FyndRad,
  type Prospekt,
} from "../db/fragor.js";
import { rapportSokvag } from "../report/rapport.js";
import { dataMapp, filnamnSaker } from "../util/fil.js";
import { logg } from "../util/logg.js";
import { byggAmne, kvalitetsgrind, MAX_ORD, MIN_ORD, type Grindresultat, type Tilltal } from "./grind.js";
import { bastaKontakt, sparaKontakter, utvinnKontakter } from "./kontakter.js";
import { valjFynd } from "./val.js";

export const UtkastSchema = z.object({
  brodtext: z.string(),
});

export interface Utkast {
  amne: string;
  brodtext: string;
  text: string; // brödtext + signatur + avslutsrad, det som skickas
  mottagare: string | null;
  fynd: FyndRad[];
  grind: Grindresultat;
}

export function signatur(): string {
  const k = konfig();
  const rader = [k.AVSANDARE_NAMN, "RK Kommunikation"];
  if (k.AVSANDARE_TELEFON) rader.push(k.AVSANDARE_TELEFON);
  rader.push(k.AVSANDARE_SAJT.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  return rader.join("\n");
}

export function avslutsrad(tilltal: Tilltal): string {
  return tilltal === "du"
    ? "Vill du inte att jag hör av mig igen räcker det att du svarar det."
    : "Vill ni inte att jag hör av mig igen räcker det att ni svarar det.";
}

export function sattIhop(brodtext: string, tilltal: Tilltal = "ni"): string {
  return `${brodtext.trim()}\n${signatur()}\n\n${avslutsrad(tilltal)}\n`;
}

/**
 * Tilltal och förnamn. Kundtypen styr när den finns: kundtyp 1 får förnamn och du, övriga ni.
 * Saknas kundtyp avgör profilen: du bara när personen är namngiven med rimlig säkerhet.
 */
export function tilltalFor(profil: Profil | null, kundtyp: number | null = null): { tilltal: Tilltal; fornamn: string | null } {
  const p = profil?.person;
  const fornamn = p?.fornamn ? p.fornamn.trim().split(/\s+/)[0] : null;
  if (kundtyp === 1) return { tilltal: "du", fornamn };
  if (kundtyp !== null && kundtyp > 1) return { tilltal: "ni", fornamn: null };
  if (p && p.drivs_av_namngiven_person && fornamn && p.sakerhet >= 0.7) return { tilltal: "du", fornamn };
  return { tilltal: "ni", fornamn: null };
}

/** Profilpunkter med hög säkerhet och utan gissning, det enda som får bli påståenden i mejlet. */
function sakraProfilpunkter(profil: Profil | null): Record<string, string> {
  if (!profil) return {};
  const ut: Record<string, string> = {};
  for (const [k, v] of Object.entries(profil)) {
    if (k === "borja_med" || k === "person") continue;
    const p = v as { varde: string; sakerhet: number; gissning: boolean };
    if (p && typeof p.varde === "string" && !p.gissning && p.sakerhet >= 0.7) ut[k] = p.varde;
  }
  return ut;
}

/**
 * Tillägg till mejlprompten när .env anger ett ordmål (MEJL_ORDMAL) eller en annan övre gräns än promptens 220.
 * Tom sträng när inget avviker.
 */
export function langdText(ordmal: number, maxOrd: number): string {
  if (ordmal <= 0 && maxOrd === MAX_ORD) return "";
  const mal = ordmal > 0 ? ordmal : Math.round((MIN_ORD + maxOrd) / 2);
  return `\n\n## Längd för den här körningen\n\nSikta på ${mal} ord i brödtexten, exemplet inräknat. Gränsen är ${MIN_ORD} till ${maxOrd} ord och gäller i stället för längdregeln ovan. Räkna orden innan du svarar och stryk hellre en bisats än att gå över.`;
}

/**
 * Tillägg till mejlprompten om meningen före erbjudandet (MEJL_FLER_FYND). flerFynd är antalet bekräftade fynd
 * som inte används i mejlet, eller null när inställningen är av. Meningen får bara skrivas när det finns fler fynd.
 */
export function flerFyndText(flerFynd: number | null): string {
  if (flerFynd === null) return "";
  if (flerFynd <= 0) {
    return "\n\n## Fler fynd\n\nDet finns inga fler bekräftade fynd än de som står i uppgifterna. Skriv inte att Rawaz såg fler saker som går att förbättra.";
  }
  return [
    "\n\n## Fler fynd",
    "",
    `Rawaz har ${flerFynd} bekräftade fynd till som inte tas upp i mejlet. Lägg omedelbart före erbjudandet om hjälp en egen mening med innebörden att han såg fler saker på sajten som går att förbättra och gärna berättar om dem i ett samtal. Nämn inte vad de handlar om och inget antal. Följ tilltalet och språkreglerna. Meningen ska vara skriven med egna ord för just det här mejlet: använd aldrig frasen "fler saker som går att förbättra" och skriv inte av exemplet. Exempel på nivå, inte en mall: "Det finns några saker till på sajten som jag hellre tar i ett samtal än i ett mejl."`,
  ].join("\n");
}

/** Systemprompten för mejlet: prompts/mejl.md med tilläggen för längd och fler fynd. Samma text i API-vägen och i passet. */
export function utkastSystem(flerFynd: number | null): string {
  const k = konfig();
  return lasPrompt("mejl") + langdText(k.MEJL_ORDMAL, k.MEJL_MAX_ORD) + flerFyndText(flerFynd);
}

/** Uppgifterna modellen får, som JSON-objekt. */
export function utkastUppgifter(
  p: Prospekt,
  fynd: FyndRad[],
  huvudinsikt: Huvudinsikt,
  profil: Profil | null,
  tilltal: { tilltal: Tilltal; fornamn: string | null },
  tidigareFel: string[] = [],
  flerFynd: number | null = null,
): Record<string, unknown> {
  const k = konfig();
  const inledning =
    k.SANDLAGE === "auto"
      ? "Rawaz har INTE sett sajten själv. Inledningen ska säga att han har gått igenom webbplatsen med sina granskningsverktyg."
      : "Rawaz läser utkastet innan det skickas. Inledningen får säga att han har tittat på webbplatsen.";
  return {
    organisation: { namn: p.namn, doman: p.doman, organisationstyp: p.organisationstyp, bransch: p.bransch, ort: p.ort },
    tilltal: tilltal.tilltal,
    fornamn: tilltal.fornamn,
    profil: sakraProfilpunkter(profil),
    huvudinsikt: huvudinsikt.text,
    avsandare: { namn: k.AVSANDARE_NAMN, sajt: "rkkommunikation.se", bokningslank: k.BOKNINGSLANK || null },
    inledning,
    fynd: fynd.map((f) => ({
      omrade: f.omrade,
      djup: f.djup,
      rubrik: f.rubrik,
      observation: f.observation,
      insikt: f.insikt,
      effekt: f.effekt,
      atgard: f.atgard,
      forslag_konkret: f.forslag_konkret,
      sida: f.belagg_url,
      belagg: f.belagg_varde,
    })),
    ...(k.MEJL_ORDMAL > 0 ? { ordmal: k.MEJL_ORDMAL } : {}),
    ...(flerFynd !== null ? { fler_bekraftade_fynd_utanfor_mejlet: flerFynd } : {}),
    ...(tidigareFel.length ? { foregaende_utkast_stoppades_pa_grund_av: tidigareFel } : {}),
  };
}

/** Texten modellen får tillsammans med systemprompten. */
export function utkastText(uppgifter: Record<string, unknown>): string {
  return `Uppgifter för mejlet i JSON:\n\n${JSON.stringify(uppgifter, null, 1)}`;
}

/** Skriver brödtexten med modellen kring huvudinsikten och de valda fynden. */
export async function skrivUtkast(
  d: Db,
  p: Prospekt,
  fynd: FyndRad[],
  huvudinsikt: Huvudinsikt,
  profil: Profil | null,
  tilltal: { tilltal: Tilltal; fornamn: string | null },
  tidigareFel: string[] = [],
  flerFynd: number | null = null,
): Promise<{ brodtext: string }> {
  const k = konfig();
  return strukturerat({
    d,
    prospektId: p.id,
    steg: "utkast",
    modell: k.MODEL_ANALYS,
    system: utkastSystem(flerFynd),
    innehall: [{ type: "text", text: utkastText(utkastUppgifter(p, fynd, huvudinsikt, profil, tilltal, tidigareFel, flerFynd)) }],
    schema: UtkastSchema,
    maxTokens: 4000,
    effort: "medium",
  });
}

export interface DraftAlternativ {
  testTill?: string; // skicka till den här adressen i stället för organisationens (testläge)
  forsok?: number;
}

/** Allt som behövs för att skriva och granska ett utkast, framtaget utan modell. */
export interface UtkastForberett {
  typ: "klar";
  valda: FyndRad[];
  huvudinsikt: Huvudinsikt;
  profil: Profil | null;
  tilltal: { tilltal: Tilltal; fornamn: string | null };
  amne: string;
  mottagare: string;
  bra: { text: string; url: string | null }[];
  /** Bekräftade fynd som inte används i mejlet, eller null när MEJL_FLER_FYND är av. */
  flerFynd: number | null;
  grindAlt: { testlage: boolean; huvudinsikt: string; profil: string; tilltal: Tilltal; flerFynd: number | null };
}

export type UtkastHinder = { typ: "redan_mejl" } | { typ: "inget_mejl"; orsak: string } | { typ: "ingen_adress" };

/**
 * Förberedelsen av utkastet: kontakter ur sparad HTML, val av fynd, tilltal, ämne och uppgifter.
 * Returnerar ett hinder när inget mejl ska skrivas. Ändrar inget i databasen utom kontakterna.
 */
export function forberedUtkast(d: Db, p: Prospekt, alt: DraftAlternativ = {}): UtkastForberett | UtkastHinder {
  const k = konfig();
  if (harFattMejl(d, p.id)) return { typ: "redan_mejl" };
  const fynd = fyndForProspekt(d, p.id, true);
  const huvudinsikt = p.huvudinsikt ? (JSON.parse(p.huvudinsikt) as Huvudinsikt) : null;
  const profil = p.profil ? (JSON.parse(p.profil) as Profil) : null;
  const val = valjFynd(fynd, huvudinsikt);
  if (val.orsak || !huvudinsikt) return { typ: "inget_mejl", orsak: val.orsak ?? "ingen huvudinsikt" };
  const valda = val.fynd;
  const bra = braForProspekt(d, p.id);

  // Kontakter
  const sidor = sidorForProspekt(d, p.id)
    .filter((s) => s.html_sokvag && fs.existsSync(s.html_sokvag))
    .map((s) => ({
      roll: s.roll,
      url: s.url,
      html: fs.readFileSync(s.html_sokvag!, "utf8"),
      text: s.text_sokvag && fs.existsSync(s.text_sokvag) ? fs.readFileSync(s.text_sokvag, "utf8") : "",
    }));
  const kontakter = utvinnKontakter(p.doman, sidor);
  sparaKontakter(d, p.id, kontakter);
  const kontakt = bastaKontakt(d, p.id);
  const mottagare = alt.testTill ?? kontakt?.adress ?? null;
  if (!mottagare) return { typ: "ingen_adress" };
  const tilltal = tilltalFor(profil, p.kundtyp);
  const amne = byggAmne(k.AMNESMALL, p.doman, p.namn);
  logg.info(`   mottagare: ${mottagare}${alt.testTill ? " (testläge)" : ` (${kontakt?.typ}, från ${kontakt?.kallsida})`}`);
  logg.info(`   tilltal: ${tilltal.tilltal}${tilltal.fornamn ? ` (${tilltal.fornamn})` : ""}, ämne: ${amne}`);
  logg.info(`   huvudinsikt: ${huvudinsikt.text}`);
  logg.info(`   fynd: ${valda.map((f) => `${f.fynd_id} ${f.omrade} djup ${f.djup}`).join(", ")}`);

  // Bekräftade fynd som inte används i mejlet, för meningen före erbjudandet (MEJL_FLER_FYND)
  const flerFynd = k.MEJL_FLER_FYND ? fynd.filter((f) => !valda.includes(f)).length : null;
  const grindAlt = { testlage: !!alt.testTill, huvudinsikt: huvudinsikt.text, profil: JSON.stringify(sakraProfilpunkter(profil)), tilltal: tilltal.tilltal, flerFynd };
  return { typ: "klar", valda, huvudinsikt, profil, tilltal, amne, mottagare, bra, flerFynd, grindAlt };
}

/** Loggar och sätter status för ett hinder, så som utkaststeget alltid har gjort. */
export function hanteraUtkastHinder(d: Db, p: Prospekt, h: UtkastHinder): void {
  if (h.typ === "redan_mejl") {
    logg.info("   har redan ett skickat eller köat förstamejl, inget nytt utkast");
  } else if (h.typ === "inget_mejl") {
    logg.info(`   inget mejl: ${h.orsak}. Läggs i granskningskön med rapporten.`);
    loggaHandelse(d, p.id, "utkast_hoppat", h.orsak);
    sattStatus(d, p.id, "i_granskning");
  } else {
    logg.info(`   ingen mejladress hittad på sajten, markeras endast_formular`);
    loggaHandelse(d, p.id, "endast_formular");
    d.prepare("UPDATE prospekt SET orsak_hoppad = 'endast_formular' WHERE id = ?").run(p.id);
  }
}

/** Sparar det färdiga utkastet med grindens utfall: mejlrad, status, händelse och fil i data/utkast. */
export function sparaUtkastResultat(d: Db, p: Prospekt, f: UtkastForberett, brodtext: string, grind: Grindresultat): Utkast {
  const text = sattIhop(brodtext, f.tilltal.tilltal);
  const status = grind.utfall === "stoppad" ? "utkast" : grind.utfall;
  d.prepare("DELETE FROM mejl WHERE prospekt_id = ? AND typ = 'forsta' AND status IN ('utkast', 'i_granskning')").run(p.id);
  d.prepare(
    "INSERT INTO mejl (prospekt_id, typ, mottagare, amne, text, anvanda_fynd, sakerhet, status) VALUES (?, 'forsta', ?, ?, ?, ?, ?, ?)",
  ).run(p.id, f.mottagare, f.amne, text, JSON.stringify(f.valda.map((x) => x.fynd_id)), grind.sakerhet, status);
  sattStatus(d, p.id, status === "utkast" ? "utkast" : status);
  loggaHandelse(d, p.id, "utkast_skapat", { status, fel: grind.fel, varningar: grind.varningar, sakerhet: grind.sakerhet, tilltal: f.tilltal.tilltal });

  const fil = path.join(dataMapp("utkast"), `${filnamnSaker(p.doman)}.txt`);
  fs.writeFileSync(fil, `Till: ${f.mottagare}\nÄmne: ${f.amne}\n\n${text}`, "utf8");
  logg.info(`   ${grind.godkand ? "godkänt av grinden" : `STOPPAT: ${grind.fel.join("; ")}`} -> status ${status}. Fil: ${fil}`);
  if (grind.varningar.length) logg.varning(`   ${grind.varningar.join("; ")}`);
  return { amne: f.amne, brodtext, text, mottagare: f.mottagare, fynd: f.valda, grind };
}

/** Hela utkaststeget för ett granskat prospekt: kontakter, val av fynd, utkast, kvalitetsgrind, sparande. */
export async function skapaUtkast(d: Db, p: Prospekt, alt: DraftAlternativ = {}): Promise<Utkast | null> {
  logg.info(`Utkast för ${p.doman} (#${p.id})`);
  const f = forberedUtkast(d, p, alt);
  if (f.typ !== "klar") {
    hanteraUtkastHinder(d, p, f);
    return null;
  }
  const forsok = alt.forsok ?? 2;
  let utkast = await skrivUtkast(d, p, f.valda, f.huvudinsikt, f.profil, f.tilltal, [], f.flerFynd);
  let grind = await kvalitetsgrind(d, p, { amne: f.amne, brodtext: utkast.brodtext }, f.valda, f.bra, f.mottagare, f.grindAlt);
  for (let i = 1; i < forsok && !grind.godkand; i++) {
    logg.info(`   grinden stoppade utkastet (${grind.fel.join("; ")}), nytt försök`);
    utkast = await skrivUtkast(d, p, f.valda, f.huvudinsikt, f.profil, f.tilltal, grind.fel, f.flerFynd);
    grind = await kvalitetsgrind(d, p, { amne: f.amne, brodtext: utkast.brodtext }, f.valda, f.bra, f.mottagare, f.grindAlt);
  }
  return sparaUtkastResultat(d, p, f, utkast.brodtext, grind);
}

export function rapportFor(p: Prospekt): string {
  return rapportSokvag(p.doman);
}
