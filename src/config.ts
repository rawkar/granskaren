import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROT = path.resolve(here, "..");
/** Datamappen. GRANSKAREN_DATA i miljön pekar om den, till exempel för ett test mot en kopia. */
export const DATA_DIR = process.env.GRANSKAREN_DATA ? path.resolve(process.env.GRANSKAREN_DATA) : path.join(ROT, "data");
export const PROMPT_DIR = path.join(ROT, "prompts");

/**
 * Läser .env utan att skriva över variabler som redan finns i miljön. Driften går bara via sessionen (granskaren
 * pass och /dagens). ANTHROPIC_API_KEY läses aldrig in och tas bort ur miljön om inte TILLAT_API=true är satt.
 */
function lasEnv(): void {
  const fil = path.join(ROT, ".env");
  if (!fs.existsSync(fil)) return;
  const parsed = dotenv.parse(fs.readFileSync(fil, "utf8"));
  const tillatApi = (process.env.TILLAT_API ?? parsed.TILLAT_API ?? "false").trim().toLowerCase() === "true";
  for (const [kk, v] of Object.entries(parsed)) {
    if (kk === "ANTHROPIC_API_KEY" && !tillatApi) continue;
    if (process.env[kk] === undefined) process.env[kk] = v;
  }
  if (!tillatApi) delete process.env.ANTHROPIC_API_KEY;
}
lasEnv();

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
  /** false: API-klienten vägrar starta och nyckeln läses aldrig in. Driften går via sessionen. true bara för ett medvetet undantag. */
  TILLAT_API: bool,
  /** session: modellstegen görs av underagenter i en Claude-session (granskaren pass). api: via Anthropic-API:et, kräver TILLAT_API=true. */
  MODELLVAG: z.enum(["api", "session"]).optional().default("session"),
  /** Analys, utkast, segment och likhetsprofil. */
  MODEL_ANALYS: z.string().min(1, "MODEL_ANALYS saknas i .env"),
  /** Verifiering, förfilter och grind. */
  MODEL_SNABB: z.string().min(1, "MODEL_SNABB saknas i .env"),
  /** Webbsökningen i discover. Tom betyder samma som MODEL_ANALYS. */
  MODEL_DISCOVER: z.string().optional().default(""),
  /** Kostnadstak per kalendermånad i USD enligt tabellen kostnader. 0 betyder inget tak. Körningar avbryts när det nås. */
  MAX_KOSTNAD_PER_MANAD: belopp(0),

  /** Ordmål för brödtexten som skickas med till modellen. 0 betyder promptens eget mål. */
  MEJL_ORDMAL: heltal(150),
  /** Grindens övre ordgräns för brödtexten. */
  MEJL_MAX_ORD: heltal(190),
  /** true lägger till en mening före erbjudandet om att Rawaz såg fler saker, bara när det finns bekräftade fynd utanför mejlet. */
  MEJL_FLER_FYND: bool,
  /** Livslängd på cachen för systemprompten. 1h lönar sig när sajterna ligger mer än fem minuter isär. */
  CACHE_TTL: z.enum(["5m", "1h"]).optional().default("5m"),
  /** Dagen ändringarna slogs på, YYYY-MM-DD. Styr veckorapportens jämförelse med Opus-perioden och kvalitetsvakten. Tom stänger av båda. */
  ANDRINGAR_FRAN: z
    .string()
    .optional()
    .default("")
    .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), "Formatet är YYYY-MM-DD"),

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
  /** true pausar alla utskick: köade mejl ligger kvar tills Rawaz släpper dem. */
  SAND_PAUSAD: bool,
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
  if (resultat.data.PAUS_MELLAN_SIDOR_MS < 2000) resultat.data.PAUS_MELLAN_SIDOR_MS = 2000;
  cache = resultat.data;
  return cache;
}

export const USER_AGENT =
  "Mozilla/5.0 (compatible; granskaren/0.1; +https://rkkommunikation.se) Chrome/120 Safari/537.36";
