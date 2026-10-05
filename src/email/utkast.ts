import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { lasPrompt, strukturerat } from "../analyze/klient.js";
import { konfig } from "../config.js";
import type { Db } from "../db/index.js";
import {
  braForProspekt,
  fyndForProspekt,
  loggaHandelse,
  sattStatus,
  sidorForProspekt,
  type FyndRad,
  type Prospekt,
} from "../db/fragor.js";
import { dataMapp, filnamnSaker } from "../util/fil.js";
import { logg } from "../util/logg.js";
import { kvalitetsgrind, type Grindresultat } from "./grind.js";
import { bastaKontakt, sparaKontakter, utvinnKontakter } from "./kontakter.js";
import { valjFynd } from "./val.js";

const UtkastSchema = z.object({
  amne: z.string(),
  brodtext: z.string(),
});

export interface Utkast {
  amne: string;
  brodtext: string;
  text: string; // brödtext + signatur + avslutsrad, det som skickas
  mottagare: string | null;
  fynd: FyndRad[];
  grind: Grindresultat;
}

export function signatur(): string {
  const k = konfig();
  const rader = [k.AVSANDARE_NAMN, "RK Kommunikation"];
  if (k.AVSANDARE_TELEFON) rader.push(k.AVSANDARE_TELEFON);
  rader.push(k.AVSANDARE_SAJT.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  return rader.join("\n");
}

export const AVSLUTSRAD = "Vill ni inte att jag hör av mig igen räcker det att ni svarar det.";

export function sattIhop(brodtext: string): string {
  return `${brodtext.trim()}\n${signatur()}\n\n${AVSLUTSRAD}\n`;
}

/** Skriver ett mejlutkast med modellen utifrån valda fynd. */
export async function skrivUtkast(d: Db, p: Prospekt, fynd: FyndRad[], bra: { text: string; url: string | null }[]): Promise<{ amne: string; brodtext: string }> {
  const k = konfig();
  const inledning =
    k.SANDLAGE === "auto"
      ? "Rawaz har INTE sett sajten själv. Inledningen ska säga att han har gått igenom webbplatsen med sina granskningsverktyg."
      : "Rawaz läser utkastet innan det skickas. Inledningen får säga att han har tittat på webbplatsen.";
  const uppgifter = {
    organisation: { namn: p.namn, doman: p.doman, organisationstyp: p.organisationstyp, bransch: p.bransch, ort: p.ort },
    avsandare: { namn: k.AVSANDARE_NAMN, sajt: "rkkommunikation.se", bokningslank: k.BOKNINGSLANK || null },
    inledning,
    fynd: fynd.map((f) => ({
      omrade: f.omrade,
      rubrik: f.rubrik,
      observation: f.observation,
      effekt: f.effekt,
      atgard: f.atgard,
      sida: f.belagg_url,
      belagg: f.belagg_varde,
    })),
    det_som_fungerar_bra: bra.map((b) => b.text),
  };
  return strukturerat({
    d,
    prospektId: p.id,
    steg: "utkast",
    modell: k.MODEL_ANALYS,
    system: lasPrompt("mejl"),
    innehall: [{ type: "text", text: `Uppgifter för mejlet i JSON:\n\n${JSON.stringify(uppgifter, null, 1)}` }],
    schema: UtkastSchema,
    maxTokens: 3000,
    effort: "high",
  });
}

export interface DraftAlternativ {
  testTill?: string; // skicka till den här adressen i stället för organisationens (testläge)
  forsok?: number;
}

/** Hela utkaststeget för ett granskat prospekt: kontakter, val av fynd, utkast, kvalitetsgrind, sparande. */
export async function skapaUtkast(d: Db, p: Prospekt, alt: DraftAlternativ = {}): Promise<Utkast | null> {
  logg.info(`Utkast för ${p.doman} (#${p.id})`);
  const fynd = fyndForProspekt(d, p.id, true);
  const valda = valjFynd(fynd);
  if (valda.length < 2) {
    logg.info(`   färre än två bekräftade fynd med tillräcklig säkerhet, inget mejl`);
    loggaHandelse(d, p.id, "utkast_hoppat", "färre än två bekräftade fynd");
    return null;
  }
  const bra = braForProspekt(d, p.id);

  // Kontakter
  const sidor = sidorForProspekt(d, p.id)
    .filter((s) => s.html_sokvag && fs.existsSync(s.html_sokvag))
    .map((s) => ({
      roll: s.roll,
      url: s.url,
      html: fs.readFileSync(s.html_sokvag!, "utf8"),
      text: s.text_sokvag && fs.existsSync(s.text_sokvag) ? fs.readFileSync(s.text_sokvag, "utf8") : "",
    }));
  const kontakter = utvinnKontakter(p.doman, sidor);
  sparaKontakter(d, p.id, kontakter);
  const kontakt = bastaKontakt(d, p.id);
  const mottagare = alt.testTill ?? kontakt?.adress ?? null;
  if (!mottagare) {
    logg.info(`   ingen mejladress hittad på sajten, markeras endast_formular`);
    loggaHandelse(d, p.id, "endast_formular");
    d.prepare("UPDATE prospekt SET orsak_hoppad = 'endast_formular' WHERE id = ?").run(p.id);
    return null;
  }
  logg.info(`   mottagare: ${mottagare}${alt.testTill ? " (testläge)" : ` (${kontakt?.typ}, från ${kontakt?.kallsida})`}`);
  logg.info(`   fynd: ${valda.map((f) => `${f.fynd_id} ${f.omrade}`).join(", ")}`);

  // Utkast, med ett nytt försök om språkreglerna bryts
  const forsok = alt.forsok ?? 2;
  let utkast = await skrivUtkast(d, p, valda, bra);
  let grind = await kvalitetsgrind(d, p, utkast, valda, bra, mottagare, { testlage: !!alt.testTill });
  for (let i = 1; i < forsok && !grind.godkand; i++) {
    logg.info(`   grinden stoppade utkastet (${grind.fel.join("; ")}), nytt försök`);
    utkast = await skrivUtkast(d, p, valda, bra);
    grind = await kvalitetsgrind(d, p, utkast, valda, bra, mottagare, { testlage: !!alt.testTill });
  }

  const text = sattIhop(utkast.brodtext);
  const status = grind.utfall === "stoppad" ? "utkast" : grind.utfall;
  d.prepare("DELETE FROM mejl WHERE prospekt_id = ? AND typ = 'forsta' AND status IN ('utkast', 'i_granskning')").run(p.id);
  d.prepare(
    "INSERT INTO mejl (prospekt_id, typ, mottagare, amne, text, anvanda_fynd, sakerhet, status) VALUES (?, 'forsta', ?, ?, ?, ?, ?, ?)",
  ).run(p.id, mottagare, utkast.amne, text, JSON.stringify(valda.map((f) => f.fynd_id)), grind.sakerhet, status);
  sattStatus(d, p.id, status === "utkast" ? "utkast" : status);
  loggaHandelse(d, p.id, "utkast_skapat", { status, fel: grind.fel, varningar: grind.varningar, sakerhet: grind.sakerhet });

  const fil = path.join(dataMapp("utkast"), `${filnamnSaker(p.doman)}.txt`);
  fs.writeFileSync(fil, `Till: ${mottagare}\nÄmne: ${utkast.amne}\n\n${text}`, "utf8");
  logg.info(`   ${grind.godkand ? "godkänt av grinden" : `STOPPAT: ${grind.fel.join("; ")}`} -> status ${status}. Fil: ${fil}`);
  if (grind.varningar.length) logg.varning(`   ${grind.varningar.join("; ")}`);

  return { amne: utkast.amne, brodtext: utkast.brodtext, text, mottagare, fynd: valda, grind };
}
