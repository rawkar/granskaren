/**
 * Kvotmätning för passet: Rawaz läser av hur stor andel av sessionsgränsen som är kvar (/usage) före och efter
 * passet. Före-värdet sparas i passets mapp, efter-värdet ger förbrukningen, som loggas per sajt i
 * data/jamforelse/kvot-logg.csv. Snittet över alla loggade pass skrivs ut, så att antalet sajter per pass kan
 * sättas efter mätning i stället för gissning.
 */
import fs from "node:fs";
import path from "node:path";
import { dataMapp, lasJson, skrivJson } from "../util/fil.js";
import { passMapp, type SajtStatus } from "./pass.js";

export interface Kvotrad {
  datum: string;
  sajter: number;
  klara: number;
  andel_fore: number;
  andel_efter: number;
  forbrukning: number;
  per_sajt: number;
  kommentar: string;
}

export const KVOT_LOGG = () => path.join(dataMapp("jamforelse"), "kvot-logg.csv");
const RUBRIK = "datum;sajter;klara;andel_fore;andel_efter;forbrukning_procent;per_sajt_procent;kommentar";

function kvotFil(datum: string): string {
  return path.join(passMapp(datum), "kvot.json");
}

/** Sparar andelen kvar av sessionsgränsen före passet. */
export function kvotFore(datum: string, andel: number): string {
  const fil = kvotFil(datum);
  skrivJson(fil, { andel_fore: andel, tid: new Date().toISOString() });
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
      const [datum, sajter, klara, fore, efter, forbrukning, perSajt, ...rest] = rad.split(";");
      return { datum, sajter: Number(sajter), klara: Number(klara), andel_fore: Number(fore), andel_efter: Number(efter), forbrukning: Number(forbrukning), per_sajt: Number(perSajt), kommentar: rest.join(";") };
    });
}

/**
 * Räknar ut förbrukningen efter passet, lägger till en rad i kvot-logg.csv och returnerar raden och snittet per
 * sajt över alla loggade pass. Förbrukningen är andel före minus andel efter, i procentenheter av sessionsgränsen.
 */
export function kvotEfter(datum: string, andelEfter: number, kommentar = ""): { rad: Kvotrad; snitt: number; antalPass: number; fil: string } {
  const fil = kvotFil(datum);
  if (!fs.existsSync(fil)) throw new Error(`Ingen avläsning före passet sparad (${fil}). Kör pass kvot --fore <andel> när passet börjar.`);
  const { andel_fore } = lasJson<{ andel_fore: number }>(fil);
  const { sajter, klara } = passSajter(datum);
  const forbrukning = Math.round((andel_fore - andelEfter) * 10) / 10;
  const per_sajt = sajter ? Math.round((forbrukning / sajter) * 10) / 10 : 0;
  const rad: Kvotrad = { datum, sajter, klara, andel_fore, andel_efter: andelEfter, forbrukning, per_sajt, kommentar: kommentar.replace(/;/g, ",") };
  const logg = KVOT_LOGG();
  if (!fs.existsSync(logg)) fs.writeFileSync(logg, `${RUBRIK}\n`, "utf8");
  fs.appendFileSync(logg, `${[rad.datum, rad.sajter, rad.klara, rad.andel_fore, rad.andel_efter, rad.forbrukning, rad.per_sajt, rad.kommentar].join(";")}\n`, "utf8");
  const alla = lasKvotLogg().filter((r) => r.sajter > 0);
  const snitt = alla.length ? Math.round((alla.reduce((s, r) => s + r.per_sajt, 0) / alla.length) * 10) / 10 : 0;
  return { rad, snitt, antalPass: alla.length, fil: logg };
}

/** Så många sajter ryms i ett pass med marginal: kvarvarande andel delat med snittet per sajt, minus en femtedel. */
export function rymsSajter(andelKvar: number, snittPerSajt: number): number {
  if (snittPerSajt <= 0) return 0;
  return Math.max(0, Math.floor((andelKvar / snittPerSajt) * 0.8));
}

