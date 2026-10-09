/**
 * Jämför verifieringen i passet med verifieringen via API på exakt samma fynd.
 *
 *   npx tsx scripts/pass-verifieringstest.ts paket --sajter a.se,b.se      skriver paket med driftens fynd (från driftens databas)
 *   npx tsx scripts/pass-verifieringstest.ts jamfor --sajter a.se,b.se     läser underagentens verifiering.json och jämför per fynd
 *
 * Kör med GRANSKAREN_DATA pekande på testmappen och MODELLVAG=session. Paketen hamnar i <GRANSKAREN_DATA>/pass/<datum>/vtest/<domän>/.
 * Driftens fynd och verifieringsutfall läses alltid ur den riktiga databasen (data/granskaren.db), skrivskyddat.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";

const laget = process.argv[2];
const sajter = (process.argv[process.argv.indexOf("--sajter") + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!["paket", "jamfor"].includes(laget ?? "") || sajter.length === 0) throw new Error("Användning: paket|jamfor --sajter a.se,b.se");

const { DATA_DIR, ROT } = await import("../src/config.js");
const { lasPrompt } = await import("../src/analyze/klient.js");
const { VerifieringSchema } = await import("../src/analyze/schema.js");
const { kombineraVerifiering, verifieraMedKod, verifieringsUppgift } = await import("../src/analyze/verifiering.js");
const { underlagSokvag } = await import("../src/report/rapport.js");
const { filnamnSaker, lasJson, sakerstallMapp, skrivJson } = await import("../src/util/fil.js");
const { idag } = await import("../src/pass/pass.js");
type Underlag = import("../src/analyze/underlag.js").Underlag;
type Fynd = import("../src/analyze/schema.js").Fynd;
type FyndRad = import("../src/db/fragor.js").FyndRad;
type LankKontroll = import("../src/measure/lankar.js").LankKontroll;

const prod = new Database(path.join(ROT, "data", "granskaren.db"), { readonly: true });
const datum = idag();

function driftFynd(doman: string): { p: { id: number }; fynd: FyndRad[]; u: Underlag; lankar: LankKontroll[] } {
  const p = prod.prepare("SELECT id FROM prospekt WHERE doman = ?").get(doman) as { id: number } | undefined;
  if (!p) throw new Error(`${doman} saknas i driftens databas`);
  const fynd = prod.prepare("SELECT * FROM fynd WHERE prospekt_id = ? ORDER BY id").all(p.id) as FyndRad[];
  const u = lasJson<Underlag>(underlagSokvag(doman));
  const rad = prod.prepare("SELECT radata FROM matningar WHERE prospekt_id = ? AND verktyg = 'lankar' ORDER BY id DESC LIMIT 1").get(p.id) as { radata: string } | undefined;
  return { p, fynd, u, lankar: rad ? (JSON.parse(rad.radata) as LankKontroll[]) : [] };
}

function tillFynd(r: FyndRad): Fynd {
  return {
    id: r.fynd_id,
    omrade: r.omrade as Fynd["omrade"],
    tjansteomrade: r.tjansteomrade as Fynd["tjansteomrade"],
    rubrik: r.rubrik,
    observation: r.observation,
    belagg: { url: r.belagg_url, typ: r.belagg_typ as Fynd["belagg"]["typ"], varde: r.belagg_varde },
    belagg2: r.belagg2_url ? { url: r.belagg2_url, typ: r.belagg2_typ as Fynd["belagg"]["typ"], varde: r.belagg2_varde ?? "" } : null,
    effekt: r.effekt,
    atgard: r.atgard,
    allvar: r.allvar,
    sakerhet: r.sakerhet,
    latt_att_forklara: r.latt_att_forklara,
    djup: r.djup,
    insikt: r.insikt ?? "",
    rotorsak: r.rotorsak,
    forslag_konkret: r.forslag_konkret,
    insats: (r.insats ?? "medel") as Fynd["insats"],
    kopplar_till_syfte: r.kopplar_till_syfte === 1,
  };
}

for (const doman of sajter) {
  const mapp = sakerstallMapp(path.join(DATA_DIR, "pass", datum, "vtest", filnamnSaker(doman)));
  const { fynd, u, lankar } = driftFynd(doman);
  const vMapp = sakerstallMapp(path.join(mapp, "verifiering"));
  const behover: Record<string, { kodNot: string; metod: "kod+modell" | "modell" }> = {};
  const klara: Record<string, boolean> = {};
  for (const r of fynd) {
    const f = tillFynd(r);
    const steg = verifieraMedKod(u, f, lankar);
    if (steg.klar) {
      klara[f.id] = steg.klar.verifierad;
      continue;
    }
    behover[f.id] = { kodNot: steg.kodNot, metod: steg.metod };
    if (laget === "paket") {
      const up = verifieringsUppgift(steg.sida, steg.sida2, f);
      let bildRad = "";
      if (up.skarmbild && up.skarmbildText) {
        const ext = path.extname(up.skarmbild) || ".png";
        fs.copyFileSync(up.skarmbild, path.join(vMapp, `${filnamnSaker(f.id)}-skarmbild${ext}`));
        bildRad = `${up.skarmbildText}\nBilden ligger i filen ${filnamnSaker(f.id)}-skarmbild${ext} i samma mapp. Läs den först.\n`;
      }
      fs.writeFileSync(path.join(vMapp, `${filnamnSaker(f.id)}.md`), [bildRad, up.text].filter(Boolean).join("\n"), "utf8");
    }
  }
  const ids = Object.keys(behover);
  if (laget === "paket") {
    fs.writeFileSync(path.join(mapp, "verifiering-system.md"), lasPrompt("verifiering"), "utf8");
    skrivJson(path.join(mapp, "verifiering-schema.json"), z.toJSONSchema(z.object(Object.fromEntries(ids.map((id) => [id, VerifieringSchema]))), { target: "draft-7" }));
    fs.writeFileSync(
      path.join(mapp, "verifiering-uppgift.md"),
      [`Kontrollera varje fynd nedan för sig, med bara det fyndets fil som underlag. Filerna ligger i mappen verifiering/.`, ...ids.map((id) => `- ${id}: verifiering/${filnamnSaker(id)}.md`), ``, `Svara i verifiering.json med ett objekt där varje nyckel är fyndets id och värdet följer verifiering-schema.json (bedomning och motivering).`].join("\n"),
      "utf8",
    );
    for (const f of ["verifiering.json"]) if (fs.existsSync(path.join(mapp, f))) fs.unlinkSync(path.join(mapp, f));
    console.log(`${doman}: ${fynd.length} fynd, ${Object.keys(klara).length} avgjorda av kod, ${ids.length} till modell (${ids.join(", ")}). Paket: ${mapp}`);
    continue;
  }
  // jämför
  const svar = z.object(Object.fromEntries(ids.map((id) => [id, VerifieringSchema]))).parse(JSON.parse(fs.readFileSync(path.join(mapp, "verifiering.json"), "utf8")));
  let lika = 0;
  const rader: string[] = [];
  for (const r of fynd) {
    const drift = r.verifierad === 1;
    let pass: boolean;
    let not = "";
    if (r.fynd_id in klara) {
      pass = klara[r.fynd_id];
      not = "kod";
    } else {
      const v = kombineraVerifiering({ kodNot: behover[r.fynd_id].kodNot, metod: behover[r.fynd_id].metod, sida: undefined as never, sida2: undefined }, svar[r.fynd_id]);
      pass = v.verifierad;
      not = `${svar[r.fynd_id].bedomning}: ${svar[r.fynd_id].motivering.slice(0, 140)}`;
    }
    if (pass === drift) lika++;
    rader.push(`   ${r.fynd_id} ${r.omrade} djup ${r.djup}: API ${drift ? "ok " : "nej"} | pass ${pass ? "ok " : "nej"}${pass === drift ? "" : "  <-- SKILJER"}  ${not}`);
  }
  console.log(`${doman}: lika ${lika} av ${fynd.length}`);
  for (const rad of rader) console.log(rad);
  skrivJson(path.join(mapp, "jamforelse.json"), { doman, lika, antal: fynd.length, rader });
}
prod.close();
