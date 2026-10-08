import { konfig, type Konfig } from "../config.js";
import type { Db } from "../db/index.js";
import { loggaHandelse } from "../db/fragor.js";
import { nyttMessageId, skickaBrev } from "../email/skicka.js";
import { logg } from "../util/logg.js";

/**
 * Uppföljning av ändringarna mot Opus-perioden och en vakt som pausar dem om kvaliteten sjunker.
 *
 * ANDRINGAR_FRAN i .env är dagen ändringarna slogs på. Allt före är Opus-perioden. Vakten jämför de senaste
 * sju dagarna med Opus-perioden: sjunker andelen bekräftade fynd mer än fem procentenheter, eller trappas mer än
 * var tredje sajt upp, pausas ändringarna, driften går tillbaka till Opus och Rawaz får ett mejl.
 */

export interface PeriodMatt {
  fran: string;
  till: string;
  skickade: number;
  granskade: number;
  fynd: number;
  bekraftade: number;
  upptrappade: number;
  utkast: number;
  stoppade: number;
  svar: number;
  kostnad: number;
  kostnadPerSteg: Record<string, number>;
}

/** Mått för perioden fran (inklusive) till till (exklusive), datum som YYYY-MM-DD eller full tidsstämpel. */
export function periodMatt(d: Db, fran: string, till: string): PeriodMatt {
  const en = (sql: string) => (d.prepare(sql).get(fran, till) as { n: number }).n;
  const kostRader = d
    .prepare("SELECT steg, COALESCE(SUM(kostnad_usd),0) usd FROM kostnader WHERE tidpunkt >= ? AND tidpunkt < ? GROUP BY steg")
    .all(fran, till) as { steg: string; usd: number }[];
  const kostnadPerSteg: Record<string, number> = {};
  for (const r of kostRader) kostnadPerSteg[r.steg] = r.usd;
  return {
    fran,
    till,
    skickade: en("SELECT COUNT(*) n FROM mejl WHERE typ = 'forsta' AND status = 'skickad' AND skickad >= ? AND skickad < ?"),
    granskade: en("SELECT COUNT(*) n FROM prospekt WHERE granskad >= ? AND granskad < ?"),
    fynd: en("SELECT COUNT(*) n FROM fynd f JOIN prospekt p ON p.id = f.prospekt_id WHERE p.granskad >= ? AND p.granskad < ?"),
    bekraftade: en("SELECT COUNT(*) n FROM fynd f JOIN prospekt p ON p.id = f.prospekt_id WHERE p.granskad >= ? AND p.granskad < ? AND f.verifierad = 1"),
    upptrappade: en("SELECT COUNT(DISTINCT prospekt_id) n FROM handelser WHERE typ = 'upptrappning' AND tidpunkt >= ? AND tidpunkt < ?"),
    utkast: en("SELECT COUNT(*) n FROM handelser WHERE typ = 'utkast_skapat' AND tidpunkt >= ? AND tidpunkt < ?"),
    stoppade: en("SELECT COUNT(*) n FROM handelser WHERE typ = 'utkast_skapat' AND tidpunkt >= ? AND tidpunkt < ? AND json_extract(detaljer, '$.status') = 'utkast'"),
    svar: en("SELECT COUNT(*) n FROM handelser WHERE typ = 'svar' AND tidpunkt >= ? AND tidpunkt < ?"),
    kostnad: Object.values(kostnadPerSteg).reduce((s, x) => s + x, 0),
    kostnadPerSteg,
  };
}

export const andel = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const procent = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)} %`);
const usd = (x: number | null) => (x === null ? "-" : x.toFixed(3));

/** Hur många granskade sajter en vecka minst måste ha innan vakten dömer. */
export const VAKT_MIN_GRANSKADE = 5;
export const VAKT_MAX_TAPP_BEKRAFTADE = 0.05;
export const VAKT_MAX_ANDEL_UPPTRAPPADE = 1 / 3;

/** Skälen att pausa, eller tom lista. Ren funktion så att den går att testa. */
export function bedomVakt(opus: PeriodMatt, senaste: PeriodMatt, minGranskade = VAKT_MIN_GRANSKADE): string[] {
  const skal: string[] = [];
  if (senaste.granskade < minGranskade) return skal;
  const opusAndel = andel(opus.bekraftade, opus.fynd);
  const nyAndel = andel(senaste.bekraftade, senaste.fynd);
  if (opusAndel !== null && nyAndel !== null && nyAndel < opusAndel - VAKT_MAX_TAPP_BEKRAFTADE) {
    skal.push(`andelen bekräftade fynd är ${procent(nyAndel)} mot ${procent(opusAndel)} under Opus-perioden`);
  }
  const upp = andel(senaste.upptrappade, senaste.granskade);
  if (upp !== null && upp > VAKT_MAX_ANDEL_UPPTRAPPADE) {
    skal.push(`${senaste.upptrappade} av ${senaste.granskade} granskade sajter trappades upp till Opus`);
  }
  return skal;
}

export function idag(nu = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${nu.getFullYear()}-${p(nu.getMonth() + 1)}-${p(nu.getDate())}`;
}

