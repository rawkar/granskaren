/**
 * Kvotmätning för passet: Rawaz läser av /usage före och efter passet, två värden varje gång: andel kvar av
 * femtimmarssessionen och andel kvar av veckan. Före-värdena sparas i passets mapp, efter-värdena ger förbrukningen,
 * som loggas per sajt i data/jamforelse/kvot-logg.csv. Snitten över alla loggade pass skrivs ut, så att antalet
 * sajter per pass och antalet pass per vecka kan sättas efter mätning i stället för gissning.
 */
import fs from "node:fs";
import path from "node:path";
import { dataMapp, lasJson, skrivJson } from "../util/fil.js";
import { passMapp, type SajtStatus } from "./pass.js";

/** Andel kvar i procent, för sessionen och veckan. */
export interface Avlasning {
  session: number;
  vecka: number;
}

export interface Kvotrad {
  datum: string;
  sajter: number;
  klara: number;
  fore: Avlasning;
  efter: Avlasning;
  /** Förbrukning i procentenheter av respektive gräns. */
  forbrukning: Avlasning;
  per_sajt: Avlasning;
  kommentar: string;
}

export interface Kvotsnitt {
  antalPass: number;
  /** Snittförbrukning per sajt i procentenheter, session och vecka. */
  perSajt: Avlasning;
}

/** Antal sajter i ett vanligt pass, används för att säga hur många pass veckan räcker till. */
export const SAJTER_PER_PASS = 8;

export const KVOT_LOGG = () => path.join(dataMapp("jamforelse"), "kvot-logg.csv");
const RUBRIK = "datum;sajter;klara;session_fore;session_efter;session_forbrukning;session_per_sajt;vecka_fore;vecka_efter;vecka_forbrukning;vecka_per_sajt;kommentar";

const avrunda = (n: number) => Math.round(n * 10) / 10;

function kvotFil(datum: string): string {
  return path.join(passMapp(datum), "kvot.json");
}

/** Sparar andelen kvar av sessionen och veckan före passet. */
export function kvotFore(datum: string, fore: Avlasning): string {
  const fil = kvotFil(datum);
  skrivJson(fil, { fore, tid: new Date().toISOString() });
  return fil;
}

/** Sajterna i dagens pass: alla med statusfil, och hur många som nått ett slutsteg. */
export function passSajter(datum: string): { sajter: number; klara: number } {
  const mapp = passMapp(datum);
  if (!fs.existsSync(mapp)) return { sajter: 0, klara: 0 };
  let sajter = 0;
  let klara = 0;
  for (const namn of fs.readdirSync(mapp)) {
    const statusFil = path.join(mapp, namn, "status.json");
    if (!fs.existsSync(statusFil)) continue;
    sajter++;
    const s = lasJson<SajtStatus>(statusFil);
    if (["klar", "stoppad", "granskningsko", "hoppad"].includes(s.steg)) klara++;
  }
  return { sajter, klara };
}

