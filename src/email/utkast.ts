import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { lasPrompt, strukturerat } from "../analyze/klient.js";
import type { Profil } from "../analyze/schema.js";
import { konfig, PROMPT_DIR } from "../config.js";
import type { Db } from "../db/index.js";
import { braForProspekt, fyndForProspekt, harFattMejl, loggaHandelse, sattStatus, sidorForProspekt, type FyndRad, type Prospekt } from "../db/fragor.js";
import { profilText, rapportSokvag, underlagSokvag } from "../report/rapport.js";
import type { Underlag } from "../analyze/underlag.js";
import { dataMapp, filnamnSaker, lasJson } from "../util/fil.js";
import { logg } from "../util/logg.js";
import { byggFaktakallor, medPresentation, PRESENTATION, type Faktakallor } from "./fakta.js";
import { byggAmne, kvalitetsgrind, lasForbjudnaFraser, MAX_ORD, MIN_ORD, type Grindresultat, type Tilltal } from "./grind.js";
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
  return tilltal === "du" ? "Vill du inte att jag hör av mig igen räcker det att du svarar det." : "Vill ni inte att jag hör av mig igen räcker det att ni svarar det.";
}

export function sattIhop(brodtext: string, tilltal: Tilltal = "ni"): string {
  return `${brodtext.trim()}\n${signatur()}\n\n${avslutsrad(tilltal)}\n`;
}

/** Profilen så som den ligger i databasen: den lätta analysens text eller äldre analysers objekt med varde. */
export type SparadProfil = { person?: Profil["person"]; vad_de_gor?: unknown; huvudhandling?: unknown } & Record<string, unknown>;

/**
 * Tilltal och förnamn. Kundtypen styr när den finns: kundtyp 1 får förnamn och du när ett förnamn finns, annars ni
 * (ett bolag utan namngiven person hälsas med Hej). Övriga kundtyper får ni. Saknas kundtyp avgör profilen.
 */
export function tilltalFor(profil: SparadProfil | null, kundtyp: number | null = null): { tilltal: Tilltal; fornamn: string | null } {
  const p = profil?.person;
  const fornamn = p?.fornamn ? p.fornamn.trim().split(/\s+/)[0] : null;
  if (kundtyp === 1) return fornamn ? { tilltal: "du", fornamn } : { tilltal: "ni", fornamn: null };
  if (kundtyp !== null && kundtyp > 1) return { tilltal: "ni", fornamn: null };
  if (p && p.drivs_av_namngiven_person && fornamn && p.sakerhet >= 0.7) return { tilltal: "du", fornamn };
  return { tilltal: "ni", fornamn: null };
}

/** Profilpunkterna som får bli påståenden i mejlet: vad de gör och vilken handling sajten vill leda till. */
export function sakraProfilpunkter(profil: SparadProfil | null): Record<string, string> {
  if (!profil) return {};
  const ut: Record<string, string> = {};
  for (const [k, v] of Object.entries(profil)) {
    if (k === "borja_med" || k === "person") continue;
    const text = profilText(v);
    if (text) ut[k] = text;
  }
  return ut;
}

/** Tillägg till mejlprompten när .env anger ett annat ordmål eller en annan övre gräns än promptens. Tom sträng när inget avviker. */
export function langdText(ordmal: number, maxOrd: number): string {
  if (ordmal <= 0 && maxOrd === MAX_ORD) return "";
  const mal = ordmal > 0 ? ordmal : Math.round((MIN_ORD + maxOrd) / 2);
  return `\n\n## Längd för den här körningen\n\nSikta på ${mal} ord i brödtexten, exemplet inräknat. Gränsen är ${MIN_ORD} till ${maxOrd} ord och gäller i stället för längdregeln ovan. Räkna orden innan du svarar och stryk hellre en bisats än att gå över.`;
}

/**
 * Tillägg till mejlprompten när MEJL_FLER_FYND är på: programmet lägger självt till meningen om fler fynd, så
 * modellen ska inte skriva någon sådan mening. flerFynd är antalet bekräftade fynd som inte används i mejlet,
 * eller null när inställningen är av.
 */
export function flerFyndText(flerFynd: number | null): string {
  if (flerFynd === null) return "";
  return "\n\n## Fler fynd\n\nSkriv inte att Rawaz såg fler saker på sajten som går att förbättra. Finns det fler bekräftade fynd lägger programmet självt till en mening om det före erbjudandet, och den räknas inte i ordgränsen.";
}

export interface FlerFyndMeningar {
  /** Pluralvarianterna, används när minst två bekräftade fynd står utanför mejlet. */
  flera: string[];
  /** Singularvarianterna, används när exakt ett bekräftat fynd står utanför mejlet. */
  ett: string[];
}

