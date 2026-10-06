import type { Db } from "../db/index.js";
import { aktuellFordelning, justeraFordelning, lasKundprofil, sparaFordelning } from "../discover/kundprofil.js";

export interface KundtypUtfall {
  kundtyp: number;
  namn: string;
  prospekt: number;
  granskade: number;
  skickade: number;
  svar: number;
  positiva: number;
  studsar: number;
}

/** Utfall per kundtyp, totalt eller för de senaste dagarna. */
export function utfallPerKundtyp(d: Db, dagar?: number): KundtypUtfall[] {
  const kp = lasKundprofil();
  const sedan = dagar ? `datetime('now', '-${dagar} days')` : "'1970-01-01'";
  const typer = kp.kundtyper.length ? kp.kundtyper : [{ nr: 1, namn: "Kundtyp 1", beskrivning: "" }];
  const ut: KundtypUtfall[] = [];
  for (const t of [...typer, { nr: 0, namn: "Utan kundtyp", beskrivning: "" }]) {
    const villkor = t.nr === 0 ? "p.kundtyp IS NULL" : "p.kundtyp = ?";
    const args = t.nr === 0 ? [] : [t.nr];
    const rad = d
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM prospekt p WHERE ${villkor} AND p.skapad >= ${sedan}) AS prospekt,
          (SELECT COUNT(*) FROM prospekt p WHERE ${villkor} AND p.granskad IS NOT NULL AND p.granskad >= ${sedan}) AS granskade,
          (SELECT COUNT(*) FROM mejl m JOIN prospekt p ON p.id = m.prospekt_id WHERE ${villkor} AND m.typ = 'forsta' AND m.status = 'skickad' AND m.skickad >= ${sedan}) AS skickade,
          (SELECT COUNT(*) FROM handelser h JOIN prospekt p ON p.id = h.prospekt_id WHERE ${villkor} AND h.typ = 'svar' AND h.tidpunkt >= ${sedan}) AS svar,
          (SELECT COUNT(*) FROM handelser h JOIN prospekt p ON p.id = h.prospekt_id WHERE ${villkor} AND h.typ = 'svar' AND h.detaljer LIKE '%positivt%' AND h.tidpunkt >= ${sedan}) AS positiva,
          (SELECT COUNT(*) FROM handelser h JOIN prospekt p ON p.id = h.prospekt_id WHERE ${villkor} AND h.typ = 'studs' AND h.tidpunkt >= ${sedan}) AS studsar`,
      )
      .get(...args, ...args, ...args, ...args, ...args, ...args) as Omit<KundtypUtfall, "kundtyp" | "namn">;
    if (t.nr === 0 && rad.prospekt === 0 && rad.skickade === 0) continue;
    ut.push({ kundtyp: t.nr, namn: t.namn, ...rad });
  }
  return ut;
}

/** Veckorapport i terminalen. Justerar fördelningen mot de kundtyper som ger svar, aldrig under minsta andel. */
export function weekly(d: Db, alt: { justera?: boolean } = {}): string[] {
  const kp = lasKundprofil();
  const rader: string[] = [];
  const vecka = utfallPerKundtyp(d, 7);
  const totalt = utfallPerKundtyp(d);
  const kost = d.prepare("SELECT COALESCE(SUM(kostnad_usd),0) AS s FROM kostnader WHERE tidpunkt >= datetime('now', '-7 days')").get() as { s: number };
  const granskadeVecka = (d.prepare("SELECT COUNT(*) AS n FROM prospekt WHERE granskad >= datetime('now', '-7 days')").get() as { n: number }).n;

  rader.push("Senaste sju dagarna");
  rader.push(`  ${"Kundtyp".padEnd(36)} ${"nya".padStart(5)} ${"gransk".padStart(7)} ${"skick".padStart(6)} ${"svar".padStart(5)} ${"pos".padStart(4)} ${"studs".padStart(6)}`);
  for (const r of vecka) {
    rader.push(`  ${`${r.kundtyp || "-"}. ${r.namn}`.padEnd(36)} ${String(r.prospekt).padStart(5)} ${String(r.granskade).padStart(7)} ${String(r.skickade).padStart(6)} ${String(r.svar).padStart(5)} ${String(r.positiva).padStart(4)} ${String(r.studsar).padStart(6)}`);
  }
  rader.push(`  API-kostnad: ${kost.s.toFixed(2)} USD${granskadeVecka ? ` (${(kost.s / granskadeVecka).toFixed(3)} USD per granskad sajt)` : ""}`);
  rader.push("");
  rader.push("Totalt");
  rader.push(`  ${"Kundtyp".padEnd(36)} ${"skick".padStart(6)} ${"svar".padStart(5)} ${"andel".padStart(6)} ${"pos".padStart(4)}`);
  for (const r of totalt) {
    const andel = r.skickade ? `${Math.round((r.svar / r.skickade) * 100)} %` : "-";
    rader.push(`  ${`${r.kundtyp || "-"}. ${r.namn}`.padEnd(36)} ${String(r.skickade).padStart(6)} ${String(r.svar).padStart(5)} ${andel.padStart(6)} ${String(r.positiva).padStart(4)}`);
  }

  const nuvarande = aktuellFordelning(d, kp);
  const utfall: Record<number, { skickade: number; svar: number }> = {};
  for (const r of totalt) if (r.kundtyp) utfall[r.kundtyp] = { skickade: r.skickade, svar: r.svar };
  const ny = justeraFordelning(nuvarande, utfall, kp.minstaAndel);
  rader.push("");
  rader.push(`Fördelning nu: ${Object.entries(nuvarande).map(([t, v]) => `kundtyp ${t} ${v} %`).join(", ")}`);
  const andrad = Object.keys(ny).some((t) => ny[Number(t)] !== nuvarande[Number(t)]);
  if (andrad) {
    rader.push(`Förslag utifrån svar (minst ${kp.minstaAndel} % per typ): ${Object.entries(ny).map(([t, v]) => `kundtyp ${t} ${v} %`).join(", ")}`);
    if (alt.justera) {
      sparaFordelning(d, ny);
      rader.push("Fördelningen är uppdaterad och styr nästa segment och discover.");
    } else {
      rader.push("Kör weekly --justera för att använda den.");
    }
  } else {
    rader.push("Ingen ändring av fördelningen föreslås (för lite underlag eller samma utfall).");
  }
  return rader;
}
