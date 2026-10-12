import type { FyndRad } from "../db/fragor.js";

export interface Valresultat {
  /** De valda fynden, huvudfyndet först. */
  fynd: FyndRad[];
  orsak: string | null; // varför inget mejl kan skrivas
  /** Fyndet mejlet öppnar med: högst allvar bland de bekräftade fynden. */
  huvud: FyndRad | null;
}

/** Fynd som handlar om texten på en enskild knapp. Får inte bli huvudpoäng när ett lika stort eller större fynd finns. */
export function arKnapptext(f: Pick<FyndRad, "rubrik">): boolean {
  return /knapp/i.test(f.rubrik);
}

/** Ordningen fynden får i mejlet: högst allvar först, en knapptext sist vid lika allvar, därefter analysens ordning. */
export function sorteraFynd(fynd: FyndRad[]): FyndRad[] {
  return [...fynd].sort((a, b) => b.allvar - a.allvar || Number(arKnapptext(a)) - Number(arKnapptext(b)) || a.id - b.id);
}

/**
 * Väljer två eller tre bekräftade fynd till mejlet. Ett mejl skrivs när sajten har minst två bekräftade fynd,
 * oavsett djup. Huvudfyndet är det med högst allvar och står först. Fynd med samma område och sida räknas som ett.
 */
export function valjFynd(fynd: FyndRad[], antal = 3): Valresultat {
  const inget = (orsak: string): Valresultat => ({ fynd: [], orsak, huvud: null });
  const bekraftade = sorteraFynd(fynd.filter((f) => f.verifierad === 1));
  const unika = bekraftade.filter((f, i) => bekraftade.findIndex((x) => x.omrade === f.omrade && x.belagg_url === f.belagg_url) === i);
  if (unika.length < 2) return inget(`bara ${unika.length} bekräftat fynd, minst två krävs`);
  const valda = unika.slice(0, antal);
  return { fynd: valda, orsak: null, huvud: valda[0] };
}
