import { z } from "zod";

export const OMRADEN = {
  A: { namn: "Budskap och första intryck", tjansteomrade: "strategi" },
  B: { namn: "Struktur och navigation", tjansteomrade: "webb" },
  C: { namn: "Innehåll och språk", tjansteomrade: "innehall" },
  D: { namn: "Synlighet i sök", tjansteomrade: "webb" },
  E: { namn: "Tillgänglighet", tjansteomrade: "webb" },
  F: { namn: "Prestanda och mobil", tjansteomrade: "webb" },
  G: { namn: "Förtroende och kontakt", tjansteomrade: "strategi" },
  H: { namn: "Vägen till handling", tjansteomrade: "strategi" },
  I: { namn: "Mätning och uppföljning", tjansteomrade: "analys" },
} as const;

export type Omrade = keyof typeof OMRADEN;
const OmradeSchema = z.enum(["A", "B", "C", "D", "E", "F", "G", "H", "I"]);

export const BELAGG_TYPER = ["matvarde", "citat", "saknat_element", "skarmbild", "statuskod"] as const;
export const TJANSTEOMRADEN = ["strategi", "innehall", "webb", "analys"] as const;
export const ORGANISATIONSTYPER = ["forening", "stiftelse", "aktiebolag", "enskild_firma", "annat", "okand"] as const;
export const INSATSER = ["liten", "medel", "stor"] as const;

export const BelaggSchema = z.object({
  url: z.string(),
  typ: z.enum(BELAGG_TYPER),
  varde: z.string(),
});
export type Belagg = z.infer<typeof BelaggSchema>;

/**
 * Ett fynd i den lätta analysen: bara det som behövs för ett sant och tydligt mejl. Observation på högst två
 * meningar, ett belägg med url, effekt på en mening, allvar 1 till 3 och ett konkret förslag när det finns ett
 * naturligt. Okända fält (från den fördjupade analysen eller äldre svar) tas bort vid tolkningen.
 */
export const FyndSchema = z.object({
  id: z.string(),
  omrade: OmradeSchema,
  rubrik: z.string(),
  observation: z.string(),
  belagg: BelaggSchema,
  effekt: z.string(),
  allvar: z.number(),
  forslag_konkret: z.string().nullable(),
});
export type Fynd = z.infer<typeof FyndSchema>;

export const PersonSchema = z.object({
  drivs_av_namngiven_person: z.boolean(),
  fornamn: z.string().nullable(),
  sakerhet: z.number(),
  belagg: z.string().nullable(),
});

/** En profilpunkt kan komma som text (lätta analysen) eller som objekt med varde (äldre analyser). Texten behålls. */
const Punkt = z.preprocess((v) => (v && typeof v === "object" && "varde" in (v as object) ? String((v as { varde: unknown }).varde ?? "") : v), z.string());

/** Den krympta profilen: namngiven person, vad de gör på en rad och vilken handling sajten vill leda till. */
export const ProfilSchema = z.object({
  person: PersonSchema,
  vad_de_gor: Punkt,
  huvudhandling: Punkt,
});
export type Profil = z.infer<typeof ProfilSchema>;

export const AnalysSchema = z.object({
  organisationstyp: z.enum(ORGANISATIONSTYPER),
  organisationsnamn: z.string().nullable(),
  profil: ProfilSchema,
  valskott: z.boolean(),
  fynd: z.array(FyndSchema),
});
export type Analys = z.infer<typeof AnalysSchema>;

/**
 * Verifieringens svar. bekraftat: alla faktapåståenden stämmer. delvis: något påstående stämmer inte eller går
 * inte att avgöra, det står i galler_inte och får inte användas, resten får användas. fel: kärnan motsägs.
 */
export const VerifieringSchema = z.object({
  bedomning: z.enum(["bekraftat", "delvis", "fel"]),
  motivering: z.string(),
  galler_inte: z.string().nullable(),
});
export type Verifiering = z.infer<typeof VerifieringSchema>;

// ---------- den fördjupade analysen (granskaren fordjupa), det som var standard till den 12 oktober 2026 ----------

const ProfilPunktFordjupad = z.object({
  varde: z.string(),
  sakerhet: z.number(),
  belagg: z.string().nullable(),
  gissning: z.boolean(),
});

export const ProfilFordjupadSchema = z.object({
  person: PersonSchema,
  vad_de_gor: ProfilPunktFordjupad,
  for_vem: ProfilPunktFordjupad,
  omrade: ProfilPunktFordjupad,
  syfte: ProfilPunktFordjupad,
  huvudhandling: ProfilPunktFordjupad,
  skiljer_sig: ProfilPunktFordjupad,
  ton: ProfilPunktFordjupad,
});

export const FyndFordjupadSchema = FyndSchema.extend({
  tjansteomrade: z.enum(TJANSTEOMRADEN),
  belagg2: BelaggSchema.nullable(),
  atgard: z.string(),
  sakerhet: z.number(),
  latt_att_forklara: z.number(),
  djup: z.number(),
  insikt: z.string(),
  rotorsak: z.string().nullable(),
  insats: z.enum(INSATSER),
  kopplar_till_syfte: z.boolean(),
});
export type FyndFordjupad = z.infer<typeof FyndFordjupadSchema>;

export const HuvudinsiktSchema = z.object({
  text: z.string(),
  fynd_ids: z.array(z.string()),
});
export type Huvudinsikt = z.infer<typeof HuvudinsiktSchema>;

export const AnalysFordjupadSchema = z.object({
  organisationstyp: z.enum(ORGANISATIONSTYPER),
  organisationsnamn: z.string().nullable(),
  profil: ProfilFordjupadSchema,
  sammanfattning: z.string(),
  valskott: z.boolean(),
  bra: z.array(z.object({ text: z.string(), url: z.string().nullable() })),
  fynd: z.array(FyndFordjupadSchema),
  huvudinsikt: HuvudinsiktSchema.nullable(),
  borja_med: z.array(z.object({ atgard: z.string(), insats: z.enum(INSATSER), effekt: z.string() })),
});
export type AnalysFordjupad = z.infer<typeof AnalysFordjupadSchema>;

/**
 * Det konkreta förslaget ska vara ren text på en rad: tar bort etiketter som "Huvudrubrik:",
 * omgivande citattecken och en avslutande förklaring efter punkt om förslaget är en rubrik.
 */
export function stadaForslag(s: string | null | undefined): string | null {
  if (!s) return null;
  let t = s.trim().split(/\r?\n/)[0].trim();
  t = t.replace(/^(huvudrubrik|rubrik|sidtitel|titel|knapp|knapptext|exempel|f[öo]rslag|ingress|f[öo]rsta mening(en)?)\s*:\s*/i, "");
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  // "X. Under rubriken en länk: Y" -> behåll bara X när resten är en förklaring med kolon
  const delar = t.split(/\.\s+(?=[A-ZÅÄÖ])/);
  if (delar.length > 1 && /:/.test(delar.slice(1).join(" "))) t = delar[0];
  return t.replace(/\.$/, "").trim() || null;
}

/** Begränsar allvar till 1 till 3 och städar förslaget efter att modellen svarat. */
export function stadaFynd<F extends Fynd>(f: F): F {
  const heltal = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)));
  return { ...f, allvar: heltal(f.allvar, 1, 3), forslag_konkret: stadaForslag(f.forslag_konkret) };
}