/**
 * Läser prompts/fler-fynd.md: rubrikerna "## du" och "## ni" följda av pluralvarianter på rader som börjar med "- ",
 * och "## du, ett fynd" respektive "## ni, ett fynd" för singularvarianten.
 */
export function lasFlerFyndMeningar(): Record<Tilltal, FlerFyndMeningar> {
  const ut: Record<Tilltal, FlerFyndMeningar> = { du: { flera: [], ett: [] }, ni: { flera: [], ett: [] } };
  const fil = path.join(PROMPT_DIR, "fler-fynd.md");
  if (!fs.existsSync(fil)) return ut;
  let aktuell: string[] | null = null;
  for (const rad of fs.readFileSync(fil, "utf8").split(/\r?\n/)) {
    const r = rad.trim();
    const rubrik = r.match(/^##\s+(du|ni)\b(.*)$/i);
    if (rubrik) aktuell = ut[rubrik[1].toLowerCase() as Tilltal][/ett fynd/i.test(rubrik[2]) ? "ett" : "flera"];
    else if (r.startsWith("#")) aktuell = null;
    else if (aktuell && r.startsWith("- ")) aktuell.push(r.slice(2).trim());
  }
  return ut;
}

/**
 * Den fasta meningen om fler fynd för ett prospekt. antal är antalet bekräftade fynd utanför mejlet: vid ett används
 * singularvarianten, vid minst två en pluralvariant vald utifrån prospektets id, så att omtag ger samma mening.
 */
export function flerFyndMening(tilltal: Tilltal, prospektId: number, antal: number): string | null {
  if (antal < 1) return null;
  const m = lasFlerFyndMeningar()[tilltal];
  const varianter = antal === 1 ? m.ett : m.flera;
  if (!varianter.length) return null;
  return varianter[Math.abs(prospektId) % varianter.length];
}

/**
 * Lägger den fasta meningen om fler fynd som ett eget stycke omedelbart före erbjudandet (stycket som nämner
 * rkkommunikation.se). Finns inget sådant stycke läggs den före hälsningsfrasen. Görs efter grinden, så meningen
 * räknas inte i ordgränsen och prövas inte av tonkontrollen.
 */
export function medFlerFynd(brodtext: string, mening: string | null): string {
  if (!mening) return brodtext;
  const delar = brodtext.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  let i = delar.findIndex((d) => /rkkommunikation\.se/i.test(d));
  if (i < 0) i = Math.max(0, delar.length - 1);
  delar.splice(i, 0, mening);
  return delar.join("\n\n");
}

/** Systemprompten för mejlet: prompts/mejl.md med tilläggen för längd och fler fynd. Samma text i passet och i API-vägen. */
export function utkastSystem(flerFynd: number | null): string {
  const k = konfig();
  const forbjudna = lasForbjudnaFraser();
  const fraser = forbjudna.length ? `\n\n## Förbjudna fraser\n\nDe här fraserna får inte förekomma någonstans i mejlet, programmet stoppar annars utkastet:\n${forbjudna.map((f) => `- ${f}`).join("\n")}` : "";
  return lasPrompt("mejl") + fraser + langdText(k.MEJL_ORDMAL, k.MEJL_MAX_ORD) + flerFyndText(flerFynd);
}

/** Uppgifterna modellen får, som JSON-objekt. Huvudfyndet har roll huvudpoäng, påståenden i galler_inte får inte användas. */
export function utkastUppgifter(
  p: Prospekt,
  fynd: FyndRad[],
  profil: SparadProfil | null,
  tilltal: { tilltal: Tilltal; fornamn: string | null },
  tidigareFel: string[] = [],
  flerFynd: number | null = null,
  huvudfynd: string | null = null,
): Record<string, unknown> {
  const k = konfig();
  const inledning = `Första stycket: programmet skriver "${PRESENTATION}". Du skriver en enda mening till i det stycket: "Jag har gått igenom ${tilltal.tilltal === "du" ? "din" : "er"} webbplats och har några förslag som jag tror kan ge ${tilltal.tilltal === "du" ? "dig" : "er"} fler ..." med ett vanligt ord för det verksamheten vill ha. Nämn aldrig verktyg och beskriv inte verksamheten.`;
  const huvud = huvudfynd ?? fynd[0]?.fynd_id ?? null;
  const gallerInte = fynd.filter((f) => f.galler_inte).map((f) => `${f.fynd_id}: ${f.galler_inte}`);
  return {
    organisation: { namn: p.namn, doman: p.doman, organisationstyp: p.organisationstyp, bransch: p.bransch, ort: p.ort },
    tilltal: tilltal.tilltal,
    fornamn: tilltal.fornamn,
    profil: sakraProfilpunkter(profil),
    avsandare: { namn: k.AVSANDARE_NAMN, sajt: "rkkommunikation.se", bokningslank: k.BOKNINGSLANK || null },
    inledning,
    huvudpoang: huvud ? `Mejlet öppnar med fyndet ${huvud}, det med roll huvudpoäng. Andra stycket handlar bara om det fyndet.` : null,
    ...(gallerInte.length ? { far_inte_anvandas: `Verifieringen underkände de här påståendena. De får inte förekomma i mejlet, inte heller omskrivna, och inga siffror eller namn ur dem: ${gallerInte.join(" | ")}` } : {}),
    exempel: fynd.some((f) => f.forslag_konkret) ? "Ett av fynden har forslag_konkret. Återge det exakt på en egen rad som exempel." : "Inget av fynden har ett konkret förslag. Skriv inget exempel på egen rad och hitta inte på något.",
    fynd: fynd.map((f) => ({
      fynd_id: f.fynd_id,
      roll: f.fynd_id === huvud ? "huvudpoäng" : "stöd",
      omrade: f.omrade,
      allvar: f.allvar,
      rubrik: f.rubrik,
      observation: f.observation,
      effekt: f.effekt,
      forslag_konkret: f.forslag_konkret,
      sida: f.belagg_url,
      belagg: f.belagg_varde,
      ...(f.galler_inte ? { galler_inte: f.galler_inte } : {}),
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

/** Skriver brödtexten med modellen via API. Används inte i driften. */
export async function skrivUtkast(
  d: Db,
  p: Prospekt,
  fynd: FyndRad[],
  profil: SparadProfil | null,
  tilltal: { tilltal: Tilltal; fornamn: string | null },
  tidigareFel: string[] = [],
  flerFynd: number | null = null,
  huvudfynd: string | null = null,
): Promise<{ brodtext: string }> {
  const k = konfig();
  return strukturerat({
    d,
    prospektId: p.id,
    steg: "utkast",
    modell: k.MODEL_ANALYS,
    system: utkastSystem(flerFynd),
    innehall: [{ type: "text", text: utkastText(utkastUppgifter(p, fynd, profil, tilltal, tidigareFel, flerFynd, huvudfynd)) }],
    schema: UtkastSchema,
    maxTokens: 4000,
    effort: "medium",
  });
}

export interface DraftAlternativ {
  testTill?: string; // skicka till den här adressen i stället för organisationens (testläge)
  forsok?: number;
  /** Skriv om utkastet även om prospektet redan har ett köat eller skickat mejl. Används när mejl skrivs om efter en regeländring, mot en kopia eller för ej skickade mejl. */
  igen?: boolean;
}

/** Allt som behövs för att skriva och granska ett utkast, framtaget utan modell. */
export interface UtkastForberett {
  typ: "klar";
  valda: FyndRad[];
  profil: SparadProfil | null;
  tilltal: { tilltal: Tilltal; fornamn: string | null };
  amne: string;
  mottagare: string;
  bra: { text: string; url: string | null }[];
  /** Bekräftade fynd som inte används i mejlet, eller null när MEJL_FLER_FYND är av. */
  flerFynd: number | null;
  /** fynd_id för huvudfyndet, det mejlet öppnar med. Står först i valda. */
  huvudfynd: string;
  grindAlt: { testlage: boolean; profil: string; tilltal: Tilltal; flerFynd: number | null; kallor: Faktakallor; huvudfynd: string; gallerInte: (string | null)[] };
}

export type UtkastHinder = { typ: "redan_mejl" } | { typ: "inget_mejl"; orsak: string } | { typ: "ingen_adress" };

/**
 * Förberedelsen av utkastet: kontakter ur sparad HTML, val av fynd, tilltal, ämne och uppgifter.
 * Returnerar ett hinder när inget mejl ska skrivas. Ändrar inget i databasen utom kontakterna.
 */
export function forberedUtkast(d: Db, p: Prospekt, alt: DraftAlternativ = {}): UtkastForberett | UtkastHinder {
  const k = konfig();
  if (!alt.igen && harFattMejl(d, p.id)) return { typ: "redan_mejl" };
  const fynd = fyndForProspekt(d, p.id, true);
  const profil = p.profil ? (JSON.parse(p.profil) as SparadProfil) : null;
  const val = valjFynd(fynd);
  if (val.orsak || !val.huvud) return { typ: "inget_mejl", orsak: val.orsak ?? "inget huvudfynd" };
  const valda = val.fynd;
  const huvudfynd = val.huvud.fynd_id;
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
  logg.info(`   fynd: ${valda.map((f) => `${f.fynd_id} ${f.omrade} allvar ${f.allvar}`).join(", ")}, huvudpoäng ${huvudfynd}`);

  // Bekräftade fynd som inte används i mejlet, för den fasta meningen före erbjudandet (MEJL_FLER_FYND)
  const flerFynd = k.MEJL_FLER_FYND ? fynd.filter((f) => !valda.includes(f)).length : null;
  // Källor för faktaspårningen: alla bekräftade fynd, profilpunkter och de kodräknade måtten
  const underlagFil = underlagSokvag(p.doman);
  const underlag = fs.existsSync(underlagFil) ? lasJson<Underlag>(underlagFil) : null;
  const kallor = byggFaktakallor(p, fynd, profil as Profil | null, underlag);
  const grindAlt = { testlage: !!alt.testTill || !!alt.igen, profil: JSON.stringify(sakraProfilpunkter(profil)), tilltal: tilltal.tilltal, flerFynd, kallor, huvudfynd, gallerInte: valda.map((f) => f.galler_inte) };
  return { typ: "klar", valda, profil, tilltal, amne, mottagare, bra, flerFynd, huvudfynd, grindAlt };
}

/**
 * Sätter ihop modellens brödtext med den fasta presentationen. Fel (modellen skrev presentationen själv,
 * hälsning saknas) läggs till grindens fel så att utkastet görs om.
 */
export function sammansattBrodtext(raw: string): { brodtext: string; fel: string[] } {
  return medPresentation(raw);
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
  const medFler = f.flerFynd && f.flerFynd > 0 ? medFlerFynd(brodtext, flerFyndMening(f.tilltal.tilltal, p.id, f.flerFynd)) : brodtext;
  const text = sattIhop(medFler, f.tilltal.tilltal);
  const status = grind.utfall === "stoppad" ? "utkast" : grind.utfall;
  d.prepare("DELETE FROM mejl WHERE prospekt_id = ? AND typ = 'forsta' AND status IN ('utkast', 'i_granskning')").run(p.id);
  d.prepare("INSERT INTO mejl (prospekt_id, typ, mottagare, amne, text, anvanda_fynd, sakerhet, status) VALUES (?, 'forsta', ?, ?, ?, ?, ?, ?)").run(
    p.id,
    f.mottagare,
    f.amne,
    text,
    JSON.stringify(f.valda.map((x) => x.fynd_id)),
    grind.sakerhet,
    status,
  );
  sattStatus(d, p.id, status === "utkast" ? "utkast" : status);
  loggaHandelse(d, p.id, "utkast_skapat", { status, fel: grind.fel, varningar: grind.varningar, sakerhet: grind.sakerhet, tilltal: f.tilltal.tilltal });

  const fil = path.join(dataMapp("utkast"), `${filnamnSaker(p.doman)}.txt`);
  fs.writeFileSync(fil, `Till: ${f.mottagare}\nÄmne: ${f.amne}\n\n${text}`, "utf8");
  logg.info(`   ${grind.godkand ? "godkänt av grinden" : `STOPPAT: ${grind.fel.join("; ")}`} -> status ${status}. Fil: ${fil}`);
  if (grind.varningar.length) logg.varning(`   ${grind.varningar.join("; ")}`);
  return { amne: f.amne, brodtext: medFler, text, mottagare: f.mottagare, fynd: f.valda, grind };
}

/** Hela utkaststeget via API för ett granskat prospekt. Används inte i driften. */
export async function skapaUtkast(d: Db, p: Prospekt, alt: DraftAlternativ = {}): Promise<Utkast | null> {
  logg.info(`Utkast för ${p.doman} (#${p.id})`);
  const f = forberedUtkast(d, p, alt);
  if (f.typ !== "klar") {
    hanteraUtkastHinder(d, p, f);
    return null;
  }
  const forsok = alt.forsok ?? 2;
  let utkast = sammansattBrodtext((await skrivUtkast(d, p, f.valda, f.profil, f.tilltal, [], f.flerFynd, f.huvudfynd)).brodtext);
  let grind = await kvalitetsgrind(d, p, { amne: f.amne, brodtext: utkast.brodtext }, f.valda, f.bra, f.mottagare, { ...f.grindAlt, extraFel: utkast.fel });
  for (let i = 1; i < forsok && !grind.godkand; i++) {
    logg.info(`   grinden stoppade utkastet (${grind.fel.join("; ")}), nytt försök`);
    utkast = sammansattBrodtext((await skrivUtkast(d, p, f.valda, f.profil, f.tilltal, grind.fel, f.flerFynd, f.huvudfynd)).brodtext);
    grind = await kvalitetsgrind(d, p, { amne: f.amne, brodtext: utkast.brodtext }, f.valda, f.bra, f.mottagare, { ...f.grindAlt, extraFel: utkast.fel });
  }
  return sparaUtkastResultat(d, p, f, utkast.brodtext, grind);
}

export function rapportFor(p: Prospekt): string {
  return rapportSokvag(p.doman);
}