export function lasKvotLogg(): Kvotrad[] {
  const fil = KVOT_LOGG();
  if (!fs.existsSync(fil)) return [];
  return fs
    .readFileSync(fil, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((rad) => {
      const [datum, sajter, klara, sf, se, sfb, sps, vf, ve, vfb, vps, ...rest] = rad.split(";");
      return {
        datum,
        sajter: Number(sajter),
        klara: Number(klara),
        fore: { session: Number(sf), vecka: Number(vf) },
        efter: { session: Number(se), vecka: Number(ve) },
        forbrukning: { session: Number(sfb), vecka: Number(vfb) },
        per_sajt: { session: Number(sps), vecka: Number(vps) },
        kommentar: rest.join(";"),
      };
    });
}

/** Snittförbrukning per sajt över alla loggade pass med minst en sajt. */
export function kvotSnitt(rader: Kvotrad[] = lasKvotLogg()): Kvotsnitt {
  const alla = rader.filter((r) => r.sajter > 0);
  if (!alla.length) return { antalPass: 0, perSajt: { session: 0, vecka: 0 } };
  const snitt = (v: (r: Kvotrad) => number) => avrunda(alla.reduce((s, r) => s + v(r), 0) / alla.length);
  return { antalPass: alla.length, perSajt: { session: snitt((r) => r.per_sajt.session), vecka: snitt((r) => r.per_sajt.vecka) } };
}

/**
 * Räknar ut förbrukningen efter passet, lägger till en rad i kvot-logg.csv och returnerar raden och snitten.
 * Förbrukningen är andel före minus andel efter, i procentenheter av respektive gräns.
 */
export function kvotEfter(datum: string, efter: Avlasning, kommentar = ""): { rad: Kvotrad; snitt: Kvotsnitt; fil: string } {
  const fil = kvotFil(datum);
  if (!fs.existsSync(fil)) throw new Error(`Ingen avläsning före passet sparad (${fil}). Kör pass kvot --fore <session> --vecka <vecka> när passet börjar.`);
  const { fore } = lasJson<{ fore: Avlasning }>(fil);
  const { sajter, klara } = passSajter(datum);
  const forbrukning = { session: avrunda(fore.session - efter.session), vecka: avrunda(fore.vecka - efter.vecka) };
  const per_sajt = { session: sajter ? avrunda(forbrukning.session / sajter) : 0, vecka: sajter ? avrunda(forbrukning.vecka / sajter) : 0 };
  const rad: Kvotrad = { datum, sajter, klara, fore, efter, forbrukning, per_sajt, kommentar: kommentar.replace(/;/g, ",") };
  const logg = KVOT_LOGG();
  if (!fs.existsSync(logg)) fs.writeFileSync(logg, `${RUBRIK}\n`, "utf8");
  fs.appendFileSync(
    logg,
    `${[rad.datum, rad.sajter, rad.klara, fore.session, efter.session, forbrukning.session, per_sajt.session, fore.vecka, efter.vecka, forbrukning.vecka, per_sajt.vecka, rad.kommentar].join(";")}\n`,
    "utf8",
  );
  return { rad, snitt: kvotSnitt(), fil: logg };
}

/** Så många sajter ryms i en session med marginal: kvarvarande andel delat med snittet per sajt, minus en femtedel. */
export function rymsSajter(andelKvar: number, snittPerSajt: number): number {
  if (snittPerSajt <= 0) return 0;
  return Math.max(0, Math.floor((andelKvar / snittPerSajt) * 0.8));
}

/** Så många pass på sajterPerPass sajter räcker veckan till, från kvarvarande andel av veckan och snittet per sajt. */
export function rymsPass(andelKvarVecka: number, snittPerSajtVecka: number, sajterPerPass = SAJTER_PER_PASS): number {
  if (snittPerSajtVecka <= 0 || sajterPerPass <= 0) return 0;
  return Math.max(0, Math.floor(andelKvarVecka / (snittPerSajtVecka * sajterPerPass)));
}

/** Texten som visas efter en mätning: snitt per sajt för båda gränserna, sajter per session och pass per vecka. */
export function kvotSammanfattning(snitt: Kvotsnitt, kvar: Avlasning): string {
  if (!snitt.antalPass) return "Ingen tidigare mätning: välj antal sajter enligt tabellen i /dagens.";
  const rader = [
    `Snitt över ${snitt.antalPass} pass: ${snitt.perSajt.session} procentenheter av sessionen och ${snitt.perSajt.vecka} av veckan per sajt.`,
    `Med ${kvar.session} procent kvar av sessionen ryms ${rymsSajter(kvar.session, snitt.perSajt.session)} sajter med marginal.`,
  ];
  if (snitt.perSajt.vecka > 0) {
    rader.push(
      `Ett pass på ${SAJTER_PER_PASS} sajter drar ${avrunda(snitt.perSajt.vecka * SAJTER_PER_PASS)} procent av veckan. Med ${kvar.vecka} procent kvar räcker veckan till ${rymsPass(kvar.vecka, snitt.perSajt.vecka)} sådana pass, en hel vecka till ${rymsPass(100, snitt.perSajt.vecka)}.`,
    );
  } else rader.push("Veckoförbrukningen per sajt är 0 i mätningen, så veckan sätter ingen gräns än.");
  return rader.join("\n");
}