function dagarSedan(n: number, nu = new Date()): string {
  return idag(new Date(nu.getTime() - n * 86_400_000));
}

/** Rader för veckorapporten: ändringarna mot Opus-perioden. Tom lista om ANDRINGAR_FRAN inte är satt. */
export function uppfoljningsRader(d: Db, k: Konfig = konfig(), nu = new Date()): string[] {
  if (!k.ANDRINGAR_FRAN) return [];
  const slut = idag(new Date(nu.getTime() + 86_400_000));
  const opus = periodMatt(d, "1970-01-01", k.ANDRINGAR_FRAN);
  const sedan = periodMatt(d, k.ANDRINGAR_FRAN, slut);
  const vecka = periodMatt(d, dagarSedan(7, nu), slut);
  const rader: string[] = [];
  rader.push(`Uppföljning av ändringarna sedan ${k.ANDRINGAR_FRAN}, mot Opus-perioden före`);
  const kol = (a: string, b: string, c: string, e: string) => `  ${a.padEnd(34)} ${b.padStart(10)} ${c.padStart(12)} ${e.padStart(12)}`;
  rader.push(kol("", "Opus", "Sedan", "Senaste 7 d"));
  rader.push(kol("Skickade mejl", String(opus.skickade), String(sedan.skickade), String(vecka.skickade)));
  rader.push(kol("Kostnad per skickat mejl, USD", usd(andel(opus.kostnad, opus.skickade)), usd(andel(sedan.kostnad, sedan.skickade)), usd(andel(vecka.kostnad, vecka.skickade))));
  const steg = [...new Set([...Object.keys(opus.kostnadPerSteg), ...Object.keys(sedan.kostnadPerSteg)])].sort();
  for (const s of steg) {
    rader.push(kol(`  varav ${s}`, usd(andel(opus.kostnadPerSteg[s] ?? 0, opus.skickade)), usd(andel(sedan.kostnadPerSteg[s] ?? 0, sedan.skickade)), usd(andel(vecka.kostnadPerSteg[s] ?? 0, vecka.skickade))));
  }
  rader.push(kol("Andel bekräftade fynd", procent(andel(opus.bekraftade, opus.fynd)), procent(andel(sedan.bekraftade, sedan.fynd)), procent(andel(vecka.bekraftade, vecka.fynd))));
  rader.push(kol("Andel sajter upptrappade till Opus", procent(andel(opus.upptrappade, opus.granskade)), procent(andel(sedan.upptrappade, sedan.granskade)), procent(andel(vecka.upptrappade, vecka.granskade))));
  rader.push(kol("Andel utkast stoppade av grinden", procent(andel(opus.stoppade, opus.utkast)), procent(andel(sedan.stoppade, sedan.utkast)), procent(andel(vecka.stoppade, vecka.utkast))));
  rader.push(kol("Svarsfrekvens", procent(andel(opus.svar, opus.skickade)), procent(andel(sedan.svar, sedan.skickade)), procent(andel(vecka.svar, vecka.skickade))));
  const skal = bedomVakt(opus, vecka);
  rader.push(skal.length ? `  Vakten: ${skal.join("; ")}` : `  Vakten: inget att anmärka på (dömer från ${VAKT_MIN_GRANSKADE} granskade sajter per vecka)`);
  const p = pausad(d);
  if (p) rader.push(`  Ändringarna är PAUSADE sedan ${p.datum}: ${p.skal.join("; ")}. Ta bort pausen med: granskaren paus --av`);
  return rader;
}

// ---------- paus ----------

export interface Paus {
  datum: string;
  skal: string[];
}

export function pausad(d: Db): Paus | null {
  const rad = d.prepare("SELECT varde FROM installningar WHERE nyckel = 'andringar_pausade'").get() as { varde: string } | undefined;
  if (!rad) return null;
  try {
    return JSON.parse(rad.varde) as Paus;
  } catch {
    return null;
  }
}

