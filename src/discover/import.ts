import fs from "node:fs";
import type { Db } from "../db/index.js";
import { laggTillProspekt, loggaHandelse } from "../db/fragor.js";
import { normaliseraDoman } from "../util/domain.js";

export interface ImportRad {
  url: string;
  namn?: string;
  bransch?: string;
  ort?: string;
  kommentar?: string;
  kundtyp?: string;
}

/** Enkel CSV-tolk som klarar citattecken, kommatecken och semikolon som avgränsare. */
export function tolkaCsv(innehall: string): Record<string, string>[] {
  const text = innehall.replace(/^﻿/, "");
  const rader = delaRader(text);
  if (rader.length === 0) return [];
  const forstaRad = rader[0];
  const avgransare = forstaRad.includes(";") && !forstaRad.includes(",") ? ";" : ",";
  const rubriker = delaFalt(forstaRad, avgransare).map((r) => r.trim().toLowerCase());
  const resultat: Record<string, string>[] = [];
  for (const rad of rader.slice(1)) {
    if (!rad.trim()) continue;
    const falt = delaFalt(rad, avgransare);
    const obj: Record<string, string> = {};
    rubriker.forEach((rubrik, i) => {
      obj[rubrik] = (falt[i] ?? "").trim();
    });
    resultat.push(obj);
  }
  return resultat;
}

function delaRader(text: string): string[] {
  const rader: string[] = [];
  let aktuell = "";
  let iCitat = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      iCitat = !iCitat;
      aktuell += c;
    } else if ((c === "\n" || c === "\r") && !iCitat) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      rader.push(aktuell);
      aktuell = "";
    } else {
      aktuell += c;
    }
  }
  if (aktuell) rader.push(aktuell);
  return rader;
}

function delaFalt(rad: string, avgransare: string): string[] {
  const falt: string[] = [];
  let aktuell = "";
  let iCitat = false;
  for (let i = 0; i < rad.length; i++) {
    const c = rad[i];
    if (c === '"') {
      if (iCitat && rad[i + 1] === '"') {
        aktuell += '"';
        i++;
      } else {
        iCitat = !iCitat;
      }
    } else if (c === avgransare && !iCitat) {
      falt.push(aktuell);
      aktuell = "";
    } else {
      aktuell += c;
    }
  }
  falt.push(aktuell);
  return falt;
}

export interface ImportResultat {
  tillagda: string[];
  dubbletter: string[];
  ogiltiga: string[];
}

/** Läser in rader i databasen. Domänen normaliseras och dubbletter hoppas över. */
export function importeraRader(d: Db, rader: ImportRad[], kalla = "lista"): ImportResultat {
  const res: ImportResultat = { tillagda: [], dubbletter: [], ogiltiga: [] };
  const sedda = new Set<string>();
  for (const rad of rader) {
    const doman = normaliseraDoman(rad.url);
    if (!doman) {
      res.ogiltiga.push(rad.url);
      continue;
    }
    if (sedda.has(doman)) {
      res.dubbletter.push(doman);
      continue;
    }
    sedda.add(doman);
    const { id, ny } = laggTillProspekt(d, {
      doman,
      namn: rad.namn || null,
      bransch: rad.bransch || null,
      ort: rad.ort || null,
      kommentar: rad.kommentar || null,
      kalla,
      kundtyp: rad.kundtyp && /^[1-9]$/.test(rad.kundtyp.trim()) ? Number.parseInt(rad.kundtyp, 10) : null,
    });
    if (ny) {
      res.tillagda.push(doman);
      loggaHandelse(d, id, "importerad", { kalla });
    } else {
      res.dubbletter.push(doman);
    }
  }
  return res;
}

export function importeraFil(d: Db, sokvag: string): ImportResultat {
  const innehall = fs.readFileSync(sokvag, "utf8");
  const rader = tolkaCsv(innehall);
  if (rader.length > 0 && !("url" in rader[0])) {
    throw new Error("CSV-filen saknar kolumnen url.");
  }
  return importeraRader(
    d,
    rader.map((r) => ({
      url: r.url,
      namn: r.namn,
      bransch: r.bransch,
      ort: r.ort,
      kommentar: r.kommentar,
      kundtyp: r.kundtyp,
    })),
  );
}
