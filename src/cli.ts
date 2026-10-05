import fs from "node:fs";
import { Command } from "commander";
import { granskaProspekt } from "./audit.js";
import { konfig } from "./config.js";
import { db } from "./db/index.js";
import { allaProspekt, hamtaProspektViaDoman, laggTillSparr, loggaHandelse, prospektMedStatus, sattStatus } from "./db/fragor.js";
import { importeraFil } from "./discover/import.js";
import { rapportSokvag } from "./report/rapport.js";
import { normaliseraDoman } from "./util/domain.js";
import { logg } from "./util/logg.js";

const program = new Command();
program.name("granskaren").description("Webbgranskning och personlig outreach för RK Kommunikation").version("0.1.0");

program
  .command("import")
  .argument("<fil>", "CSV-fil med kolumnerna url, namn, bransch, ort, kommentar")
  .description("Läser in en lista med sajter")
  .action((fil: string) => {
    konfig();
    const d = db();
    const r = importeraFil(d, fil);
    logg.info(`Tillagda: ${r.tillagda.length}, dubbletter: ${r.dubbletter.length}, ogiltiga: ${r.ogiltiga.length}`);
    for (const x of r.tillagda) console.log(`  + ${x}`);
    for (const x of r.dubbletter) console.log(`  = ${x} (fanns redan)`);
    for (const x of r.ogiltiga) console.log(`  ! ${x} (ogiltig adress)`);
  });

program
  .command("audit")
  .description("Hämtar, mäter, analyserar och verifierar sajter med status ny eller kvalificerad")
  .option("--antal <n>", "högsta antal sajter att granska", "5")
  .option("--doman <doman>", "granska bara den här domänen")
  .option("--igen", "granska om även sajter som redan är granskade eller hoppade", false)
  .option("--utan-modell", "hämta och mät men hoppa över analys med språkmodell", false)
  .option("--utan-lighthouse", "hoppa över Lighthouse (snabbare)", false)
  .action(async (o: { antal: string; doman?: string; igen: boolean; utanModell: boolean; utanLighthouse: boolean }) => {
    konfig();
    const d = db();
    const antal = Math.max(1, Number.parseInt(o.antal, 10) || 5);
    let lista;
    if (o.doman) {
      const dom = normaliseraDoman(o.doman);
      const p = dom ? hamtaProspektViaDoman(d, dom) : undefined;
      if (!p) {
        logg.fel(`Domänen ${o.doman} finns inte i databasen. Importera den först.`);
        process.exitCode = 1;
        return;
      }
      if (!o.igen && !["ny", "kvalificerad"].includes(p.status)) {
        logg.fel(`${p.doman} har status ${p.status}. Använd --igen för att granska om.`);
        process.exitCode = 1;
        return;
      }
      lista = [p];
    } else {
      lista = prospektMedStatus(d, o.igen ? ["ny", "kvalificerad", "granskad", "hoppad"] : ["ny", "kvalificerad"], antal);
    }
    if (lista.length === 0) {
      logg.info("Inga sajter att granska. Importera en lista först.");
      return;
    }
    logg.info(`${lista.length} sajt(er) att granska`);
    const utfall = { granskad: 0, hoppad: 0, fel: 0 };
    for (const p of lista) {
      try {
        const r = await granskaProspekt(d, p, { utanModell: o.utanModell, utanLighthouse: o.utanLighthouse });
        utfall[r]++;
      } catch (e) {
        utfall.fel++;
        const msg = e instanceof Error ? e.message : String(e);
        logg.fel(`${p.doman}: ${msg}`);
        loggaHandelse(d, p.id, "fel", msg);
      }
    }
    logg.info(`Klart. Granskade: ${utfall.granskad}, hoppade: ${utfall.hoppad}, fel: ${utfall.fel}`);
  });