export function pausa(d: Db, skal: string[], nu = new Date()): Paus {
  const p: Paus = { datum: idag(nu), skal };
  d.prepare("INSERT INTO installningar (nyckel, varde, andrad) VALUES ('andringar_pausade', ?, datetime('now')) ON CONFLICT(nyckel) DO UPDATE SET varde = excluded.varde, andrad = excluded.andrad").run(JSON.stringify(p));
  loggaHandelse(d, null, "andringar_pausade", p);
  return p;
}

export function avbrytPaus(d: Db): boolean {
  const r = d.prepare("DELETE FROM installningar WHERE nyckel = 'andringar_pausade'").run();
  if (r.changes > 0) loggaHandelse(d, null, "andringar_ateraktiverade");
  return r.changes > 0;
}

/**
 * Är ändringarna pausade går driften tillbaka till Opus med promptens standardomfång. Skriver över den inlästa
 * konfigurationen för den här processen och returnerar pausen, annars null.
 */
export function tillampaPaus(d: Db): Paus | null {
  const p = pausad(d);
  if (!p) return null;
  const k = konfig();
  k.MODEL_ANALYS = k.MODEL_UPPTRAPPNING;
  k.ANALYS_MAX_FYND = 6;
  k.ANALYS_KORT = false;
  k.UPPTRAPPNING = false;
  k.MEJL_ORDMAL = 0;
  k.MEJL_MAX_ORD = 220;
  k.MEJL_FLER_FYND = false;
  logg.varning(`Ändringarna är pausade sedan ${p.datum} (${p.skal.join("; ")}). Kör med ${k.MODEL_ANALYS} och promptens standardomfång. Ta bort pausen med: granskaren paus --av`);
  return p;
}

/** Mejlar Rawaz på avsändaradressen. Loggar i stället om SMTP inte är inställt eller sändningen misslyckas. */
export async function mejlaRawaz(k: Konfig, amne: string, text: string): Promise<boolean> {
  const till = k.AVSANDARE_EPOST || k.SMTP_USER;
  if (!k.SMTP_HOST || !k.SMTP_USER || !k.SMTP_PASS || !till) {
    logg.varning(`Kan inte mejla Rawaz (SMTP saknas): ${amne}`);
    return false;
  }
  try {
    await skickaBrev(k, { till, amne, text, messageId: nyttMessageId(till) });
    logg.info(`Mejlade ${till}: ${amne}`);
    return true;
  } catch (e) {
    logg.fel(`Mejlet till Rawaz gick inte att skicka: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Körs när run startar. Är ändringarna på och vakten slår till pausas de, Rawaz mejlas och processen går vidare
 * på Opus. Är de redan pausade tillämpas pausen. Returnerar pausen om någon gäller.
 */
export async function vaktaOchPausa(d: Db, nu = new Date()): Promise<Paus | null> {
  const k = konfig();
  if (!pausad(d) && k.ANDRINGAR_FRAN) {
    const slut = idag(new Date(nu.getTime() + 86_400_000));
    const opus = periodMatt(d, "1970-01-01", k.ANDRINGAR_FRAN);
    const vecka = periodMatt(d, dagarSedan(7, nu), slut);
    const skal = bedomVakt(opus, vecka);
    if (skal.length) {
      const p = pausa(d, skal, nu);
      logg.fel(`Kvalitetsvakten pausar ändringarna: ${skal.join("; ")}`);
      await mejlaRawaz(
        k,
        "Granskaren har pausat ändringarna och gått tillbaka till Opus",
        [
          `Hej Rawaz,`,
          ``,
          `Kvalitetsvakten slog till ${p.datum} och ändringarna är pausade. Driften kör nu ${k.MODEL_UPPTRAPPNING} med promptens standardomfång tills du tar bort pausen.`,
          ``,
          `Skäl:`,
          ...skal.map((s) => `- ${s}`),
          ``,
          `Senaste sju dagarna: ${vecka.granskade} granskade sajter, ${vecka.bekraftade} av ${vecka.fynd} fynd bekräftade, ${vecka.upptrappade} upptrappade, ${vecka.skickade} skickade mejl.`,
          `Opus-perioden före ${k.ANDRINGAR_FRAN}: ${opus.granskade} granskade sajter, ${opus.bekraftade} av ${opus.fynd} fynd bekräftade.`,
          ``,
          `Se hela uppföljningen med: granskaren weekly`,
          `Ta bort pausen med: granskaren paus --av`,
          ``,
          `Granskaren`,
        ].join("\n"),
      );
    }
  }
  return tillampaPaus(d);
}
