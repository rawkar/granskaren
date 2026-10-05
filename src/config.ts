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

const schema = z.object({
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  MODEL_ANALYS: z.string().min(1, "MODEL_ANALYS saknas i .env"),
  MODEL_SNABB: z.string().min(1, "MODEL_SNABB saknas i .env"),

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

  SANDLAGE: z.enum(["granska", "auto"]).optional().default("granska"),
  TORRKORNING: bool,
  MAX_MEJL_PER_DAG: heltal(8),
  SANDFONSTER_START: klockslag.optional().default("08:30"),
  SANDFONSTER_SLUT: klockslag.optional().default("15:30"),
  MIN_SAKERHET_AUTO: decimal(0.85),
  UPPFOLJNING_AKTIV: bool,
  UPPFOLJNING_EFTER_ARBETSDAGAR: heltal(7),

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
  if (resultat.data.MAX_SIDOR_PER_SAJT > 8) resultat.data.MAX_SIDOR_PER_SAJT = 8;
  if (resultat.data.PAUS_MELLAN_SIDOR_MS < 2000) resultat.data.PAUS_MELLAN_SIDOR_MS = 2000;
  cache = resultat.data;
  return cache;
}

export const USER_AGENT =
  "Mozilla/5.0 (compatible; granskaren/0.1; +https://rkkommunikation.se) Chrome/120 Safari/537.36";
