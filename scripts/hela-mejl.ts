/**
 * Visar hela mejlen för sajter som skrivits om i en testkopia, med grindens utfall, antal försök och ordantal.
 *
 *   GRANSKAREN_DATA=data/jamforelse/pass-test4 MODELLVAG=session npx tsx scripts/hela-mejl.ts a.se,b.se [rubrik]
 *
 * Skriver data/jamforelse/<datum>-<klockslag>-hela-mejl.md.
 */
import fs from "node:fs";
import path from "node:path";

const sajter = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!sajter.length) throw new Error("Ange domäner, kommaseparerat.");
const rubrik = process.argv[3] ?? "Hela mejlen";
const { ROT } = await import("../src/config.js");
const { db } = await import("../src/db/index.js");
const { idag, lasStatus, sajtMapp } = await import("../src/pass/pass.js");
const { antalOrd } = await import("../src/email/grind.js");

const test = db();
const datum = idag();
const rader: string[] = [`# ${rubrik}, ${datum}`, "", "Skrivna i testkopian med passets agenter, inget skickat. Ordantalet gäller brödtexten före signaturen, den fasta meningen om fler fynd inräknad.", ""];

for (const dom of sajter) {
  const ny = test.prepare("SELECT m.text, m.status, m.amne, m.mottagare FROM mejl m JOIN prospekt p ON p.id = m.prospekt_id WHERE p.doman = ? AND m.typ = 'forsta' ORDER BY m.id DESC LIMIT 1").get(dom) as
    | { text: string; status: string; amne: string; mottagare: string }
    | undefined;
  let status;
  try {
    status = lasStatus(datum, dom);
  } catch {
    status = null;
  }
  const grindFil = path.join(sajtMapp(datum, dom), "grind-resultat.json");
  const grind = fs.existsSync(grindFil) ? (JSON.parse(fs.readFileSync(grindFil, "utf8")) as { godkand: boolean; utfall: string; fel: string[]; varningar: string[] }) : null;
  const forberett = path.join(sajtMapp(datum, dom), "forberett.json");
  const f = fs.existsSync(forberett) ? (JSON.parse(fs.readFileSync(forberett, "utf8")) as { huvudfynd?: string; valda: { fynd_id: string; rubrik: string }[]; flerFynd: number | null }) : null;
  rader.push(`## ${dom}`, "");
  rader.push(
    `Grinden: ${grind ? (grind.godkand ? `godkänt -> ${grind.utfall}` : `stoppat (${grind.fel.join("; ")})`) : status?.utfall ?? "inget resultat"}${status ? `. Utkastförsök: ${status.forsok.utkast}` : ""}${grind?.varningar.length ? `. Varningar: ${grind.varningar.join("; ")}` : ""}`,
    "",
  );
  if (f) {
    const huvud = f.valda.find((x) => x.fynd_id === f.huvudfynd);
    rader.push(`Huvudfynd: ${f.huvudfynd ?? "(saknas)"}${huvud ? ` (${huvud.rubrik})` : ""}. Fynd i mejlet: ${f.valda.map((x) => x.fynd_id).join(", ")}. Bekräftade fynd utanför mejlet: ${f.flerFynd ?? "räknas inte"}.`, "");
  }
  if (ny) {
    const brod = ny.text.split(/\nRawaz Karim\n/)[0];
    rader.push(`Till: ${ny.mottagare}. Ämne: ${ny.amne}. Status i kopian: ${ny.status}. Ord i brödtexten: ${antalOrd(brod)}.`, "", "```", ny.text.trimEnd(), "```", "");
  } else {
    rader.push("(inget mejl sparat)", "");
  }
}
const klockan = new Date().toTimeString().slice(0, 5).replace(":", "");
const fil = path.join(ROT, "data", "jamforelse", `${datum}-${klockan}-hela-mejl.md`);
fs.writeFileSync(fil, rader.join("\n"), "utf8");
console.log(rader.join("\n"));
console.log(`\nSkrivet till ${fil}`);
