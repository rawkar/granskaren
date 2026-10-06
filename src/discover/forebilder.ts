import { z } from "zod";
import { lasPrompt, strukturerat } from "../analyze/klient.js";
import { konfig } from "../config.js";
import type { Db } from "../db/index.js";
import { laggTillSparr, loggaHandelse } from "../db/fragor.js";
import { logg } from "../util/logg.js";
import { hamtaEnkel } from "./hamtaEnkel.js";
import { lasKundprofil, type Kundprofil } from "./kundprofil.js";

export const LikhetsprofilSchema = z.object({
  kundtyp: z.number(),
  yrke: z.string(),
  ort: z.string().nullable(),
  verksamhet: z.string(),
  storlek: z.enum(["enskild", "liten", "medel", "okand"]),
  kannetecken: z.array(z.string()),
  sokord: z.array(z.string()),
  liknande_yrken: z.array(z.string()),
});
export type Likhetsprofil = z.infer<typeof LikhetsprofilSchema>;

export interface LikhetsprofilRad {
  id: number;
  doman: string;
  beskrivning: string | null;
  kundtyp: number;
  yrke: string | null;
  ort: string | null;
  profil: string;
}

export function likhetsprofiler(d: Db, kundtyp?: number): (LikhetsprofilRad & { data: Likhetsprofil })[] {
  const rader = (
    kundtyp
      ? d.prepare("SELECT * FROM likhetsprofil WHERE kundtyp = ? ORDER BY id").all(kundtyp)
      : d.prepare("SELECT * FROM likhetsprofil ORDER BY id").all()
  ) as LikhetsprofilRad[];
  return rader.map((r) => ({ ...r, data: JSON.parse(r.profil) as Likhetsprofil }));
}

/** Kort text om förebilderna av en kundtyp, för promptar. */
export function forebildsText(d: Db, kundtyp?: number): string {
  const lista = likhetsprofiler(d, kundtyp);
  if (lista.length === 0) return "(inga förebilder profilerade ännu)";
  return lista
    .map((r) => `${r.doman} (kundtyp ${r.kundtyp}, ${r.data.yrke}${r.data.ort ? `, ${r.data.ort}` : ""}, ${r.data.storlek}): ${r.data.verksamhet} Kännetecken: ${r.data.kannetecken.join("; ")}. Liknande yrken: ${r.data.liknande_yrken.join(", ")}.`)
    .join("\n");
}

/**
 * Läser förebilderna i kundprofil.md, profilerar dem en gång och lägger dem på spärrlistan.
 * Förebilder som redan har en likhetsprofil hoppas över om inte igen är satt.
 */
export async function profileraForebilder(d: Db, alt: { igen?: boolean } = {}): Promise<{ profilerade: number; hoppade: number; fel: number }> {
  const k = konfig();
  const kp: Kundprofil = lasKundprofil();
  const res = { profilerade: 0, hoppade: 0, fel: 0 };
  if (kp.forebilder.length === 0) {
    logg.varning("Inga förebilder med giltig domän i prompts/kundprofil.md.");
    return res;
  }
  for (const f of kp.forebilder) {
    const ny = laggTillSparr(d, f.doman, "befintlig kund");
    if (ny) logg.info(`${f.doman} lagd på spärrlistan som befintlig kund`);
    const finns = d.prepare("SELECT 1 FROM likhetsprofil WHERE doman = ?").get(f.doman);
    if (finns && !alt.igen) {
      res.hoppade++;
      continue;
    }
    logg.info(`Profilerar förebilden ${f.doman}`);
    try {
      const sajt = await hamtaEnkel(f.doman, 4);
      if (!sajt.svarar) throw new Error(sajt.fel ?? "svarar inte");
      const profil = await strukturerat({
        d,
        prospektId: null,
        steg: "likhetsprofil",
        modell: k.MODEL_ANALYS,
        system: lasPrompt("likhetsprofil"),
        innehall: [
          {
            type: "text",
            text: `Kundprofil:\n${kp.text}\n\nRawaz beskrivning av kunden: ${f.beskrivning || "(ingen)"}\n\nSajten ${f.doman}, text från sidorna:\n${sajt.text}`,
          },
        ],
        schema: LikhetsprofilSchema,
        maxTokens: 3000,
        effort: "medium",
      });
      d.prepare(
        `INSERT INTO likhetsprofil (doman, beskrivning, kundtyp, yrke, ort, profil) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(doman) DO UPDATE SET beskrivning = excluded.beskrivning, kundtyp = excluded.kundtyp, yrke = excluded.yrke, ort = excluded.ort, profil = excluded.profil, skapad = datetime('now')`,
      ).run(f.doman, f.beskrivning || null, profil.kundtyp, profil.yrke, profil.ort, JSON.stringify(profil));
      loggaHandelse(d, null, "forebild_profilerad", { doman: f.doman, kundtyp: profil.kundtyp, yrke: profil.yrke });
      logg.info(`   kundtyp ${profil.kundtyp}, ${profil.yrke}${profil.ort ? `, ${profil.ort}` : ""}. Liknande: ${profil.liknande_yrken.join(", ")}`);
      res.profilerade++;
    } catch (e) {
      res.fel++;
      logg.fel(`${f.doman}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return res;
}
