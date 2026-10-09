/**
 * Visar gamla och nya versioner av de två första styckena sida vid sida för sajter som skrivits om i en testkopia,
 * och om det nya utkastet klarade grinden på första försöket.
 *
 *   GRANSKAREN_DATA=data/jamforelse/pass-test3 MODELLVAG=session npx tsx scripts/tonjamforelse.ts a.se,b.se
 *
 * Gamla versionen läses ur driftens databas (data/granskaren.db), nya ur testkopian. Skriver
 * data/jamforelse/<datum>-<klockslag>-tonjamforelse.md.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const sajter = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!sajter.length) throw new Error("Ange domäner, kommaseparerat.");
const { ROT } = await import("../src/config.js");
const { db } = await import("../src/db/index.js");
const { idag, lasStatus, sajtMapp } = await import("../src/pass/pass.js");
const { stycken } = await import("../src/email/grind.js");

const prod = new Database(path.join(ROT, "data", "granskaren.db"), { readonly: true });
const test = db();
const datum = idag();
const rader: string[] = [`# Gamla och nya inledningar, ${datum}`, "", "Gammal version är det som skickades via API i dag. Ny version är skriven med den nya mejlprompten och grinden, i testkopian, inget skickat.", ""];
const tvaForsta = (text: string | null) => (text ? stycken(text).slice(0, 2).join("\n\n") : "(inget mejl)");

for (const dom of sajter) {
  const gammal = prod.prepare("SELECT m.text FROM mejl m JOIN prospekt p ON p.id = m.prospekt_id WHERE p.doman = ? AND m.typ = 'forsta' ORDER BY m.id DESC LIMIT 1").get(dom) as { text: string } | undefined;
  const ny = test.prepare("SELECT m.text, m.status FROM mejl m JOIN prospekt p ON p.id = m.prospekt_id WHERE p.doman = ? AND m.typ = 'forsta' ORDER BY m.id DESC LIMIT 1").get(dom) as { text: string; status: string } | undefined;
  let status;
  try {
    status = lasStatus(datum, dom);
  } catch {
    status = null;
  }
  const grindFil = path.join(sajtMapp(datum, dom), "grind-resultat.json");
  const grind = fs.existsSync(grindFil) ? (JSON.parse(fs.readFileSync(grindFil, "utf8")) as { godkand: boolean; utfall: string; fel: string[]; varningar: string[] }) : null;
  const forstaForsoket = status && grind ? grind.godkand && status.forsok.utkast === 1 : null;
  rader.push(`## ${dom}`, "");
  rader.push(`Grinden: ${grind ? (grind.godkand ? "godkänt" : `stoppat (${grind.fel.join("; ")})`) : status?.utfall ?? "inget resultat"}${status ? `, ${status.forsok.utkast} utkastförsök` : ""}${forstaForsoket !== null ? `, första försöket: ${forstaForsoket ? "ja" : "nej"}` : ""}${grind?.varningar.length ? `. Varningar: ${grind.varningar.join("; ")}` : ""}`, "");
  rader.push("**Gammal**", "", "```", tvaForsta(gammal?.text ?? null), "```", "", "**Ny**", "", "```", tvaForsta(ny?.text ?? null), "```", "");
  if (ny) rader.push("<details><summary>Hela det nya mejlet</summary>", "", "```", ny.text, "```", "", "</details>", "");
}
const klockan = new Date().toTimeString().slice(0, 5).replace(":", "");
const fil = path.join(ROT, "data", "jamforelse", `${datum}-${klockan}-tonjamforelse.md`);
fs.writeFileSync(fil, rader.join("\n"), "utf8");
console.log(rader.join("\n"));
console.log(`\nSkrivet till ${fil}`);
prod.close();
