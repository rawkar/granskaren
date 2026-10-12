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
  /** Taket för egenföretagare (kundtyp 1) i procent, också när weekly justerar fördelningen. */
  maxAndelKundtyp1: number;
  /** Finns kvar för äldre filer. Används inte längre för att välja bort. */
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
    maxAndelKundtyp1: Number.parseFloat(inst.get("max_andel_kundtyp_1") ?? "10"),
    minLikhet: Number.parseFloat(inst.get("min_likhet") ?? "0"),
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
 * Justerar fördelningen mot de kundtyper som ger svar. Ingen typ har ett golv längre, men egenföretagare
 * (kundtyp 1) går aldrig över taket maxAndelKundtyp1. Typer utan tillräckligt underlag får genomsnittets vikt.
 */
export function justeraFordelning(
  nuvarande: Record<number, number>,
  utfall: Record<number, { skickade: number; svar: number }>,
  maxAndelKundtyp1: number,
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
  if (!harUnderlag) return begransaKundtyp1({ ...nuvarande }, maxAndelKundtyp1);
  const kanda = typer.filter((t) => vikter[t] >= 0);
  const snitt = kanda.reduce((s, t) => s + vikter[t], 0) / kanda.length;
  for (const t of typer) if (vikter[t] < 0) vikter[t] = snitt;
  const summa = typer.reduce((s, t) => s + vikter[t], 0);
  const ut: Record<number, number> = {};
  for (const t of typer) ut[t] = (vikter[t] / summa) * 100;
  return begransaKundtyp1(ut, maxAndelKundtyp1);
}

/** Taket för kundtyp 1: överskottet fördelas på de andra typerna i proportion. Avrundar till heltal som summerar till 100. */
export function begransaKundtyp1(f: Record<number, number>, tak: number): Record<number, number> {
  const typer = Object.keys(f).map(Number);
  const ut: Record<number, number> = { ...f };
  if (ut[1] !== undefined && ut[1] > tak && typer.length > 1) {
    const over = ut[1] - tak;
    ut[1] = tak;
    const andra = typer.filter((t) => t !== 1);
    const summaAndra = andra.reduce((s, t) => s + ut[t], 0) || 1;
    for (const t of andra) ut[t] += (over * ut[t]) / summaAndra;
  }
  const avr: Record<number, number> = {};
  let rest = 100;
  for (const t of typer) {
    avr[t] = Math.floor(ut[t]);
    rest -= avr[t];
  }
  for (const t of [...typer].sort((a, b) => ut[b] - Math.floor(ut[b]) - (ut[a] - Math.floor(ut[a])))) {
    if (rest <= 0) break;
    if (t === 1 && avr[t] >= tak) continue;
    avr[t]++;
    rest--;
  }
  return avr;
}
