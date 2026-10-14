import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import type { Db } from "../db/index.js";
import { fyndForProspekt, hamtaProspekt, loggaHandelse, sattStatus } from "../db/fragor.js";
import { rapportSokvag } from "../report/rapport.js";
import { sprakfel, antalOrd } from "./grind.js";
import { konfig } from "../config.js";
import { avslutsrad, signatur } from "./utkast.js";

interface MejlRad {
  id: number;
  prospekt_id: number;
  mottagare: string | null;
  amne: string;
  text: string;
  anvanda_fynd: string;
  sakerhet: number;
  status: string;
}

export interface KoRad extends MejlRad {
  doman: string;
  kundtyp: number | null;
  skapad: string;
}

/** Mejlen i granskningskön (status i_granskning eller utkast) med domän och kundtyp, äldst först. */
export function granskningsko(d: Db): KoRad[] {
  return d
    .prepare(
      `SELECT m.*, p.doman, p.kundtyp FROM mejl m JOIN prospekt p ON p.id = m.prospekt_id
       WHERE m.typ = 'forsta' AND m.status IN ('i_granskning', 'utkast') ORDER BY m.id`,
    )
    .all() as KoRad[];
}

/** Skriver ut granskningskön i sin helhet, ett mejl i taget med mottagare och ämnesrad, så att Rawaz kan läsa dem i sessionen. */
export function skrivGranskningsko(d: Db): number {
  const ko = granskningsko(d);
  if (ko.length === 0) {
    console.log("Granskningskön är tom.");
    return 0;
  }
  for (const m of ko) {
    console.log(`\n${"=".repeat(78)}\n${m.doman}   mejl #${m.id}   kundtyp ${m.kundtyp ?? "?"}   status ${m.status}   skapat ${m.skapad}`);
    console.log(`Till: ${m.mottagare ?? "(saknas)"}\nÄmne: ${m.amne}\n\n${m.text}`);
  }
  const koade = (d.prepare("SELECT count(*) AS n FROM mejl WHERE typ = 'forsta' AND status = 'koad'").get() as { n: number }).n;
  console.log(`\n${ko.length} mejl i granskningskön, ${koade} köade för utskick. Godkänn med: granskaren review --godkann <id...>`);
  return ko.length;
}

/** Godkänner mejl i granskningskön efter id: mejlet och prospektet får status koad. Mejl som inte ligger i kön rörs inte. */
export function godkann(d: Db, ids: number[], not?: string): { koade: number[]; hoppade: number[] } {
  const koade: number[] = [];
  const hoppade: number[] = [];
  for (const id of ids) {
    const m = d.prepare("SELECT id, prospekt_id FROM mejl WHERE id = ? AND status IN ('i_granskning', 'utkast')").get(id) as { id: number; prospekt_id: number } | undefined;
    if (!m) {
      hoppade.push(id);
      continue;
    }
    d.prepare("UPDATE mejl SET status = 'koad' WHERE id = ?").run(m.id);
    sattStatus(d, m.prospekt_id, "koad");
    loggaHandelse(d, m.prospekt_id, "godkant_i_review", not);
    koade.push(id);
  }
  return { koade, hoppade };
}

/** Kastar mejl i granskningskön efter id: mejlet får status kastad och prospektet är kvar som granskat. */
export function kasta(d: Db, ids: number[], orsak?: string): { kastade: number[]; hoppade: number[] } {
  const kastade: number[] = [];
  const hoppade: number[] = [];
  for (const id of ids) {
    const m = d.prepare("SELECT id, prospekt_id FROM mejl WHERE id = ? AND status IN ('i_granskning', 'utkast')").get(id) as { id: number; prospekt_id: number } | undefined;
    if (!m) {
      hoppade.push(id);
      continue;
    }
    d.prepare("UPDATE mejl SET status = 'kastad' WHERE id = ?").run(m.id);
    sattStatus(d, m.prospekt_id, "granskad");
    loggaHandelse(d, m.prospekt_id, "kastat_i_review", orsak);
    kastade.push(id);
  }
  return { kastade, hoppade };
}

