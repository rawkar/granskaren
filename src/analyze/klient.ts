import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { konfig, PROMPT_DIR } from "../config.js";
import type { Db } from "../db/index.js";
import { kostnadDennaManad, sparaKostnad } from "../db/fragor.js";

/** Kastas när månadens kostnadstak är nått. Körningar ska avbrytas, inte försöka igen. */
export class KostnadstakError extends Error {
  constructor(meddelande: string) {
    super(meddelande);
    this.name = "KostnadstakError";
  }
}

/** Månadens förbrukning mot taket i .env, eller null om inget tak är satt. */
export function kostnadstak(d: Db): { tak: number; forbrukat: number; natt: boolean } | null {
  const tak = konfig().MAX_KOSTNAD_PER_MANAD;
  if (tak <= 0) return null;
  const forbrukat = kostnadDennaManad(d);
  return { tak, forbrukat, natt: forbrukat >= tak };
}

/** Kastar KostnadstakError om månadens tak är nått. Anropas före varje modellanrop. */
export function kontrolleraKostnadstak(d: Db): void {
  const t = kostnadstak(d);
  if (t?.natt) {
    throw new KostnadstakError(
      `Månadens kostnadstak på ${t.tak.toFixed(2)} USD är nått (${t.forbrukat.toFixed(2)} USD förbrukat). Höj MAX_KOSTNAD_PER_MANAD i .env för att fortsätta.`,
    );
  }
}

let klient: Anthropic | undefined;

export function anthropic(): Anthropic {
  if (!klient) {
    const k = konfig();
    if (!k.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY saknas i .env. Analysen kan inte köras utan nyckel.");
    }
    klient = new Anthropic({ apiKey: k.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 15 * 60 * 1000 });
  }
  return klient;
}

/** Läser en prompt från prompts/. Rawaz kan ändra ton och regler där utan att röra koden. */
export function lasPrompt(namn: string): string {
  const fil = path.join(PROMPT_DIR, `${namn}.md`);
  if (!fs.existsSync(fil)) throw new Error(`Prompten ${fil} saknas.`);
  return fs.readFileSync(fil, "utf8");
}

/**
 * Prislista i USD per miljon tokens, enligt platform.claude.com/docs/en/about-claude/pricing (kontrollerad 2026-10-08).
 * Haiku 5.5 gäller för promptar upp till 100 000 tokens. Okända modeller får kostnad null men tokens loggas ändå.
 */
const PRISER: { prefix: string; in: number; ut: number; cacheLas: number; cacheSkriv: number }[] = [
  { prefix: "claude-fable-5-1", in: 10, ut: 50, cacheLas: 0.25, cacheSkriv: 12.5 },
  { prefix: "claude-fable-5", in: 10, ut: 50, cacheLas: 1, cacheSkriv: 12.5 },
  { prefix: "claude-opus-5-5", in: 4, ut: 20, cacheLas: 0.2, cacheSkriv: 5 },
  { prefix: "claude-opus-5", in: 5, ut: 25, cacheLas: 0.5, cacheSkriv: 6.25 },
  { prefix: "claude-opus-4", in: 5, ut: 25, cacheLas: 0.5, cacheSkriv: 6.25 },
  { prefix: "claude-sonnet-5-5", in: 2, ut: 10, cacheLas: 0.1, cacheSkriv: 2.5 },
  { prefix: "claude-sonnet-5", in: 2, ut: 10, cacheLas: 0.2, cacheSkriv: 2.5 },
  { prefix: "claude-sonnet-4", in: 3, ut: 15, cacheLas: 0.3, cacheSkriv: 3.75 },
  { prefix: "claude-haiku-5-5", in: 0.1, ut: 0.5, cacheLas: 0.01, cacheSkriv: 0.125 },
  { prefix: "claude-haiku-4-5", in: 1, ut: 5, cacheLas: 0.1, cacheSkriv: 1.25 },
];

/** Webbsökning debiteras per sökning utöver tokens: 10 USD per 1 000 sökningar. */
export const PRIS_PER_SOKNING_USD = 0.01;

