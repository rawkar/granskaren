import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { anthropic, lasPrompt, loggaAnvandning } from "../analyze/klient.js";
import { konfig } from "../config.js";
import type { Db } from "../db/index.js";
import { normaliseraDoman } from "../util/domain.js";
import { logg } from "../util/logg.js";
import { forebildsText, likhetsprofiler } from "./forebilder.js";
import { hamtaEnkel } from "./hamtaEnkel.js";
import type { Kundprofil } from "./kundprofil.js";
import type { SegmentRad } from "./segment.js";

export interface Traff {
  doman: string;
  namn: string | null;
  kalla: string;
  segmentId: number | null;
  kundtyp: number | null;
  varfor: string | null;
}

/** Gränssnitt för urvalskällor så att källan kan bytas. */
export interface SearchProvider {
  namn: string;
  sok(d: Db, kp: Kundprofil, segment: SegmentRad, antal: number, kanda: Set<string>): Promise<Traff[]>;
}

const TraffSchema = z.array(z.object({ namn: z.string(), url: z.string(), varfor: z.string().optional() }));

/** Källa 1: Anthropics webbsökningsverktyg. Modellen söker och returnerar organisationers egna sajter. */
export class WebbSokning implements SearchProvider {
  namn = "webb";

  async sok(d: Db, kp: Kundprofil, segment: SegmentRad, antal: number, kanda: Set<string>): Promise<Traff[]> {
    const k = konfig();
    const client = anthropic();
    const maxSok = Math.min(8, Math.max(3, Math.ceil(antal / 4)));
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          `Segment: kundtyp ${segment.kundtyp}, ${segment.yrke} i ${segment.ort}. Sökfras: "${segment.sokfras}". Motivering: ${segment.motivering ?? ""}`,
          `Önskat antal träffar: ${antal}. Du får göra högst ${maxSok} sökningar.`,
          `Kundprofil:\n${kp.text}`,
          `Likhetsprofiler för förebilder av kundtyp ${segment.kundtyp}:\n${forebildsText(d, segment.kundtyp)}`,
          `Redan kända domäner som inte ska tas med:\n${[...kanda].slice(0, 300).join(", ") || "(inga)"}`,
        ].join("\n\n"),
      },
    ];
    const tools: Anthropic.ToolUnion[] = [
      { type: "web_search_20260209", name: "web_search", max_uses: maxSok, user_location: { type: "approximate", country: "SE", timezone: "Europe/Stockholm" } },
    ];
    let svar = await client.messages.create({ model: k.MODEL_ANALYS, max_tokens: 8000, system: lasPrompt("discover-webb"), messages, tools });
    loggaAnvandning(d, null, "discover_webb", k.MODEL_ANALYS, svar.usage);
    for (let i = 0; i < 4 && svar.stop_reason === "pause_turn"; i++) {
      messages.push({ role: "assistant", content: svar.content });
      svar = await client.messages.create({ model: k.MODEL_ANALYS, max_tokens: 8000, system: lasPrompt("discover-webb"), messages, tools });
      loggaAnvandning(d, null, "discover_webb", k.MODEL_ANALYS, svar.usage);
    }
    if (svar.stop_reason === "refusal") throw new Error("Modellen avböjde sökningen.");
    const text = svar.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    const block = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text.match(/\[[\s\S]*\]/)?.[0];
    if (!block) {
      logg.varning("   webbsökningen gav ingen JSON-lista");
      return [];
    }
    let lista: z.infer<typeof TraffSchema>;
    try {
      lista = TraffSchema.parse(JSON.parse(block));
    } catch (e) {
      logg.varning(`   listan från webbsökningen gick inte att tolka: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
    const ut: Traff[] = [];
    for (const t of lista) {
      const doman = normaliseraDoman(t.url);
      if (!doman || kanda.has(doman)) continue;
      kanda.add(doman);
      ut.push({ doman, namn: t.namn || null, kalla: "discover:webb", segmentId: segment.id, kundtyp: segment.kundtyp, varfor: t.varfor ?? null });
    }
    return ut;
  }
}

/**
 * Källa 2: utgående länkar från förebildernas sajter (samarbetspartner, kunder, nätverk).
 * Ett steg, inte längre. Segmentet används inte, kundtypen avgörs i förfiltreringen.
 */
export class Forebildslankar implements SearchProvider {
  namn = "lankar";

  async sok(d: Db, _kp: Kundprofil, _segment: SegmentRad, antal: number, kanda: Set<string>): Promise<Traff[]> {
    const ut: Traff[] = [];
    for (const f of likhetsprofiler(d)) {
      if (ut.length >= antal) break;
      logg.info(`   följer länkar från ${f.doman}`);
      const sajt = await hamtaEnkel(f.doman, 5);
      for (const dom of sajt.externaDomaner) {
        if (ut.length >= antal) break;
        if (kanda.has(dom)) continue;
        kanda.add(dom);
        ut.push({ doman: dom, namn: null, kalla: `discover:lankar:${f.doman}`, segmentId: null, kundtyp: null, varfor: `länkad från förebilden ${f.doman}` });
      }
    }
    return ut;
  }
}

export function providerFor(namn: string): SearchProvider {
  if (namn === "webb") return new WebbSokning();
  if (namn === "lankar") return new Forebildslankar();
  throw new Error(`Okänd källa: ${namn}. Välj webb eller lankar.`);
}
