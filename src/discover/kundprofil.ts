import fs from "node:fs";
import path from "node:path";
import { PROMPT_DIR } from "../config.js";
import type { Db } from "../db/index.js";
import { normaliseraDoman } from "../util/domain.js";

export interface Kundtyp {
  nr: number;
  namn: string;
  beskrivning: string;
}

export interface Kundprofil {
  text: string; // hela filen utan anvisningsrader, det modellen får se
  forebilder: { doman: string; beskrivning: string }[];
  kundtyper: Kundtyp[];
  var: string;
  valjBort: string[];
  fordelning: Record<number, number>; // procent per kundtyp
  minstaAndel: number;
  minLikhet: number;
}

export function kundprofilSokvag(): string {
  return path.join(PROMPT_DIR, "kundprofil.md");
}

/** Läser prompts/kundprofil.md. Rader som börjar med > hoppas över. */
export function lasKundprofil(innehall?: string): Kundprofil {
  const ra = innehall ?? fs.readFileSync(kundprofilSokvag(), "utf8");
  const rader = ra.split(/\r?\n/).filter((r) => !r.trimStart().startsWith(">"));
  const text = rader.join("\n");

  const avsnitt = new Map<string, string[]>();
  let aktuell = "";
  for (const rad of rader) {
    if (rad.startsWith("## ")) {
      aktuell = rad.slice(3).trim();
      avsnitt.set(aktuell, []);
    } else if (aktuell) {
      avsnitt.get(aktuell)!.push(rad);
    }
  }

  const forebilder: Kundprofil["forebilder"] = [];
  for (const rad of avsnitt.get("Förebilder") ?? []) {
    const m = rad.match(/^\s*-\s*([^\s(\[]+)\s*(?:\(([^)]*)\))?/);
    if (!m) continue;
    const doman = normaliseraDoman(m[1]);
    if (!doman) continue;
    forebilder.push({ doman, beskrivning: (m[2] ?? "").trim() });
  }

  const kundtyper: Kundtyp[] = [];
  for (const [rubrik, innehall] of avsnitt) {
    const m = rubrik.match(/^Kundtyp\s+(\d+)\s*:\s*(.+)$/i);
    if (!m) continue;
    kundtyper.push({ nr: Number.parseInt(m[1], 10), namn: m[2].trim(), beskrivning: innehall.join(" ").replace(/\s+/g, " ").trim() });
  }

  const inst = new Map<string, string>();
  for (const rad of avsnitt.get("Inställningar") ?? []) {
    const m = rad.match(/^\s*([a-z_]+)\s*:\s*(.+)$/i);
    if (m) inst.set(m[1].toLowerCase(), m[2].trim());
  }
  const fordelning: Record<number, number> = {};
  for (const del of (inst.get("fordelning") ?? "").split(",")) {
    const m = del.trim().match(/^(\d+)\s*=\s*(\d+)$/);
    if (m) fordelning[Number.parseInt(m[1], 10)] = Number.parseInt(m[2], 10);
  }
  if (Object.keys(fordelning).length === 0) for (const k of kundtyper) fordelning[k.nr] = Math.round(100 / Math.max(1, kundtyper.length));

  return {
    text,
    forebilder,
    kundtyper,
    var: (avsnitt.get("Var") ?? []).join(" ").trim(),
    valjBort: (avsnitt.get("Välj bort") ?? []).map((r) => r.replace(/^\s*-\s*/, "").trim()).filter(Boolean),
    fordelning,
    minstaAndel: Number.parseFloat(inst.get("minsta_andel") ?? "15"),
    minLikhet: Number.parseFloat(inst.get("min_likhet") ?? "0.6"),
  };
}

/** Aktuell fördelning: justerad av weekly om en sådan finns sparad, annars från filen. */
export function aktuellFordelning(d: Db, kp: Kundprofil): Record<number, number> {
  const rad = d.prepare("SELECT varde FROM installningar WHERE nyckel = 'fordelning'").get() as { varde: string } | undefined;
  if (!rad) return kp.fordelning;
  try {
    const f = JSON.parse(rad.varde) as Record<string, number>;
    const ut: Record<number, number> = {};
    for (const [k, v] of Object.entries(f)) ut[Number.parseInt(k, 10)] = v;
    return ut;
  } catch {
    return kp.fordelning;
  }
}

export function sparaFordelning(d: Db, f: Record<number, number>): void {
  d.prepare("INSERT INTO installningar (nyckel, varde, andrad) VALUES ('fordelning', ?, datetime('now')) ON CONFLICT(nyckel) DO UPDATE SET varde = excluded.varde, andrad = excluded.andrad").run(
    JSON.stringify(f),
  );
}

/** Fördelar ett antal på kundtyper enligt procent, största rest först. */
export function fordelaAntal(antal: number, fordelning: Record<number, number>): Record<number, number> {
  const typer = Object.keys(fordelning).map(Number);
  const summa = typer.reduce((s, t) => s + fordelning[t], 0) || 1;
  const ra = typer.map((t) => ({ t, exakt: (antal * fordelning[t]) / summa }));
  const ut: Record<number, number> = {};
  let kvar = antal;
  for (const r of ra) {
    ut[r.t] = Math.floor(r.exakt);
    kvar -= ut[r.t];
  }
  for (const r of [...ra].sort((a, b) => b.exakt - Math.floor(b.exakt) - (a.exakt - Math.floor(a.exakt)))) {
    if (kvar <= 0) break;
    ut[r.t]++;
    kvar--;
  }
  return ut;
}

/**
 * Justerar fördelningen mot de kundtyper som ger svar. Ingen typ går under minsta andel.
 * Typer utan tillräckligt underlag behåller sin nuvarande andel som vikt.
 */
export function justeraFordelning(
  nuvarande: Record<number, number>,
  utfall: Record<number, { skickade: number; svar: number }>,
  minstaAndel: number,
  minSkickade = 10,
): Record<number, number> {
  const typer = Object.keys(nuvarande).map(Number);
  const vikter: Record<number, number> = {};
  let harUnderlag = false;
  for (const t of typer) {
    const u = utfall[t];
    if (u && u.skickade >= minSkickade) {
      vikter[t] = Math.max(0.01, u.svar / u.skickade);
      harUnderlag = true;
    } else {
      vikter[t] = -1; // markerar saknat underlag
    }
  }
  if (!harUnderlag) return { ...nuvarande };
  // typer utan underlag får en vikt som motsvarar genomsnittet av de som har
  const kanda = typer.filter((t) => vikter[t] >= 0);
  const snitt = kanda.reduce((s, t) => s + vikter[t], 0) / kanda.length;
  for (const t of typer) if (vikter[t] < 0) vikter[t] = snitt;
  const summa = typer.reduce((s, t) => s + vikter[t], 0);
  let ut: Record<number, number> = {};
  for (const t of typer) ut[t] = (vikter[t] / summa) * 100;
  // golv: lyft upp till minsta andel och ta från de som ligger över, proportionellt
  for (let i = 0; i < 5; i++) {
    const under = typer.filter((t) => ut[t] < minstaAndel);
    if (under.length === 0) break;
    let brist = 0;
    for (const t of under) {
      brist += minstaAndel - ut[t];
      ut[t] = minstaAndel;
    }
    const over = typer.filter((t) => ut[t] > minstaAndel);
    const overskott = over.reduce((s, t) => s + (ut[t] - minstaAndel), 0) || 1;
    for (const t of over) ut[t] -= (brist * (ut[t] - minstaAndel)) / overskott;
  }
  // avrunda till heltal som summerar till 100
  const avr: Record<number, number> = {};
  let rest = 100;
  for (const t of typer) {
    avr[t] = Math.floor(ut[t]);
    rest -= avr[t];
  }
  for (const t of typer.sort((a, b) => ut[b] - Math.floor(ut[b]) - (ut[a] - Math.floor(ut[a])))) {
    if (rest <= 0) break;
    avr[t]++;
    rest--;
  }
  ut = avr;
  return ut;
}
