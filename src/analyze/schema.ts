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

/** Schema för ett fynd: fälten från ursprungsbriefen plus djup, insikt, förslag och insats från tillägget. */
export const FyndSchema = z.object({
  id: z.string(),
  omrade: z.enum(["A", "B", "C", "D", "E", "F", "G", "H", "I"]),
  tjansteomrade: z.enum(TJANSTEOMRADEN),
  rubrik: z.string(),
  observation: z.string(),
  belagg: BelaggSchema,
  belagg2: BelaggSchema.nullable(),
  effekt: z.string(),
  atgard: z.string(),
  allvar: z.number(),
  sakerhet: z.number(),
  latt_att_forklara: z.number(),
  djup: z.number(),
  insikt: z.string(),
  rotorsak: z.string().nullable(),
  forslag_konkret: z.string().nullable(),
  insats: z.enum(INSATSER),
  kopplar_till_syfte: z.boolean(),
});
export type Fynd = z.infer<typeof FyndSchema>;

const ProfilPunkt = z.object({
  varde: z.string(),
  sakerhet: z.number(),
  belagg: z.string().nullable(),
  gissning: z.boolean(),
});

export const PersonSchema = z.object({
  drivs_av_namngiven_person: z.boolean(),
  fornamn: z.string().nullable(),
  sakerhet: z.number(),
  belagg: z.string().nullable(),
});

export const ProfilSchema = z.object({
  person: PersonSchema,
  vad_de_gor: ProfilPunkt,
  for_vem: ProfilPunkt,
  omrade: ProfilPunkt,
  syfte: ProfilPunkt,
  huvudhandling: ProfilPunkt,
  skiljer_sig: ProfilPunkt,
  ton: ProfilPunkt,
});
export type Profil = z.infer<typeof ProfilSchema>;

export const HuvudinsiktSchema = z.object({
  text: z.string(),
  fynd_ids: z.array(z.string()),
});
export type Huvudinsikt = z.infer<typeof HuvudinsiktSchema>;

export const AnalysSchema = z.object({
  organisationstyp: z.enum(ORGANISATIONSTYPER),
  organisationsnamn: z.string().nullable(),
  profil: ProfilSchema,
  sammanfattning: z.string(),
  valskott: z.boolean(),
  bra: z.array(z.object({ text: z.string(), url: z.string().nullable() })),
  fynd: z.array(FyndSchema),
  huvudinsikt: HuvudinsiktSchema.nullable(),
  borja_med: z.array(z.object({ atgard: z.string(), insats: z.enum(INSATSER), effekt: z.string() })),
});
export type Analys = z.infer<typeof AnalysSchema>;

export const VerifieringSchema = z.object({
  bedomning: z.enum(["bekraftat", "osakert", "fel"]),
  motivering: z.string(),
});
export type Verifiering = z.infer<typeof VerifieringSchema>;

/** Begränsar numeriska fält till tillåtna intervall efter att modellen svarat. */
export function stadaFynd(f: Fynd): Fynd {
  const heltal = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));
  return {
    ...f,
    allvar: heltal(f.allvar, 1, 3),
    latt_att_forklara: heltal(f.latt_att_forklara, 1, 3),
    djup: heltal(f.djup, 1, 3),
    sakerhet: Math.min(1, Math.max(0, f.sakerhet)),
    forslag_konkret: f.forslag_konkret?.trim() || null,
    rotorsak: f.rotorsak?.trim() || null,
  };
}
