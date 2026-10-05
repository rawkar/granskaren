import type Anthropic from "@anthropic-ai/sdk";
import { konfig } from "../config.js";
import type { Db } from "../db/index.js";
import { bildBlock, lasPrompt, strukturerat } from "./klient.js";
import { AnalysSchema, OMRADEN, stadaFynd, type Analys } from "./schema.js";
import { underlagForModell, type Underlag } from "./underlag.js";

/** Kör analysen med språkmodellen och returnerar validerade fynd. */
export async function analysera(d: Db, prospektId: number, u: Underlag): Promise<Analys> {
  const k = konfig();
  const innehall: Anthropic.ContentBlockParam[] = [];

  const start = u.sidor.find((s) => s.roll === "start");
  const handling = u.sidor.find((s) => s.roll === "handling");
  const bilder: { rubrik: string; sokvag: string | null }[] = [
    { rubrik: `Skärmbild av startsidan i dator (${start?.url ?? ""})`, sokvag: start?.skarmbild_dator ?? null },
    { rubrik: `Skärmbild av startsidan i mobil (${start?.url ?? ""})`, sokvag: start?.skarmbild_mobil ?? null },
  ];
  if (handling) bilder.push({ rubrik: `Skärmbild av handlingssidan i dator (${handling.url})`, sokvag: handling.skarmbild_dator });

  for (const b of bilder) {
    const block = bildBlock(b.sokvag);
    if (!block) continue;
    innehall.push({ type: "text", text: b.rubrik });
    innehall.push(block);
  }

  innehall.push({
    type: "text",
    text: `Underlag för ${u.doman} i JSON. Nycklarna under kontroll, lighthouse, axe och sajt är de som får användas som belägg av typen matvarde.\n\n${JSON.stringify(underlagForModell(u), null, 1)}`,
  });

  const svar = await strukturerat({
    d,
    prospektId,
    steg: "analys",
    modell: k.MODEL_ANALYS,
    system: lasPrompt("analys"),
    innehall,
    schema: AnalysSchema,
    maxTokens: 20000,
    effort: "high",
  });

  // Efterstädning: intervall, tjänsteområde enligt område, unika id:n
  const sedda = new Set<string>();
  svar.fynd = svar.fynd.slice(0, 12).map((f, i) => {
    const s = stadaFynd(f);
    s.tjansteomrade = OMRADEN[s.omrade].tjansteomrade;
    let id = s.id || `f-${String(i + 1).padStart(3, "0")}`;
    while (sedda.has(id)) id = `${id}b`;
    sedda.add(id);
    s.id = id;
    return s;
  });
  svar.bra = svar.bra.slice(0, 3);
  return svar;
}
