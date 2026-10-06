import fs from "node:fs";
import path from "node:path";
import { granskaProspekt } from "./audit.js";
import { DATA_DIR, konfig } from "./config.js";
import type { Db } from "./db/index.js";
import { loggaHandelse, prospektMedStatus, type Prospekt } from "./db/fragor.js";
import { discover } from "./discover/discover.js";
import { likhetsprofiler } from "./discover/forebilder.js";
import { hinder, inomFonster, arVardag, nastaKoade, skickaEtt, skickadeIdag, slumpadPausMs } from "./email/skicka.js";
import { skapaUtkast } from "./email/utkast.js";
import { logg, paus } from "./util/logg.js";

export interface RunAlternativ {
  enGang?: boolean; // ett varv och sedan klart, i stället för att hålla på till fönstret stänger
  utanDiscover?: boolean;
}

/**
 * Helautomatisk dag: håller kön fylld (discover -> audit -> draft) och skickar ett mejl i taget
 * med slumpad paus tills det dagliga taket är nått eller sändfönstret stänger.
 * Allt som hamnar under säkerhetsgränsen ligger kvar i granskningskön för Rawaz.
 */
const LASFIL = path.join(DATA_DIR, "run.lock");

/** Bara en run åt gången. Låsfilen innehåller processens id, en död process räknas inte som lås. */
function taLas(): boolean {
  try {
    if (fs.existsSync(LASFIL)) {
      const pid = Number.parseInt(fs.readFileSync(LASFIL, "utf8"), 10);
      if (Number.isFinite(pid) && pid !== process.pid && processLever(pid)) return false;
    }
    fs.writeFileSync(LASFIL, String(process.pid), "utf8");
    return true;
  } catch {
    return true;
  }
}

function processLever(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function slappLas(): void {
  try {
    if (fs.existsSync(LASFIL) && fs.readFileSync(LASFIL, "utf8") === String(process.pid)) fs.unlinkSync(LASFIL);
  } catch {
    // ignorera
  }
}

export async function run(d: Db, alt: RunAlternativ = {}): Promise<void> {
  if (!taLas()) {
    logg.varning("En run pågår redan (se data/run.lock). Avbryter.");
    return;
  }
  process.on("exit", slappLas);
  try {
    await runInre(d, alt);
  } finally {
    slappLas();
  }
}

async function runInre(d: Db, alt: RunAlternativ): Promise<void> {
  const k = konfig();
  logg.info(`run startar. Läge ${k.SANDLAGE}, torrkörning ${k.TORRKORNING ? "PÅ" : "av"}, tak ${k.MAX_MEJL_PER_DAG} per dag, fönster ${k.SANDFONSTER_START} till ${k.SANDFONSTER_SLUT}, paus ${k.PAUS_MIN_MINUTER} till ${k.PAUS_MAX_MINUTER} minuter.`);
  if (k.SANDLAGE !== "auto") logg.varning("SANDLAGE är granska. Utkast hamnar i granskningskön och inget skickas förrän du godkänner dem.");

  let varv = 0;
  let felIRad = 0;
  for (;;) {
    varv++;
    const nu = new Date();
    if (!arVardag(nu)) {
      logg.info("Inte en vardag, inget skickas.");
      break;
    }
    if (!inomFonster(nu, k.SANDFONSTER_START, k.SANDFONSTER_SLUT)) {
      logg.info("Utanför sändfönstret. Klart för i dag.");
      break;
    }
    const kvar = k.MAX_MEJL_PER_DAG - skickadeIdag(d, nu);
    if (kvar <= 0) {
      logg.info(`Dagens tak på ${k.MAX_MEJL_PER_DAG} mejl är nått. Klart för i dag.`);
      break;
    }

    try {
      // 1. Finns något köat? Skicka det.
      let m = nastaKoade(d);
      if (!m) {
        // 2. Annars: fyll på kön genom att granska och skriva utkast för nästa prospekt
        const fyllt = await fyllKo(d, alt);
        m = nastaKoade(d);
        if (!m && !fyllt) {
          logg.info("Inget mer att göra just nu. Granskningskön kan behöva gås igenom med review.");
          break;
        }
        if (!m) continue;
      }
      const stopp = hinder(d, k, m);
      if (stopp) {
        logg.info(`   ${m.mottagare}: ${stopp}`);
        if (/fönstret|vardag|tak/.test(stopp)) break;
        d.prepare("UPDATE mejl SET status = 'stoppad' WHERE id = ?").run(m.id);
        loggaHandelse(d, m.prospekt_id, "stoppad_vid_utskick", stopp);
        continue;
      }
      const utfall = await skickaEtt(d, m);
      felIRad = 0;
      if (utfall === "stoppad") continue;
      if (alt.enGang) break;
      const ms = slumpadPausMs();
      logg.info(`   pausar ${Math.round(ms / 60000)} minuter (${kvar - 1} kvar i dag)`);
      await paus(ms);
    } catch (e) {
      felIRad++;
      logg.fel(`varv ${varv}: ${e instanceof Error ? e.message : String(e)}`);
      if (felIRad >= 5) {
        logg.fel("Fem fel i rad, avbryter dagens körning.");
        break;
      }
      await paus(60_000);
    }
  }
  logg.info(`run klart. Skickade i dag: ${skickadeIdag(d)}.`);
}

/** Granskar och skriver utkast för nästa prospekt. Letar upp nya om det inte finns några. Returnerar true om något gjordes. */
async function fyllKo(d: Db, alt: RunAlternativ): Promise<boolean> {
  const k = konfig();
  // Prospekt som är granskade men ännu inte har något mejl och inte är markerade endast_formular
  const utanMejl = d
    .prepare(
      `SELECT * FROM prospekt p WHERE p.status = 'granskad'
         AND (p.orsak_hoppad IS NULL OR p.orsak_hoppad != 'endast_formular')
         AND NOT EXISTS (SELECT 1 FROM mejl m WHERE m.prospekt_id = p.id AND m.typ = 'forsta')
       ORDER BY p.id LIMIT 3`,
    )
    .all() as Prospekt[];
  for (const p of utanMejl) {
    const u = await skapaUtkast(d, p);
    if (u && u.grind.utfall === "koad") return true;
  }
  // Nya prospekt att granska
  const nya = prospektMedStatus(d, ["ny", "kvalificerad"], 1);
  if (nya.length > 0) {
    const p = nya[0];
    const r = await granskaProspekt(d, p);
    if (r === "granskad") {
      const uppdaterad = prospektMedStatus(d, "granskad").find((x) => x.id === p.id);
      if (uppdaterad) await skapaUtkast(d, uppdaterad);
    }
    return true;
  }
  if (alt.utanDiscover) return false;
  if (likhetsprofiler(d).length === 0) {
    logg.varning("Inga förebilder är profilerade, kan inte leta nya prospekt. Kör: granskaren forebilder");
    return false;
  }
  logg.steg(`letar ${k.DISCOVER_ANTAL} nya prospekt`);
  const r = await discover(d, { antal: k.DISCOVER_ANTAL, kallor: ["webb", "lankar"] });
  return r.godkanda > 0;
}
