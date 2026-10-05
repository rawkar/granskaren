import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { konfig, PROMPT_DIR } from "../config.js";
import type { Db } from "../db/index.js";
import { sparaKostnad } from "../db/fragor.js";

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

/** Prislista i USD per miljon tokens. Okända modeller får kostnad null men tokens loggas ändå. */
const PRISER: { prefix: string; in: number; ut: number; cacheLas: number; cacheSkriv: number }[] = [
  { prefix: "claude-fable-5-1", in: 10, ut: 50, cacheLas: 0.25, cacheSkriv: 12.5 },
  { prefix: "claude-fable-5", in: 10, ut: 50, cacheLas: 1, cacheSkriv: 12.5 },
  { prefix: "claude-opus-5-5", in: 4, ut: 20, cacheLas: 0.2, cacheSkriv: 5 },
  { prefix: "claude-opus-5", in: 5, ut: 25, cacheLas: 0.5, cacheSkriv: 6.25 },
  { prefix: "claude-opus-4", in: 5, ut: 25, cacheLas: 0.5, cacheSkriv: 6.25 },
  { prefix: "claude-sonnet-5-5", in: 2, ut: 10, cacheLas: 0.2, cacheSkriv: 2.5 },
  { prefix: "claude-sonnet-5", in: 2, ut: 10, cacheLas: 0.2, cacheSkriv: 2.5 },
  { prefix: "claude-sonnet-4", in: 3, ut: 15, cacheLas: 0.3, cacheSkriv: 3.75 },
  { prefix: "claude-haiku-4-5", in: 1, ut: 5, cacheLas: 0.1, cacheSkriv: 1.25 },
];

export function beraknaKostnad(modell: string, u: Anthropic.Usage): number | null {
  const pris = PRISER.find((p) => modell.startsWith(p.prefix));
  if (!pris) return null;
  const m = 1_000_000;
  return (
    (u.input_tokens * pris.in +
      u.output_tokens * pris.ut +
      (u.cache_read_input_tokens ?? 0) * pris.cacheLas +
      (u.cache_creation_input_tokens ?? 0) * pris.cacheSkriv) /
    m
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
    kostnad_usd: beraknaKostnad(modell, u),
  });
}

/** Modeller som tar emot output_config.effort. Haiku 4.5 gör det inte. */
function stoderEffort(modell: string): boolean {
  return !/haiku/.test(modell);
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
  const client = anthropic();
  const format = zodOutputFormat(a.schema);
  const outputConfig: Record<string, unknown> = { format };
  if (a.effort && stoderEffort(a.modell)) outputConfig.effort = a.effort;

  const stream = client.messages.stream({
    model: a.modell,
    max_tokens: a.maxTokens ?? 16000,
    system: [{ type: "text", text: a.system, cache_control: { type: "ephemeral" } }],
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
