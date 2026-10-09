import type { FyndRad } from "../db/fragor.js";
import type { Huvudinsikt } from "../analyze/schema.js";

export function poang(f: FyndRad): number {
  return f.allvar * f.sakerhet * f.latt_att_forklara * (f.djup === 3 ? 1.5 : f.djup === 2 ? 1.2 : 1);
}

export interface Valresultat {
  /** De valda fynden, huvudfyndet först. */
  fynd: FyndRad[];
  orsak: string | null; // varför inget mejl kan skrivas
  /** Fyndet mejlet ska öppna med: högst allvar bland de bekräftade fynden med djup 2 eller 3. */
  huvud: FyndRad | null;
}

/** Fynd som handlar om texten på en enskild knapp. Får inte bli huvudpoäng när ett lika stort eller större fynd finns. */
export function arKnapptext(f: Pick<FyndRad, "rubrik">): boolean {
  return /knapp/i.test(f.rubrik);
}

/**
 * Huvudfyndet: högst allvar bland kandidaterna med djup 2 eller 3. Vid lika allvar går texten på en enskild knapp
 * sist, därefter det som stöder huvudinsikten, därefter poäng.
 */
export function valjHuvudfynd(kandidater: FyndRad[], stodjer: Set<string>): FyndRad | null {
  const djupa = kandidater.filter((f) => f.djup >= 2);
  if (!djupa.length) return null;
  return [...djupa].sort(
    (a, b) =>
      b.allvar - a.allvar ||
      Number(arKnapptext(a)) - Number(arKnapptext(b)) ||
      Number(stodjer.has(b.fynd_id)) - Number(stodjer.has(a.fynd_id)) ||
      poang(b) - poang(a),
  )[0];
}

/**
 * Väljer två eller tre bekräftade fynd som stöder huvudinsikten, enligt avsnitt 8 i tillägget.
 * Minst ett fynd med djup 3, högst ett med djup 1 (och bara om det stöder huvudinsikten),
 * minst ett med konkret förslag, bara fynd som kopplar till sajtens syfte.
 */
export function valjFynd(fynd: FyndRad[], huvudinsikt: Huvudinsikt | null, minSakerhet = 0.7, antal = 3): Valresultat {
  const inget = (orsak: string): Valresultat => ({ fynd: [], orsak, huvud: null });
  if (!huvudinsikt) return inget("ingen huvudinsikt");

  const kandidater = fynd
    .filter((f) => f.verifierad === 1 && f.sakerhet >= minSakerhet && f.kopplar_till_syfte === 1)
    .sort((a, b) => poang(b) - poang(a));
  const stodjer = new Set(huvudinsikt.fynd_ids);
  const valda: FyndRad[] = [];
  const ta = (f: FyndRad | undefined) => {
    if (f && !valda.includes(f) && valda.length < antal) valda.push(f);
  };

  // 0. Huvudfyndet först: det mejlet ska öppna med
  const huvud = valjHuvudfynd(kandidater, stodjer);
  if (!huvud) return inget("inget bekräftat fynd med djup 3");
  ta(huvud);

  // 1. Minst ett fynd med djup 3, helst ett som stöder huvudinsikten
  ta(kandidater.find((f) => f.djup === 3 && stodjer.has(f.fynd_id)) ?? kandidater.find((f) => f.djup === 3));
  if (!valda.some((f) => f.djup === 3)) return inget("inget bekräftat fynd med djup 3");

  // 2. Fynden huvudinsikten bygger på, djupast först
  for (const f of kandidater.filter((f) => stodjer.has(f.fynd_id)).sort((a, b) => b.djup - a.djup || poang(b) - poang(a))) {
    if (f.djup === 1 && valda.some((v) => v.djup === 1)) continue;
    ta(f);
  }

  // 3. Minst ett fynd med konkret förslag
  if (!valda.some((f) => f.forslag_konkret)) {
    const medForslag = kandidater.find((f) => f.forslag_konkret && f.djup > 1 && !valda.includes(f));
    if (medForslag) {
      if (valda.length >= antal) valda.splice(valda.length - 1, 1, medForslag);
      else ta(medForslag);
    }
  }

  // 4. Fyll upp till minst två med bästa återstående djup 2 eller 3
  for (const f of kandidater) {
    if (valda.length >= 2) break;
    if (f.djup >= 2) ta(f);
  }

  // Regler i kod
  const unika = valda.filter((f, i) => valda.findIndex((x) => x.omrade === f.omrade && x.belagg_url === f.belagg_url) === i);
  if (unika.length < 2) return inget("färre än två bekräftade fynd som stöder huvudinsikten");
  if (!unika.some((f) => f.djup === 3)) return inget("inget fynd med djup 3 bland de valda");
  if (unika.filter((f) => f.djup === 1).length > 1) return inget("fler än ett fynd med djup 1");
  if (!unika.some((f) => stodjer.has(f.fynd_id))) return inget("inget av de valda fynden stöder huvudinsikten");
  return { fynd: unika.slice(0, antal), orsak: null, huvud };
}
