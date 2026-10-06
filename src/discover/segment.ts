import { z } from "zod";
import { lasPrompt, strukturerat } from "../analyze/klient.js";
import { konfig } from "../config.js";
import type { Db } from "../db/index.js";
import { logg } from "../util/logg.js";
import { forebildsText } from "./forebilder.js";
import { aktuellFordelning, fordelaAntal, lasKundprofil } from "./kundprofil.js";

const SegmentSchema = z.object({
  segment: z.array(
    z.object({
      kundtyp: z.number(),
      yrke: z.string(),
      ort: z.string(),
      sokfras: z.string(),
      motivering: z.string(),
    }),
  ),
});

export interface SegmentRad {
  id: number;
  kundtyp: number;
  yrke: string;
  ort: string;
  sokfras: string;
  motivering: string | null;
  anvand: number;
  traffar: number;
}

export function allaSegment(d: Db, baraOanvanda = false): SegmentRad[] {
  return d.prepare(`SELECT * FROM segment ${baraOanvanda ? "WHERE anvand = 0" : ""} ORDER BY kundtyp, id`).all() as SegmentRad[];
}

/** Tar fram nya segment per kundtyp enligt fördelningen, med likhetsprofilerna som underlag. */
export async function skapaSegment(d: Db, antal: number): Promise<SegmentRad[]> {
  const k = konfig();
  const kp = lasKundprofil();
  const fordelning = aktuellFordelning(d, kp);
  const perTyp = fordelaAntal(antal, fordelning);
  const befintliga = allaSegment(d);
  logg.info(`Tar fram ${antal} segment: ${Object.entries(perTyp).map(([t, n]) => `kundtyp ${t}: ${n}`).join(", ")}`);

  const svar = await strukturerat({
    d,
    prospektId: null,
    steg: "segment",
    modell: k.MODEL_ANALYS,
    system: lasPrompt("segment"),
    innehall: [
      {
        type: "text",
        text: [
          `Kundprofil:\n${kp.text}`,
          `Likhetsprofiler för förebilder:\n${forebildsText(d)}`,
          `Önskat antal segment per kundtyp: ${JSON.stringify(perTyp)}`,
          `Segment som redan finns och inte ska upprepas:\n${befintliga.map((s) => `kundtyp ${s.kundtyp}: ${s.yrke} i ${s.ort}`).join("\n") || "(inga)"}`,
        ].join("\n\n"),
      },
    ],
    schema: SegmentSchema,
    maxTokens: 6000,
    effort: "medium",
  });

  const ins = d.prepare("INSERT OR IGNORE INTO segment (kundtyp, yrke, ort, sokfras, motivering) VALUES (?, ?, ?, ?, ?)");
  const nya: SegmentRad[] = [];
  const kvar = { ...perTyp };
  for (const s of svar.segment) {
    if (!(s.kundtyp in kvar) || kvar[s.kundtyp] <= 0) continue;
    const r = ins.run(s.kundtyp, s.yrke.trim(), s.ort.trim(), s.sokfras.trim(), s.motivering.trim());
    if (r.changes > 0) {
      kvar[s.kundtyp]--;
      nya.push(d.prepare("SELECT * FROM segment WHERE id = ?").get(Number(r.lastInsertRowid)) as SegmentRad);
    }
  }
  for (const s of nya) logg.info(`   kundtyp ${s.kundtyp}: ${s.yrke} i ${s.ort}  ("${s.sokfras}")`);
  return nya;
}