/** Går igenom granskningskön, ett utkast i taget. Godkänn, redigera eller kasta. */
export async function review(d: Db): Promise<void> {
  const ko = d.prepare("SELECT * FROM mejl WHERE status IN ('i_granskning', 'utkast') ORDER BY id").all() as MejlRad[];
  // Sajter i kön utan utkast: färre än två bekräftade fynd eller bedömd som välskött. Rawaz avgör själv utifrån rapporten.
  const utanUtkast = d
    .prepare(
      `SELECT p.id, p.doman, p.namn, (SELECT detaljer FROM handelser h WHERE h.prospekt_id = p.id AND h.typ = 'utkast_hoppat' ORDER BY h.id DESC LIMIT 1) AS orsak
       FROM prospekt p WHERE p.status = 'i_granskning' AND NOT EXISTS (SELECT 1 FROM mejl m WHERE m.prospekt_id = p.id AND m.status IN ('i_granskning', 'utkast'))`,
    )
    .all() as { id: number; doman: string; namn: string | null; orsak: string | null }[];
  if (ko.length === 0 && utanUtkast.length === 0) {
    console.log("Granskningskön är tom.");
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const p of utanUtkast) {
      console.log("\n" + "=".repeat(78));
      console.log(`${p.namn ?? ""} (${p.doman})   inget mejl skrevs: ${p.orsak ?? "okänd orsak"}`);
      console.log(`Rapport: ${rapportSokvag(p.doman)}`);
      console.log("=".repeat(78));
      const svar = (await rl.question("[k]lar, lämna som granskad   [h]oppa över   [a]vsluta > ")).trim().toLowerCase();
      if (svar === "k") {
        sattStatus(d, p.id, "granskad");
        loggaHandelse(d, p.id, "sedd_i_review_utan_mejl");
      } else if (svar === "a") {
        return;
      }
    }
    for (const [i, m] of ko.entries()) {
      const p = hamtaProspekt(d, m.prospekt_id);
      if (!p) continue;
      const anvanda = new Set<string>(JSON.parse(m.anvanda_fynd));
      const fynd = fyndForProspekt(d, p.id, true).filter((f) => anvanda.has(f.fynd_id));

      console.log("\n" + "=".repeat(78));
      console.log(`Utkast ${i + 1} av ${ko.length}   ${p.namn ?? ""} (${p.doman})   status ${m.status}   säkerhet ${m.sakerhet.toFixed(2)}`);
      console.log("=".repeat(78));
      console.log(`Till: ${m.mottagare ?? "(saknas)"}`);
      console.log(`Ämne: ${m.amne}\n`);
      console.log(m.text);
      console.log("-".repeat(78));

      console.log("Fynd som mejlet bygger på:");
      for (const f of fynd) {
        console.log(`  [${f.omrade}, allvar ${f.allvar}] ${f.rubrik}${f.galler_inte ? ` (gäller inte: ${f.galler_inte})` : ""}`);
        console.log(`      ${f.observation}`);
        console.log(`      Belägg: ${f.belagg_typ} ${f.belagg_url}  ${f.belagg_varde}`);
      }
      const hand = d.prepare("SELECT detaljer FROM handelser WHERE prospekt_id = ? AND typ = 'utkast_skapat' ORDER BY id DESC LIMIT 1").get(p.id) as { detaljer: string } | undefined;
      if (hand?.detaljer) {
        const det = JSON.parse(hand.detaljer) as { fel?: string[]; varningar?: string[] };
        if (det.fel?.length) console.log(`Grinden stoppade: ${det.fel.join("; ")}`);
        if (det.varningar?.length) console.log(`Varningar: ${det.varningar.join("; ")}`);
      }
      console.log("-".repeat(78));

      let klar = false;
      while (!klar) {
        const svar = (await rl.question("[g]odkänn  [r]edigera  [k]asta  [h]oppa över  [a]vsluta > ")).trim().toLowerCase();
        if (svar === "g") {
          godkann(d, [m.id]);
          console.log("Köat för utskick.");
          klar = true;
        } else if (svar === "r") {
          const nytt = redigera(m);
          if (!nytt) {
            console.log("Ingen ändring.");
            continue;
          }
          const fel = sprakfel(nytt.amne, nytt.brodtext, konfig().BOKNINGSLANK);
          if (fel.length) console.log(`Observera, språkregler: ${fel.join("; ")} (${antalOrd(nytt.brodtext)} ord)`);
          m.amne = nytt.amne;
          m.text = `${nytt.brodtext.trim()}\n${signatur()}\n\n${avslutsrad(/^Hej [A-ZÅÄÖ]/m.test(nytt.brodtext) ? "du" : "ni")}\n`;
          d.prepare("UPDATE mejl SET amne = ?, text = ? WHERE id = ?").run(m.amne, m.text, m.id);
          loggaHandelse(d, p.id, "redigerat_i_review");
          console.log(`\nÄmne: ${m.amne}\n\n${m.text}`);
        } else if (svar === "k") {
          kasta(d, [m.id]);
          console.log("Kastat. Prospektet är kvar som granskat.");
          klar = true;
        } else if (svar === "h") {
          klar = true;
        } else if (svar === "a") {
          return;
        }
      }
    }
  } finally {
    rl.close();
  }
}

/** Öppnar utkastet i användarens textredigerare. Returnerar ny ämnesrad och brödtext, eller null. */
function redigera(m: MejlRad): { amne: string; brodtext: string } | null {
  const sig = signatur();
  const brodtext = m.text.split(sig)[0].trimEnd();
  const fil = path.join(os.tmpdir(), `granskaren-utkast-${m.id}.txt`);
  const innehall = `Ämne: ${m.amne}\n\n${brodtext}\n`;
  fs.writeFileSync(fil, innehall, "utf8");
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano");
  const r = spawnSync(editor, [fil], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.error) {
    console.log(`Kunde inte öppna ${editor}: ${r.error.message}. Sätt EDITOR i miljön.`);
    return null;
  }
  const nytt = fs.readFileSync(fil, "utf8");
  if (nytt === innehall) return null;
  const match = nytt.match(/^Ämne:\s*(.*)\r?\n/);
  const amne = match ? match[1].trim() : m.amne;
  const rest = match ? nytt.slice(match[0].length) : nytt;
  return { amne, brodtext: rest.replace(/\r\n/g, "\n").trim() + "\n" };
}
