// Summerar tokens per moment ur huvudsessionens och underagenternas transkript. Momenten (lokal tid) anpassas i listan nedan.
import fs from "node:fs";
import path from "node:path";
const bas = "C:/Users/rawaz.karim/.claude/projects/c--Users-rawaz-karim-OneDrive---Trygghetsr-det-TRS-Arbetsmapp-Web-Dev-Kod-Rawaz-Karim-kommunikation-Granskaren";
// Användning: node scripts/kvot.mjs <sessions-id> [datum]  (sessionens id är filnamnet utan .jsonl i ~/.claude/projects/<projekt>/)
const sid = process.argv[2] ?? "189f1439-8dfe-423a-aa03-0b1624ddb24b";
const DATUM = process.argv[3] ?? "2026-10-09";
const sub = path.join(bas, sid, "subagents");
const lokal = (iso) => new Date(iso).toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" });
const dag = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
// Moment i dag (lokal tid)
const moment = [
  ["morgon: status, bekräftelse, start av API-körningen", "08:00", "09:10"],
  ["bygge av passet (kod)", "09:10", "09:30"],
  ["TESTPASSET 5 sajter inkl verifieringstest", "09:30", "09:52"],
  ["A till D: faktakontroll, discover-omkörning, kvot, rapport", "09:52", "10:30"],
  ["OMSKRIVNING 1 (ton) 5 mejl", "10:30", "10:45"],
  ["tonregler: kod, rapport, tonjämförelse", "10:45", "10:52"],
  ["fem justeringar: kod, tester, kopia, paket", "10:52", "11:05"],
  ["OMSKRIVNING 2 (avbruten av sessionsgränsen)", "11:05", "11:08"],
  ["rapport, kvotmätning, varianter", "11:08", "23:59"],
];
const tom = () => ({ in: 0, cacheW: 0, cacheR: 0, out: 0, anrop: 0, agenter: 0 });
const huvud = Object.fromEntries(moment.map((m) => [m[0], tom()]));
const agent = Object.fromEntries(moment.map((m) => [m[0], tom()]));
const vilket = (iso) => { const t = lokal(iso); return moment.find((m) => t >= m[1] && t < m[2])?.[0]; };
const lagg = (mal, u) => { mal.in += u.input_tokens ?? 0; mal.cacheW += u.cache_creation_input_tokens ?? 0; mal.cacheR += u.cache_read_input_tokens ?? 0; mal.out += u.output_tokens ?? 0; mal.anrop++; };
function gaIgenom(fil, mal, sidechainOk) {
  const seen = new Set(); let forsta = null;
  for (const rad of fs.readFileSync(fil, "utf8").split("\n")) {
    if (!rad) continue; let j; try { j = JSON.parse(rad); } catch { continue; }
    const m = j.message; if (!m || !m.usage || j.type !== "assistant" || (!sidechainOk && j.isSidechain)) continue;
    if (dag(j.timestamp) !== DATUM) continue;
    const key = m.id ?? j.uuid; if (seen.has(key)) continue; seen.add(key);
    forsta ??= j.timestamp;
    const k = vilket(j.timestamp); if (!k) continue;
    lagg(mal[k], m.usage);
  }
  return forsta;
}
gaIgenom(path.join(bas, `${sid}.jsonl`), huvud, false);
let igar = 0;
for (const f of fs.readdirSync(sub).filter((f) => f.endsWith(".jsonl"))) {
  const forsta = gaIgenom(path.join(sub, f), agent, true);
  if (forsta) agent[vilket(forsta)].agenter++;
}
const fmt = (n) => n.toLocaleString("sv-SE");
const tot = tom(); const totA = tom();
console.log("| Moment | Huvudsession anrop | in | cache-skrivning | cache-läsning | ut | Agenter | agent in+cacheW | agent cacheR | agent ut |");
for (const [k] of moment) {
  const h = huvud[k], a = agent[k];
  for (const x of ["in","cacheW","cacheR","out","anrop"]) { tot[x] += h[x]; totA[x] += a[x]; } totA.agenter += a.agenter;
  console.log(`| ${k} | ${h.anrop} | ${fmt(h.in)} | ${fmt(h.cacheW)} | ${fmt(h.cacheR)} | ${fmt(h.out)} | ${a.agenter} | ${fmt(a.in + a.cacheW)} | ${fmt(a.cacheR)} | ${fmt(a.out)} |`);
}
console.log(`| SUMMA | ${tot.anrop} | ${fmt(tot.in)} | ${fmt(tot.cacheW)} | ${fmt(tot.cacheR)} | ${fmt(tot.out)} | ${totA.agenter} | ${fmt(totA.in + totA.cacheW)} | ${fmt(totA.cacheR)} | ${fmt(totA.out)} |`);
const allt = tot.in + tot.cacheW + tot.cacheR + tot.out + totA.in + totA.cacheW + totA.cacheR + totA.out;
console.log("Totalt alla tokens i dag (in + cache-skrivning + cache-läsning + ut, huvudsession + agenter):", fmt(allt));
console.log("Huvudsessionen utan cache-läsning:", fmt(tot.in + tot.cacheW + tot.out), " agenter utan cache-läsning:", fmt(totA.in + totA.cacheW + totA.out));
