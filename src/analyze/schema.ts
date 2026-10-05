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

/** Schema för ett fynd, exakt enligt avsnitt 7.4 i briefen. */
export const FyndSchema = z.object({
  id: z.string(),
  omrade: z.enum(["A", "B", "C", "D", "E", "F", "G", "H", "I"]),
  tjansteomrade: z.enum(TJANSTEOMRADEN),
  rubrik: z.string(),
  observation: z.string(),
  belagg: z.object({
    url: z.string(),
    typ: z.enum(BELAGG_TYPER),
    varde: z.string(),
  }),
  effekt: z.string(),
  atgard: z.string(),
  allvar: z.number(),
  sakerhet: z.number(),
  latt_att_forklara: z.number(),
});
export type Fynd = z.infer<typeof FyndSchema>;

export const AnalysSchema = z.object({
  organisationstyp: z.enum(ORGANISATIONSTYPER),
  organisationsnamn: z.string().nullable(),
  sammanfattning: z.string(),
  valskott: z.boolean(),
  bra: z.array(z.object({ text: z.string(), url: z.string().nullable() })),
  fynd: z.array(FyndSchema),
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
    sakerhet: Math.min(1, Math.max(0, f.sakerhet)),
    tjansteomrade: f.tjansteomrade,
  };
}
