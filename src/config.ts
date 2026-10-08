import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROT = path.resolve(here, "..");
export const DATA_DIR = path.join(ROT, "data");
export const PROMPT_DIR = path.join(ROT, "prompts");

const bool = z
  .string()
  .optional()
  .transform((v) => (v ?? "").trim().toLowerCase() === "true");

const heltal = (standard: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? Number.parseInt(v, 10) : standard))
    .pipe(z.number().int().nonnegative());

const decimal = (standard: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? Number.parseFloat(v) : standard))
    .pipe(z.number().min(0).max(1));

const klockslag = z.string().regex(/^\d{2}:\d{2}$/, "Formatet är HH:MM");

const belopp = (standard: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? Number.parseFloat(v.replace(",", ".")) : standard))
    .pipe(z.number().nonnegative("Beloppet kan inte vara negativt"));

const schema = z.object({
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  /** Analys, utkast, segment och likhetsprofil. */
  MODEL_ANALYS: z.string().min(1, "MODEL_ANALYS saknas i .env"),
  /** Verifiering, förfilter och grind. */
  MODEL_SNABB: z.string().min(1, "MODEL_SNABB saknas i .env"),
  /** Webbsökningen i discover. Tom betyder samma som MODEL_ANALYS. */
  MODEL_DISCOVER: z.string().optional().default(""),
  /** Kostnadstak per kalendermånad i USD enligt tabellen kostnader. 0 betyder inget tak. Körningar avbryts när det nås. */
  MAX_KOSTNAD_PER_MANAD: belopp(0),

  /** Högsta antal fynd analysen tar fram per sajt. 6 är prompten som den är skriven, 4 ger kortare och billigare analys. */
  ANALYS_MAX_FYND: heltal(6),
  /** true slår ihop observation, insikt och rotorsak till ett fält på högst två meningar. */
  ANALYS_KORT: bool,
  /** true kör analysen om på MODEL_UPPTRAPPNING när huvudinsikt saknas, inget bekräftat fynd har djup 3 eller färre än tre fynd bekräftas. */
  UPPTRAPPNING: bool,
  MODEL_UPPTRAPPNING: z.string().optional().default("claude-opus-5-5"),

  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: heltal(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  IMAP_HOST: z.string().optional().default(""),
  IMAP_PORT: heltal(993),

  AVSANDARE_NAMN: z.string().optional().default("Rawaz Karim"),
  AVSANDARE_EPOST: z.string().optional().default(""),
  AVSANDARE_TELEFON: z.string().optional().default(""),
  AVSANDARE_SAJT: z.string().optional().default("https://rkkommunikation.se"),
  BOKNINGSLANK: z.string().optional().default(""),
  /** Ämnesrad. {domän} byts mot domänen utan www, {namn} mot organisationens namn. Över 60 tecken används namnet. */
  AMNESMALL: z.string().optional().default("Några förslag för {domän}"),

  SANDLAGE: z.enum(["granska", "auto"]).optional().default("granska"),
  TORRKORNING: bool,
  MAX_MEJL_PER_DAG: heltal(8),
  SANDFONSTER_START: klockslag.optional().default("08:30"),
  SANDFONSTER_SLUT: klockslag.optional().default("15:30"),
  MIN_SAKERHET_AUTO: decimal(0.85),
  UPPFOLJNING_AKTIV: bool,
  UPPFOLJNING_EFTER_ARBETSDAGAR: heltal(7),

  /** Paus mellan mejl i minuter, slumpas mellan min och max. */
  PAUS_MIN_MINUTER: heltal(4),
  PAUS_MAX_MINUTER: heltal(15),
  /** Hur många nya prospekt run letar upp åt gången när kön är tom. */
  DISCOVER_ANTAL: heltal(10),

  MAX_SIDOR_PER_SAJT: heltal(8),
  PAUS_MELLAN_SIDOR_MS: heltal(2000),
});

export type Konfig = z.infer<typeof schema>;

let cache: Konfig | undefined;

/** Läser och validerar .env. Kastar ett tydligt fel om något saknas. */
export function konfig(): Konfig {
  if (cache) return cache;
  const resultat = schema.safeParse(process.env);
  if (!resultat.success) {
    const rader = resultat.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Fel i .env:\n${rader.join("\n")}\nSe .env.example.`);
  }
  // TORRKORNING saknas helt => säkert standardvärde är true.
  if (process.env.TORRKORNING === undefined) resultat.data.TORRKORNING = true;
  if (!resultat.data.MODEL_DISCOVER.trim()) resultat.data.MODEL_DISCOVER = resultat.data.MODEL_ANALYS;
  if (resultat.data.MAX_SIDOR_PER_SAJT > 8) resultat.data.MAX_SIDOR_PER_SAJT = 8;
  resultat.data.ANALYS_MAX_FYND = Math.min(8, Math.max(2, resultat.data.ANALYS_MAX_FYND));
  if (resultat.data.PAUS_MELLAN_SIDOR_MS < 2000) resultat.data.PAUS_MELLAN_SIDOR_MS = 2000;
  cache = resultat.data;
  return cache;
}

export const USER_AGENT =
  "Mozilla/5.0 (compatible; granskaren/0.1; +https://rkkommunikation.se) Chrome/120 Safari/537.36";