program
  .command("report")
  .argument("<doman>", "domän")
  .description("Skriver ut rapporten för en sajt")
  .action((doman: string) => {
    const dom = normaliseraDoman(doman) ?? doman;
    const fil = rapportSokvag(dom);
    if (!fs.existsSync(fil)) {
      logg.fel(`Ingen rapport för ${dom}. Kör granskaren audit --doman ${dom} först.`);
      process.exitCode = 1;
      return;
    }
    console.log(fs.readFileSync(fil, "utf8"));
    console.error(`\nRapporten finns i ${fil}`);
  });

program
  .command("block")
  .argument("<varde>", "domän eller mejladress")
  .option("--orsak <text>", "orsak", "manuellt tillagd")
  .description("Lägger till på spärrlistan")
  .action((varde: string, o: { orsak: string }) => {
    const d = db();
    const v = varde.includes("@") ? varde.toLowerCase().trim() : (normaliseraDoman(varde) ?? varde.toLowerCase().trim());
    const ny = laggTillSparr(d, v, o.orsak);
    const p = v.includes("@") ? undefined : hamtaProspektViaDoman(d, v);
    if (p) {
      sattStatus(d, p.id, "sparrad");
      loggaHandelse(d, p.id, "sparrad", o.orsak);
    }
    logg.info(ny ? `${v} tillagd på spärrlistan.` : `${v} fanns redan på spärrlistan.`);
  });

program
  .command("status")
  .description("Visar läget och mätpunkterna")
  .action(() => {
    const k = konfig();
    const d = db();
    const alla = allaProspekt(d);
    const per = new Map<string, number>();
    for (const p of alla) per.set(p.status, (per.get(p.status) ?? 0) + 1);
    const granskade = alla.filter((p) => p.granskad).length;
    const kost = d.prepare("SELECT COALESCE(SUM(kostnad_usd),0) AS s, COALESCE(SUM(tokens_in),0) AS i, COALESCE(SUM(tokens_ut),0) AS u FROM kostnader").get() as { s: number; i: number; u: number };
    const skickade = (d.prepare("SELECT COUNT(*) AS n FROM mejl WHERE typ='forsta' AND status='skickad'").get() as { n: number }).n;
    const svar = per.get("svar") ?? 0;
    const studs = per.get("studs") ?? 0;
    const sparr = (d.prepare("SELECT COUNT(*) AS n FROM sparrlista").get() as { n: number }).n;

    console.log(`Läge: ${k.SANDLAGE}, torrkörning: ${k.TORRKORNING ? "på" : "AV"}, modell: ${k.MODEL_ANALYS} / ${k.MODEL_SNABB}`);
    console.log("");
    console.log("Prospekt per status");
    for (const s of ["ny", "kvalificerad", "hoppad", "granskad", "utkast", "i_granskning", "koad", "skickad", "svar", "studs", "sparrad"]) {
      console.log(`  ${s.padEnd(14)} ${per.get(s) ?? 0}`);
    }
    console.log("");
    console.log("Mätpunkter");
    console.log(`  Granskade sajter        ${granskade}`);
    console.log(`  Skickade mejl           ${skickade}`);
    console.log(`  Svarsfrekvens           ${skickade ? `${Math.round((svar / skickade) * 100)} %` : "-"}`);
    console.log(`  Andel studsar           ${skickade ? `${Math.round((studs / skickade) * 100)} %` : "-"}`);
    console.log(`  Spärrlista              ${sparr}`);
    console.log(`  API-kostnad totalt      ${kost.s.toFixed(2)} USD (${kost.i} tokens in, ${kost.u} ut)`);
    console.log(`  Kostnad per granskad    ${granskade ? `${(kost.s / granskade).toFixed(3)} USD` : "-"}`);
    const hoppade = alla.filter((p) => p.status === "hoppad");
    if (hoppade.length) {
      console.log("");
      console.log("Hoppade sajter");
      for (const p of hoppade) console.log(`  ${p.doman}: ${p.orsak_hoppad}`);
    }
  });

program.parseAsync(process.argv).catch((e) => {
  logg.fel(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
