import type { FyndRad } from "../db/fragor.js";

const MANSKLIGA = new Set(["A", "C", "H"]);

export function poang(f: FyndRad): number {
  return f.allvar * f.sakerhet * f.latt_att_forklara;
}

/**
 * Väljer två eller tre bekräftade fynd till mejlet enligt avsnitt 9.1.
 * Returnerar tom lista om det inte finns minst två fynd med tillräcklig säkerhet.
 */
export function valjFynd(fynd: FyndRad[], minSakerhet = 0.7, antal = 3): FyndRad[] {
  const kandidater = fynd
    .filter((f) => f.verifierad === 1 && f.sakerhet >= minSakerhet)
    .sort((a, b) => poang(b) - poang(a));
  if (kandidater.length < 2) return [];

  const valda: FyndRad[] = [];
  const ta = (f: FyndRad) => {
    if (!valda.includes(f)) valda.push(f);
  };

  // 1. Minst ett fynd om budskap, innehåll eller vägen till handling om det finns
  const manskligt = kandidater.find((f) => MANSKLIGA.has(f.omrade));
  if (manskligt) ta(manskligt);

  // 2. Bästa fyndet totalt
  ta(kandidater[0]);

  // 3. Ett fynd från ett annat tjänsteområde än de redan valda, om det finns
  const omraden = new Set(valda.map((f) => f.tjansteomrade));
  const annat = kandidater.find((f) => !valda.includes(f) && !omraden.has(f.tjansteomrade));
  if (annat && valda.length < antal) ta(annat);

  // 4. Fyll upp till önskat antal med bästa återstående, helst sådant som är lätt att förklara
  for (const f of [...kandidater].sort((a, b) => b.latt_att_forklara - a.latt_att_forklara || poang(b) - poang(a))) {
    if (valda.length >= antal) break;
    ta(f);
  }

  // Undvik två fynd på samma sida om samma sak (samma område och samma belägg-URL)
  const unika: FyndRad[] = [];
  for (const f of valda) {
    if (unika.some((u) => u.omrade === f.omrade && u.belagg_url === f.belagg_url)) continue;
    unika.push(f);
  }
  return unika.length >= 2 ? unika.slice(0, antal) : [];
}
