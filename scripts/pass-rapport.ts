/**
 * Sammanställer ett pass i testmappen mot driftens resultat för samma sajter, i samma form som
 * scripts/jamfor-modeller.ts, så att scripts/blindtest.ts kan användas på utfallet.
 *
 *   GRANSKAREN_DATA=data/jamforelse/pass-test MODELLVAG=session npx tsx scripts/pass-rapport.ts --etikett pass
 *
 * Skriver data/jamforelse/<datum>-<klockslag>-<etikett>.json och .md i projektets riktiga datamapp.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const etikett = process.argv[process.argv.indexOf("--etikett") + 1] || "pass";
const { DATA_DIR, ROT } = await import("../src/config.js");
const { db } = await import("../src/db/index.js");
const { allaStatus, idag, passMapp } = await import("../src/pass/pass.js");
type FyndRad = import("../src/db/fragor.js").FyndRad;
type Huvudinsikt = import("../src/analyze/schema.js").Huvudinsikt;
type SajtStatus = import("../src/pass/pass.js").SajtStatus;

const datum = idag();
const test = db();
const prod = new Database(path.join(ROT, "data", "granskaren.db"), { readonly: true });
const ut = path.join(ROT, "data", "jamforelse");
const klockan = new Date().toTimeString().slice(0, 5).replace(":", "");

const fyndKort = (f: FyndRad) => ({ id: f.fynd_id, omrade: f.omrade, djup: f.djup, rubrik: f.rubrik, verifierad: f.verifierad === 1, metod: f.verifieringsmetod, not: f.verifierad ? null : f.verifieringsnot });

const sajter = allaStatus(datum).map((s: SajtStatus) => {
  const pTest = test.prepare("SELECT * FROM prospekt WHERE id = ?").get(s.prospektId) as { huvudinsikt: string | null; kundtyp: number | null };
  const fynd = test.prepare("SELECT * FROM fynd WHERE prospekt_id = ? ORDER BY id").all(s.prospektId) as FyndRad[];
  const mejl = test.prepare("SELECT * FROM mejl WHERE prospekt_id = ? AND typ = 'forsta' ORDER BY id DESC LIMIT 1").get(s.prospektId) as { amne: string; text: string; anvanda_fynd: string; status: string } | undefined;
  const grindFil = path.join(passMapp(datum), path.basename(path.join(passMapp(datum), s.doman.replace(/[^a-z0-9._-]+/gi, "_"))), "grind-resultat.json");
  const grind = fs.existsSync(grindFil) ? (JSON.parse(fs.readFileSync(grindFil, "utf8")) as { godkand: boolean; utfall: string; fel: string[]; varningar: string[] }) : null;
  const pProd = prod.prepare("SELECT * FROM prospekt WHERE id = ?").get(s.prospektId) as { huvudinsikt: string | null };
  const dFynd = prod.prepare("SELECT * FROM fynd WHERE prospekt_id = ? ORDER BY id").all(s.prospektId) as FyndRad[];
  const dMejl = prod.prepare("SELECT * FROM mejl WHERE prospekt_id = ? AND typ = 'forsta' ORDER BY id DESC LIMIT 1").get(s.prospektId) as { amne: string; text: string; anvanda_fynd: string } | undefined;
  const dKost = prod.prepare("SELECT steg, modell, COUNT(*) n, COALESCE(SUM(kostnad_usd),0) usd FROM kostnader WHERE prospekt_id = ? GROUP BY steg, modell").all(s.prospektId) as { steg: string; modell: string; n: number; usd: number }[];
  const start = s.tider.start ? new Date(s.tider.start).getTime() : 0;
  const slut = s.tider.klar ?? s.tider.stoppad ?? s.tider.granskningsko ?? s.uppdaterad;
  return {
    doman: s.doman,
    kundtyp: pTest.kundtyp,
    steg: s.steg,
    forsok: s.forsok,
    sekunder: start ? Math.round((new Date(slut).getTime() - start) / 1000) : null,
    huvudinsikt: pTest.huvudinsikt ? (JSON.parse(pTest.huvudinsikt) as Huvudinsikt).text : null,
    fynd: fynd.map(fyndKort),
    bekraftade: fynd.filter((f) => f.verifierad === 1).length,
    djup3Bekraftat: fynd.some((f) => f.verifierad === 1 && f.djup === 3),
    upptrappad: null,
    valda: mejl ? (JSON.parse(mejl.anvanda_fynd) as string[]) : [],
    flerFynd: null,
    amne: mejl?.amne ?? null,
    mejl: mejl?.text ?? null,
    grind: grind ? { godkand: grind.godkand, godkandForstaForsoket: grind.godkand && s.forsok.utkast === 1, utfall: grind.utfall, fel: grind.fel, varningar: grind.varningar, forsok: s.forsok.utkast } : null,
    ingetMejl: mejl ? null : s.utfall,
    kostnad: [] as { steg: string; modell: string; n: number; usd: number }[],
    drift: {
      huvudinsikt: pProd.huvudinsikt ? (JSON.parse(pProd.huvudinsikt) as Huvudinsikt).text : null,
      fynd: dFynd.map(fyndKort),
      bekraftade: dFynd.filter((f) => f.verifierad === 1).length,
      djup3Bekraftat: dFynd.some((f) => f.verifierad === 1 && f.djup === 3),
      valda: dMejl ? (JSON.parse(dMejl.anvanda_fynd) as string[]) : [],
      amne: dMejl?.amne ?? null,
      mejl: dMejl?.text ?? null,
      grindForstaForsoket: true,
      kostnad: dKost,
    },
  };
});

const resultat = { etikett, installningar: { MODELLVAG: "session" }, analysmodell: "opus (session)", snabbModell: "haiku (session)", datum, sajter, verifiering: [] };
const bas = path.join(ut, `${datum}-${klockan}-${etikett}`);
fs.writeFileSync(`${bas}.json`, JSON.stringify(resultat, null, 2), "utf8");

const ja = (b: boolean | null) => (b === null ? "-" : b ? "ja" : "nej");
const rader = [`# Pass utan API, ${datum}`, "", `Datamapp: ${DATA_DIR}. Driften (API) ur data/granskaren.db.`, "", "| Sajt | Fynd | Bekräftade | Djup 3 | Grind första försöket | Utfall | Försök a/v/u/g | Tid | Drift: fynd | Drift: bekräftade |", "|---|---|---|---|---|---|---|---|---|---|"];
for (const s of sajter) {
  rader.push(`| ${s.doman} | ${s.fynd.length} | ${s.bekraftade} (${Math.round((100 * s.bekraftade) / Math.max(1, s.fynd.length))} %) | ${ja(s.djup3Bekraftat)} | ${s.grind ? ja(s.grind.godkandForstaForsoket) : "-"} | ${s.grind?.utfall ?? s.ingetMejl ?? s.steg} | ${s.forsok.analys}/${s.forsok.verifiering}/${s.forsok.utkast}/${s.forsok.grind} | ${s.sekunder ?? "-"} s | ${s.drift.fynd.length} | ${s.drift.bekraftade} (${Math.round((100 * s.drift.bekraftade) / Math.max(1, s.drift.fynd.length))} %) |`);
}
rader.push("");
for (const s of sajter) {
  rader.push(`## ${s.doman}`, "", `**Huvudinsikt drift:** ${s.drift.huvudinsikt ?? "(ingen)"}`, "", `**Huvudinsikt pass:** ${s.huvudinsikt ?? "(ingen)"}`, "");
  rader.push("**Fynd pass**", "", ...s.fynd.map((x) => `- ${x.verifierad ? "ok " : "NEJ"} ${x.id} ${x.omrade} djup ${x.djup}: ${x.rubrik}${x.not ? ` _(${x.not.slice(0, 160)})_` : ""}`), "");
  rader.push("**Mejl drift**", "", "```", s.drift.mejl ?? "(inget)", "```", "", "**Mejl pass**", "", "```", s.mejl ?? `(inget: ${s.ingetMejl})`, "```", "");
  if (s.grind?.varningar.length) rader.push(`Varningar: ${s.grind.varningar.join("; ")}`, "");
  if (s.grind && !s.grind.godkand) rader.push(`Grindfel: ${s.grind.fel.join("; ")}`, "");
}
fs.writeFileSync(`${bas}.md`, rader.join("\n"), "utf8");
console.log(`Klart. ${bas}.md`);
prod.close();