export function antalSokningar(u: Anthropic.Usage): number {
  return (u as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0;
}

/** Cache-skrivningar uppdelade på livslängd. 5 minuter kostar 1,25 gånger inpriset, 1 timme 2 gånger. */
function cacheSkrivningar(u: Anthropic.Usage): { fem: number; timme: number } {
  const detalj = (u as { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null }).cache_creation;
  if (detalj && (detalj.ephemeral_5m_input_tokens !== undefined || detalj.ephemeral_1h_input_tokens !== undefined)) {
    return { fem: detalj.ephemeral_5m_input_tokens ?? 0, timme: detalj.ephemeral_1h_input_tokens ?? 0 };
  }
  return { fem: u.cache_creation_input_tokens ?? 0, timme: 0 };
}

export function beraknaKostnad(modell: string, u: Anthropic.Usage): number | null {
  const pris = PRISER.find((p) => modell.startsWith(p.prefix));
  if (!pris) return null;
  const m = 1_000_000;
  const cache = cacheSkrivningar(u);
  return (
    (u.input_tokens * pris.in +
      u.output_tokens * pris.ut +
      (u.cache_read_input_tokens ?? 0) * pris.cacheLas +
      cache.fem * pris.cacheSkriv +
      cache.timme * pris.in * 2) /
      m +
    antalSokningar(u) * PRIS_PER_SOKNING_USD
  );
}

export function loggaAnvandning(d: Db, prospektId: number | null, steg: string, modell: string, u: Anthropic.Usage): void {
  sparaKostnad(d, {
    prospekt_id: prospektId,
    steg,
    modell,
    tokens_in: u.input_tokens,
    tokens_ut: u.output_tokens,
    tokens_cache_las: u.cache_read_input_tokens ?? 0,
    tokens_cache_skriv: u.cache_creation_input_tokens ?? 0,
    sokningar: antalSokningar(u),
    kostnad_usd: beraknaKostnad(modell, u),
  });
}

/** Modeller som tar emot output_config.effort. Haiku 4.5 gör det inte, Haiku 5.5 och senare gör det. */
function stoderEffort(modell: string): boolean {
  return !/haiku-4/.test(modell);
}

export interface StruktureratAnrop<S extends z.ZodType> {
  d: Db;
  prospektId: number | null;
  steg: string;
  modell: string;
  system: string;
  innehall: Anthropic.ContentBlockParam[];
  schema: S;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * Ett anrop till modellen med strukturerat svar som valideras med zod.
 * Streamar så att långa underlag inte slår i tidsgränser. Loggar tokens och kostnad.
 */
export async function strukturerat<S extends z.ZodType>(a: StruktureratAnrop<S>): Promise<z.infer<S>> {
  kontrolleraKostnadstak(a.d);
  const client = anthropic();
  const format = zodOutputFormat(a.schema);
  const outputConfig: Record<string, unknown> = { format };
  if (a.effort && stoderEffort(a.modell)) outputConfig.effort = a.effort;
  // Systemprompten är densamma för alla sajter och cachas. Med CACHE_TTL=1h överlever cachen pauserna mellan sajter.
  const cache: Anthropic.CacheControlEphemeral = konfig().CACHE_TTL === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };

  const stream = client.messages.stream({
    model: a.modell,
    max_tokens: a.maxTokens ?? 16000,
    system: [{ type: "text", text: a.system, cache_control: cache }],
    messages: [{ role: "user", content: a.innehall }],
    output_config: outputConfig as never,
  });
  const svar = await stream.finalMessage();
  loggaAnvandning(a.d, a.prospektId, a.steg, a.modell, svar.usage);

  if (svar.stop_reason === "refusal") {
    throw new Error(`Modellen avböjde anropet (${a.steg}): ${svar.stop_details?.explanation ?? "ingen förklaring"}`);
  }
  if (svar.stop_reason === "max_tokens") {
    throw new Error(`Svaret blev avklippt (${a.steg}). Höj maxTokens.`);
  }
  const parsed = (svar as { parsed_output?: unknown }).parsed_output;
  if (parsed === null || parsed === undefined) {
    const text = svar.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");
    const res = a.schema.safeParse(JSON.parse(text));
    if (!res.success) throw new Error(`Svaret från modellen gick inte att tolka (${a.steg}): ${res.error.message}`);
    return res.data as z.infer<S>;
  }
  return parsed as z.infer<S>;
}

/** Läser in en bild som innehållsblock till modellen. Returnerar null om filen saknas. */
export function bildBlock(sokvag: string | null): Anthropic.ImageBlockParam | null {
  if (!sokvag || !fs.existsSync(sokvag)) return null;
  const data = fs.readFileSync(sokvag);
  if (data.length > 4.5 * 1024 * 1024) return null;
  const typ = sokvag.endsWith(".png") ? "image/png" : "image/jpeg";
  return { type: "image", source: { type: "base64", media_type: typ, data: data.toString("base64") } };
}
