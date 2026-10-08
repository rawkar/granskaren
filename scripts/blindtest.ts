/**
 * Gör ett blindtest av mejlen i en jämförelse: varje sajt får två mejl, A och B, i slumpad ordning utan uppgift om
 * vilken inställning som skrev vilket. Facit skrivs till en separat fil.
 *
 *   npx tsx scripts/blindtest.ts data/jamforelse/2026-10-08-1700-steg3.json
 *
 * Skriver <samma mapp>/blindtest-<etikett>.md och blindtest-<etikett>-facit.md.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const fil = process.argv[2];
if (!fil) throw new Error("Ange sökvägen till jämförelsens json-fil.");
const r = JSON.parse(fs.readFileSync(fil, "utf8")) as {
  etikett: string;
  installningar: Record<string, string>;
  sajter: { doman: string; kundtyp: number | null; amne: string | null; mejl: string | null; ingetMejl: string | null; drift: { amne: string | null; mejl: string | null } }[];
};

const test: string[] = [`# Blindtest ${r.etikett}`, "", "Två mejl per sajt, A och B i slumpad ordning. Det ena är det som driften skickade, det andra är skrivet med de prövade inställningarna. Välj det du hellre skickar, eller lika. Facit ligger i en egen fil.", ""];
const facit: string[] = [`# Facit blindtest ${r.etikett}`, "", `Prövade inställningar: ${Object.entries(r.installningar).map(([a, b]) => `${a}=${b}`).join(", ")}`, "", "| Sajt | A | B |", "|---|---|---|"];
let n = 0;
for (const s of r.sajter) {
  if (!s.mejl || !s.drift.mejl) {
    facit.push(`| ${s.doman} | (inget par: ${s.mejl ? "driften saknar mejl" : s.ingetMejl ?? "nytt mejl saknas"}) | |`);
    continue;
  }
  n++;
  const driftForst = crypto.randomInt(2) === 0;
  const a = driftForst ? s.drift.mejl : s.mejl;
  const b = driftForst ? s.mejl : s.drift.mejl;
  test.push(`## ${n}. ${s.doman}`, "", `Ämne: ${s.drift.amne ?? s.amne ?? ""}`, "", "### Mejl A", "", "```", a.trim(), "```", "", "### Mejl B", "", "```", b.trim(), "```", "", "Ditt val: A, B eller lika. Kommentar:", "", "");
  facit.push(`| ${n}. ${s.doman} | ${driftForst ? "drift (Opus)" : r.etikett} | ${driftForst ? r.etikett : "drift (Opus)"} |`);
}
const mapp = path.dirname(fil);
const testFil = path.join(mapp, `blindtest-${r.etikett}.md`);
const facitFil = path.join(mapp, `blindtest-${r.etikett}-facit.md`);
fs.writeFileSync(testFil, test.join("\n"), "utf8");
fs.writeFileSync(facitFil, facit.join("\n"), "utf8");
console.log(`${n} par. Blindtest: ${testFil}\nFacit: ${facitFil}`);
