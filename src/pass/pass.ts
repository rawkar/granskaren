/**
 * Passet: dagens körning uppdelad i etapper där verktygets kod gör allt som inte kräver modell och
 * underagenter i en Claude-session gör modellstegen. Varje sajt får ett arbetspaket i data/pass/<datum>/<domän>/
 * med exakt den text API-vägen skulle ha skickat (systemprompt och uppgift), ett JSON-schema för svaret och
 * en statusfil. Kommandona pass analys-in, verifiering-in, utkast-in och grind-in läser underagentens svar,
 * validerar det mot samma zod-schema som API-vägen och tillämpar samma kodkontroller, grind och sparande.
 *
 * Inget här anropar modellen. Med MODELLVAG=session i miljön läses inte heller API-nyckeln in.
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { z } from "zod";
import { analysSchema, analysSystem, analysUppgift, stadaAnalys, tolkaAnalys } from "../analyze/analys.js";
import { lasPrompt } from "../analyze/klient.js";
import { type Analys, type Fynd, VerifieringSchema, type Verifiering } from "../analyze/schema.js";
import type { Underlag } from "../analyze/underlag.js";
import { kombineraVerifiering, rensaForslag, verifieraMedKod, verifieringsUppgift, type KodSteg, type VerifieringsResultat } from "../analyze/verifiering.js";
import { avslutaGranskning, hamtaOchMat, sparaAnalys, tillampaVerifiering } from "../audit.js";
import { DATA_DIR, konfig, USER_AGENT } from "../config.js";
import type { Db } from "../db/index.js";
import {
  hamtaProspekt,
  hamtaProspektViaDoman,
  laggTillProspekt,
  loggaHandelse,
  markeraSoktraffBehandlad,
  prospektMedStatus,
  sattStatus,
  sparaSoktraffar,
  type FyndRad,
  type Prospekt,
} from "../db/fragor.js";
import { kandaDomaner } from "../discover/discover.js";
import { bortvaldAvKod, ForfilterSchema, forfilterBedom, forfilterUppgift, hamtaForForfilter, kodskal } from "../discover/forfilter.js";
import type { EnkelSajt } from "../discover/hamtaEnkel.js";
import { lasKundprofil } from "../discover/kundprofil.js";
import { discoverUppgift, type Traff } from "../discover/providers.js";
import { normaliseraDoman } from "../util/domain.js";
import { allaSegment } from "../discover/segment.js";
import { grindKodfel, GrindSchema, grindUppgift, grindUtfall, tillampaGrindsvar } from "../email/grind.js";
import { forberedUtkast, hanteraUtkastHinder, sammansattBrodtext, sparaUtkastResultat, UtkastSchema, utkastSystem, utkastText, utkastUppgifter, type UtkastForberett } from "../email/utkast.js";
import type { LankKontroll } from "../measure/lankar.js";
import { underlagSokvag } from "../report/rapport.js";
import { filnamnSaker, lasJson, sakerstallMapp, skrivJson } from "../util/fil.js";
import { logg } from "../util/logg.js";

export const MAX_FORSOK = 2;

export type Steg = "forberedd" | "analys" | "verifiering" | "utkast" | "grind" | "klar" | "hoppad" | "granskningsko" | "stoppad";

export interface SajtStatus {
  doman: string;
  prospektId: number;
  steg: Steg;
  /** Antal försök som gjorts per modellsteg. */
  forsok: { analys: number; verifiering: number; utkast: number; grind: number };
  utfall: string | null;
  tider: Partial<Record<Steg | "start", string>>;
  uppdaterad: string;
}

export function idag(nu = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${nu.getFullYear()}-${p(nu.getMonth() + 1)}-${p(nu.getDate())}`;
}

export function passMapp(datum: string): string {
  return path.join(DATA_DIR, "pass", datum);
}

export function sajtMapp(datum: string, doman: string): string {
  return path.join(passMapp(datum), filnamnSaker(doman));
}

export function lasStatus(datum: string, doman: string): SajtStatus {
  const fil = path.join(sajtMapp(datum, doman), "status.json");
  if (!fs.existsSync(fil)) throw new Error(`Inget arbetspaket för ${doman} den ${datum}. Kör: granskaren pass forbered`);
  return lasJson<SajtStatus>(fil);
}

function sparaStatus(datum: string, s: SajtStatus, steg?: Steg, utfall?: string | null): SajtStatus {
  if (steg) {
    s.steg = steg;
    s.tider[steg] = new Date().toISOString();
  }
  if (utfall !== undefined) s.utfall = utfall;
  s.uppdaterad = new Date().toISOString();
  skrivJson(path.join(sajtMapp(datum, s.doman), "status.json"), s);
  return s;
}

/** Alla sajter i dagens pass med status. */
export function allaStatus(datum: string): SajtStatus[] {
  const mapp = passMapp(datum);
  if (!fs.existsSync(mapp)) return [];
  return fs
    .readdirSync(mapp, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(mapp, e.name, "status.json")))
    .map((e) => lasJson<SajtStatus>(path.join(mapp, e.name, "status.json")))
    .sort((a, b) => a.prospektId - b.prospektId);
}

function kopieraBild(kalla: string | null, mal: string): string | null {
  if (!kalla || !fs.existsSync(kalla)) return null;
  const ext = path.extname(kalla) || ".png";
  const fil = `${mal}${ext}`;
  fs.copyFileSync(kalla, fil);
  return path.basename(fil);
}

function jsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

function skrivFel(mapp: string, fil: string, fel: string): void {
  fs.writeFileSync(path.join(mapp, fil), fel, "utf8");
}

function lasJsonSvar(mapp: string, fil: string): { ok: true; data: unknown } | { ok: false; fel: string } {
  const sokvag = path.join(mapp, fil);
  if (!fs.existsSync(sokvag)) return { ok: false, fel: `${fil} saknas i ${mapp}` };
  const text = fs.readFileSync(sokvag, "utf8").replace(/^﻿/, "").trim();
  const utanBlock = text.match(/^```(?:json)?\s*([\s\S]*?)```$/)?.[1] ?? text;
  try {
    return { ok: true, data: JSON.parse(utanBlock) };
  } catch (e) {
    return { ok: false, fel: `${fil} är inte giltig JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function zodFel(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join(".") || "(roten)"}: ${i.message}`).join("\n");
  return e instanceof Error ? e.message : String(e);
}

// ---------- a) förbered ----------

export interface ForberedAlternativ {
  datum: string;
  sajter?: string[];
  antal?: number;
  /** Använd data/underlag/<domän>.json och sparade mätningar i stället för att hämta om sajten. */
  befintligtUnderlag?: boolean;
  utanLighthouse?: boolean;
}

/** Etapp a: hämtning, mätning och arbetspaket per sajt. Ingen modell. */
export async function forbered(d: Db, alt: ForberedAlternativ): Promise<SajtStatus[]> {
  sakerstallMapp(passMapp(alt.datum));
  let lista: Prospekt[];
  if (alt.sajter?.length) {
    lista = alt.sajter.map((dom) => {
      const p = hamtaProspektViaDoman(d, dom);
      if (!p) throw new Error(`${dom} finns inte i databasen`);
      return p;
    });
  } else {
    lista = prospektMedStatus(d, ["ny", "kvalificerad"], alt.antal ?? 8);
  }
  const ut: SajtStatus[] = [];
  for (const p of lista) {
    const mapp = sakerstallMapp(sajtMapp(alt.datum, p.doman));
    const statusFil = path.join(mapp, "status.json");
    if (fs.existsSync(statusFil)) {
      const s = lasJson<SajtStatus>(statusFil);
      if (s.steg !== "forberedd") {
        logg.info(`${p.doman}: redan ${s.steg}, hoppar förberedelsen`);
        ut.push(s);
        continue;
      }
    }
    const s: SajtStatus = {
      doman: p.doman,
      prospektId: p.id,
      steg: "forberedd",
      forsok: { analys: 0, verifiering: 0, utkast: 0, grind: 0 },
      utfall: null,
      tider: { start: new Date().toISOString() },
      uppdaterad: new Date().toISOString(),
    };

    let underlag: Underlag;
    let lankar: LankKontroll[];
    if (alt.befintligtUnderlag) {
      const fil = underlagSokvag(p.doman);
      if (!fs.existsSync(fil)) throw new Error(`Inget sparat underlag för ${p.doman} (${fil})`);
      underlag = lasJson<Underlag>(fil);
      const rad = d.prepare("SELECT radata FROM matningar WHERE prospekt_id = ? AND verktyg = 'lankar' ORDER BY id DESC LIMIT 1").get(p.id) as { radata: string } | undefined;
      lankar = rad ? (JSON.parse(rad.radata) as LankKontroll[]) : [];
      // Samma utgångsläge som en ny granskning: tidigare fynd, bra och ej skickade utkast rensas
      d.prepare("DELETE FROM fynd WHERE prospekt_id = ?").run(p.id);
      d.prepare("DELETE FROM bra WHERE prospekt_id = ?").run(p.id);
      d.prepare("DELETE FROM mejl WHERE prospekt_id = ? AND typ = 'forsta' AND status IN ('utkast', 'i_granskning')").run(p.id);
      logg.info(`Förbereder ${p.doman} (#${p.id}) från sparat underlag`);
    } else {
      const h = await hamtaOchMat(d, p, { utanLighthouse: alt.utanLighthouse });
      if (h.typ === "hoppad") {
        ut.push(sparaStatus(alt.datum, s, "hoppad", h.orsak));
        continue;
      }
      underlag = h.underlag;
      lankar = h.lankar;
    }

    skrivJson(path.join(mapp, "prospekt.json"), p);
    skrivJson(path.join(mapp, "underlag.json"), underlag);
    skrivJson(path.join(mapp, "lankar.json"), lankar);

    const uppgift = analysUppgift(underlag);
    const bild = kopieraBild(uppgift.skarmbild, path.join(mapp, "analys-skarmbild"));
    fs.writeFileSync(path.join(mapp, "analys-system.md"), analysSystem(), "utf8");
    fs.writeFileSync(
      path.join(mapp, "analys-uppgift.md"),
      [bild && uppgift.skarmbildText ? `${uppgift.skarmbildText}\nBilden ligger i filen ${bild} i samma mapp. Läs den innan du läser underlaget.\n` : "", uppgift.text].filter(Boolean).join("\n"),
      "utf8",
    );
    skrivJson(path.join(mapp, "analys-schema.json"), jsonSchema(analysSchema()));
    for (const f of ["analys.json", "analys-fel.txt"]) if (fs.existsSync(path.join(mapp, f))) fs.unlinkSync(path.join(mapp, f));
    ut.push(sparaStatus(alt.datum, s, "forberedd"));
    logg.info(`   arbetspaket: ${mapp}`);
  }
  return ut;
}

// ---------- b) analys in ----------

export type InUtfall = { ok: true; nasta: Steg; meddelande: string } | { ok: false; nyttForsok: boolean; fel: string };

/** Läser underagentens analys.json, validerar, sparar fynd och kör kodkontrollerna. Skriver verifieringspaket för fynd som behöver modell. */
export function analysIn(d: Db, datum: string, doman: string): InUtfall {
  const s = lasStatus(datum, doman);
  const mapp = sajtMapp(datum, doman);
  const p = hamtaProspekt(d, s.prospektId);
  if (!p) throw new Error(`Prospekt ${s.prospektId} saknas`);
  const svar = lasJsonSvar(mapp, "analys.json");
  let analys: Analys;
  try {
    if (!svar.ok) throw new Error(svar.fel);
    analys = stadaAnalys(tolkaAnalys(svar.data));
  } catch (e) {
    s.forsok.analys++;
    const fel = zodFel(e);
    skrivFel(mapp, "analys-fel.txt", `Förra svaret godtogs inte (försök ${s.forsok.analys} av ${MAX_FORSOK}):\n${fel}\n\nSkriv om analys.json så att den följer analys-schema.json exakt.`);
    if (s.forsok.analys < MAX_FORSOK) {
      sparaStatus(datum, s);
      return { ok: false, nyttForsok: true, fel };
    }
    loggaHandelse(d, p.id, "analys_ogiltig", fel.slice(0, 500));
    sattStatus(d, p.id, "i_granskning");
    sparaStatus(datum, s, "granskningsko", `analysen gick inte att tolka: ${fel.slice(0, 200)}`);
    return { ok: false, nyttForsok: false, fel };
  }
  s.forsok.analys++;

  const underlag = lasJson<Underlag>(path.join(mapp, "underlag.json"));
  const lankar = lasJson<LankKontroll[]>(path.join(mapp, "lankar.json"));
  for (const rad of rensaForslag(underlag, analys.fynd)) logg.info(`   ${rad}`);
  d.prepare("DELETE FROM fynd WHERE prospekt_id = ?").run(p.id);
  d.prepare("DELETE FROM bra WHERE prospekt_id = ?").run(p.id);
  const radIds = sparaAnalys(d, p, analys);
  skrivJson(path.join(mapp, "analys-tolkad.json"), analys);
  skrivJson(path.join(mapp, "fynd-rader.json"), Object.fromEntries(radIds));

  // Kodkontrollen går före modellen
  const klara: Record<string, VerifieringsResultat> = {};
  const behoverModell: Record<string, { kodNot: string; metod: "kod+modell" | "modell" }> = {};
  const vMapp = sakerstallMapp(path.join(mapp, "verifiering"));
  for (const f of fs.readdirSync(vMapp)) fs.unlinkSync(path.join(vMapp, f));
  for (const f of analys.fynd) {
    const steg: KodSteg = verifieraMedKod(underlag, f, lankar);
    if (steg.klar) {
      klara[f.id] = steg.klar;
      continue;
    }
    behoverModell[f.id] = { kodNot: steg.kodNot, metod: steg.metod };
    const u = verifieringsUppgift(steg.sida, steg.sida2, f);
    const bild = kopieraBild(u.skarmbild, path.join(vMapp, `${filnamnSaker(f.id)}-skarmbild`));
    fs.writeFileSync(
      path.join(vMapp, `${filnamnSaker(f.id)}.md`),
      [bild && u.skarmbildText ? `${u.skarmbildText}\nBilden ligger i filen ${bild} i samma mapp. Läs den först.\n` : "", u.text].filter(Boolean).join("\n"),
      "utf8",
    );
  }
  skrivJson(path.join(mapp, "kod-resultat.json"), klara);
  skrivJson(path.join(mapp, "kod-steg.json"), behoverModell);
  for (const f of ["verifiering.json", "verifiering-fel.txt"]) if (fs.existsSync(path.join(mapp, f))) fs.unlinkSync(path.join(mapp, f));

  const ids = Object.keys(behoverModell);
  if (ids.length === 0) {
    sparaStatus(datum, s, "verifiering");
    return verifieringIn(d, datum, doman);
  }
  fs.writeFileSync(path.join(mapp, "verifiering-system.md"), lasPrompt("verifiering"), "utf8");
  skrivJson(path.join(mapp, "verifiering-schema.json"), jsonSchema(verifieringsSchema(ids)));
  fs.writeFileSync(
    path.join(mapp, "verifiering-uppgift.md"),
    [
      `Kontrollera varje fynd nedan för sig, med bara det fyndets fil som underlag. Filerna ligger i mappen verifiering/.`,
      ...ids.map((id) => `- ${id}: verifiering/${filnamnSaker(id)}.md`),
      ``,
      `Svara i verifiering.json med ett objekt där varje nyckel är fyndets id och värdet följer verifiering-schema.json (bedomning och motivering).`,
    ].join("\n"),
    "utf8",
  );
  sparaStatus(datum, s, "verifiering");
  return { ok: true, nasta: "verifiering", meddelande: `${analys.fynd.length} fynd sparade, ${Object.keys(klara).length} avgjorda av kod, ${ids.length} till verifiering: ${ids.join(", ")}` };
}

function verifieringsSchema(ids: string[]) {
  return z.object(Object.fromEntries(ids.map((id) => [id, VerifieringSchema])));
}

// ---------- c) verifiering in ----------

/** Läser verifiering.json, slår ihop med kodkontrollen, avslutar granskningen och förbereder utkastet. */
export function verifieringIn(d: Db, datum: string, doman: string): InUtfall {
  const s = lasStatus(datum, doman);
  const mapp = sajtMapp(datum, doman);
  const p = hamtaProspekt(d, s.prospektId);
  if (!p) throw new Error(`Prospekt ${s.prospektId} saknas`);
  const analys = lasJson<Analys>(path.join(mapp, "analys-tolkad.json"));
  const underlag = lasJson<Underlag>(path.join(mapp, "underlag.json"));
  const klara = lasJson<Record<string, VerifieringsResultat>>(path.join(mapp, "kod-resultat.json"));
  const behoverModell = lasJson<Record<string, { kodNot: string; metod: "kod+modell" | "modell" }>>(path.join(mapp, "kod-steg.json"));
  const radIds = new Map(Object.entries(lasJson<Record<string, number>>(path.join(mapp, "fynd-rader.json"))));
  const ids = Object.keys(behoverModell);

  const resultat = new Map<string, VerifieringsResultat>(Object.entries(klara));
  if (ids.length > 0) {
    const svar = lasJsonSvar(mapp, "verifiering.json");
    let tolkat: Record<string, Verifiering> | null = null;
    try {
      if (!svar.ok) throw new Error(svar.fel);
      tolkat = verifieringsSchema(ids).parse(svar.data) as Record<string, Verifiering>;
    } catch (e) {
      s.forsok.verifiering++;
      const fel = zodFel(e);
      if (s.forsok.verifiering < MAX_FORSOK) {
        skrivFel(mapp, "verifiering-fel.txt", `Förra svaret godtogs inte (försök ${s.forsok.verifiering} av ${MAX_FORSOK}):\n${fel}\n\nSkriv om verifiering.json så att den följer verifiering-schema.json exakt, med alla fynd-id som nycklar.`);
        sparaStatus(datum, s);
        return { ok: false, nyttForsok: true, fel };
      }
      // Som API-vägen när modellkontrollen misslyckas: fynden räknas som inte kontrollerade
      for (const id of ids) resultat.set(id, { verifierad: false, metod: "ingen", not: `Verifieringen misslyckades: ${fel.slice(0, 200)}` });
    }
    if (tolkat) {
      s.forsok.verifiering++;
      for (const id of ids) {
        const steg = behoverModell[id];
        resultat.set(id, kombineraVerifiering({ kodNot: steg.kodNot, metod: steg.metod, sida: undefined as never, sida2: undefined }, tolkat[id]));
      }
    }
  }

  const utfall = tillampaVerifiering(d, p, analys, radIds, resultat);
  skrivJson(path.join(mapp, "verifiering-resultat.json"), Object.fromEntries(resultat));
  avslutaGranskning(d, p, underlag, utfall.analys, utfall.bekraftade, null);

  // Förbered utkastet
  const uppdaterad = hamtaProspekt(d, p.id)!;
  const f = forberedUtkast(d, uppdaterad);
  if (f.typ !== "klar") {
    hanteraUtkastHinder(d, uppdaterad, f);
    const text = f.typ === "inget_mejl" ? f.orsak : f.typ === "redan_mejl" ? "har redan fått mejl" : "ingen mejladress";
    sparaStatus(datum, s, "granskningsko", `inget mejl: ${text}`);
    return { ok: true, nasta: "granskningsko", meddelande: `${utfall.bekraftade} av ${analys.fynd.length} fynd bekräftade. Inget mejl: ${text}` };
  }
  skrivJson(path.join(mapp, "forberett.json"), f);
  skrivUtkastPaket(mapp, uppdaterad, f, []);
  sparaStatus(datum, s, "utkast");
  return { ok: true, nasta: "utkast", meddelande: `${utfall.bekraftade} av ${analys.fynd.length} fynd bekräftade. Utkast på fynd ${f.valda.map((x) => x.fynd_id).join(", ")} till ${f.mottagare}` };
}

function skrivUtkastPaket(mapp: string, p: Prospekt, f: UtkastForberett, tidigareFel: string[]): void {
  fs.writeFileSync(path.join(mapp, "utkast-system.md"), utkastSystem(f.flerFynd), "utf8");
  fs.writeFileSync(path.join(mapp, "utkast-uppgift.md"), utkastText(utkastUppgifter(p, f.valda, f.huvudinsikt, f.profil, f.tilltal, tidigareFel, f.flerFynd)), "utf8");
  skrivJson(path.join(mapp, "utkast-schema.json"), jsonSchema(UtkastSchema));
  for (const fil of ["utkast.json", "grind.json", "grind-fel.txt"]) if (fs.existsSync(path.join(mapp, fil))) fs.unlinkSync(path.join(mapp, fil));
  if (tidigareFel.length) skrivFel(mapp, "utkast-fel.txt", `Förra utkastet stoppades av grinden:\n${tidigareFel.map((x) => `- ${x}`).join("\n")}\n\nSkriv ett nytt utkast. Uppgiften i utkast-uppgift.md innehåller också skälen.`);
  else if (fs.existsSync(path.join(mapp, "utkast-fel.txt"))) fs.unlinkSync(path.join(mapp, "utkast-fel.txt"));
}

// ---------- utkast in ----------

/** Läser utkast.json, kör grindens kodkontroller och skriver grindpaketet, eller begär ett nytt utkast. */
export function utkastIn(d: Db, datum: string, doman: string): InUtfall {
  const s = lasStatus(datum, doman);
  const mapp = sajtMapp(datum, doman);
  const p = hamtaProspekt(d, s.prospektId);
  if (!p) throw new Error(`Prospekt ${s.prospektId} saknas`);
  const f = lasJson<UtkastForberett>(path.join(mapp, "forberett.json"));
  const svar = lasJsonSvar(mapp, "utkast.json");
  let brodtext: string;
  let extraFel: string[] = [];
  try {
    if (!svar.ok) throw new Error(svar.fel);
    const sammansatt = sammansattBrodtext(UtkastSchema.parse(svar.data).brodtext);
    brodtext = sammansatt.brodtext;
    extraFel = sammansatt.fel;
  } catch (e) {
    s.forsok.utkast++;
    const fel = zodFel(e);
    if (s.forsok.utkast < MAX_FORSOK) {
      skrivFel(mapp, "utkast-fel.txt", `Förra svaret godtogs inte (försök ${s.forsok.utkast} av ${MAX_FORSOK}):\n${fel}\n\nSkriv om utkast.json så att den följer utkast-schema.json exakt.`);
      sparaStatus(datum, s);
      return { ok: false, nyttForsok: true, fel };
    }
    loggaHandelse(d, p.id, "utkast_ogiltigt", fel.slice(0, 500));
    sattStatus(d, p.id, "i_granskning");
    sparaStatus(datum, s, "granskningsko", `utkastet gick inte att tolka: ${fel.slice(0, 200)}`);
    return { ok: false, nyttForsok: false, fel };
  }
  s.forsok.utkast++;

  const fel = grindKodfel(d, p, { amne: f.amne, brodtext }, f.valda, f.mottagare, { ...f.grindAlt, extraFel });
  if (fel.length) {
    if (s.forsok.utkast < MAX_FORSOK) {
      logg.info(`   grinden stoppade utkastet (${fel.join("; ")}), nytt försök`);
      skrivUtkastPaket(mapp, p, f, fel);
      sparaStatus(datum, s, "utkast");
      return { ok: false, nyttForsok: true, fel: fel.join("; ") };
    }
    const grind = grindUtfall(fel, [], f.valda);
    sparaUtkastResultat(d, p, f, brodtext, grind);
    sparaStatus(datum, s, "stoppad", fel.join("; "));
    return { ok: true, nasta: "stoppad", meddelande: `stoppat av grinden efter ${MAX_FORSOK} försök: ${fel.join("; ")}` };
  }

  skrivJson(path.join(mapp, "utkast-godkant.json"), { brodtext, forsok: s.forsok.utkast });
  fs.writeFileSync(path.join(mapp, "grind-system.md"), lasPrompt("grind"), "utf8");
  fs.writeFileSync(path.join(mapp, "grind-uppgift.md"), grindUppgift({ amne: f.amne, brodtext }, f.valda, f.bra, f.grindAlt), "utf8");
  skrivJson(path.join(mapp, "grind-schema.json"), jsonSchema(GrindSchema));
  for (const fil of ["grind.json", "grind-fel.txt"]) if (fs.existsSync(path.join(mapp, fil))) fs.unlinkSync(path.join(mapp, fil));
  sparaStatus(datum, s, "grind");
  return { ok: true, nasta: "grind", meddelande: "kodkontrollerna godkände utkastet, grindpaket skrivet" };
}

// ---------- grind in ----------

/** Läser grind.json, avgör utfallet och sparar mejlet, eller begär ett nytt utkast när påståenden saknar stöd. */
export function grindIn(d: Db, datum: string, doman: string): InUtfall {
  const s = lasStatus(datum, doman);
  const mapp = sajtMapp(datum, doman);
  const p = hamtaProspekt(d, s.prospektId);
  if (!p) throw new Error(`Prospekt ${s.prospektId} saknas`);
  const f = lasJson<UtkastForberett>(path.join(mapp, "forberett.json"));
  const { brodtext } = lasJson<{ brodtext: string }>(path.join(mapp, "utkast-godkant.json"));
  const fel = grindKodfel(d, p, { amne: f.amne, brodtext }, f.valda, f.mottagare, f.grindAlt);
  const varningar: string[] = [];

  const svar = lasJsonSvar(mapp, "grind.json");
  try {
    if (!svar.ok) throw new Error(svar.fel);
    tillampaGrindsvar(GrindSchema.parse(svar.data), fel, varningar);
    s.forsok.grind++;
  } catch (e) {
    s.forsok.grind++;
    const text = zodFel(e);
    if (s.forsok.grind < MAX_FORSOK) {
      skrivFel(mapp, "grind-fel.txt", `Förra svaret godtogs inte (försök ${s.forsok.grind} av ${MAX_FORSOK}):\n${text}\n\nSkriv om grind.json så att den följer grind-schema.json exakt.`);
      sparaStatus(datum, s);
      return { ok: false, nyttForsok: true, fel: text };
    }
    // Som API-vägen när kontrollen inte kunde köras: en varning, mejlet går till granskningskön
    varningar.push(`kontrollen av påståenden kunde inte köras: ${text.slice(0, 200)}`);
  }

  if (fel.length && s.forsok.utkast < MAX_FORSOK) {
    logg.info(`   grinden stoppade utkastet (${fel.join("; ")}), nytt försök`);
    skrivUtkastPaket(mapp, p, f, fel);
    s.forsok.grind = 0;
    sparaStatus(datum, s, "utkast");
    return { ok: false, nyttForsok: true, fel: fel.join("; ") };
  }
  const grind = grindUtfall(fel, varningar, f.valda);
  sparaUtkastResultat(d, p, f, brodtext, grind);
  skrivJson(path.join(mapp, "grind-resultat.json"), grind);
  const steg: Steg = grind.utfall === "stoppad" ? "stoppad" : "klar";
  sparaStatus(datum, s, steg, grind.utfall);
  return { ok: true, nasta: steg, meddelande: `${grind.godkand ? "godkänt" : `stoppat: ${grind.fel.join("; ")}`} -> ${grind.utfall}${varningar.length ? ` (varningar: ${varningar.join("; ")})` : ""}` };
}

// ---------- discover ----------

export function discoverMapp(datum: string, segmentId: number): string {
  return sakerstallMapp(path.join(passMapp(datum), "discover", String(segmentId)));
}

/** Skriver uppgiften till webbsökningen för ett segment. Sessionen söker själv och sparar träffarna i traffar.json. */
export function discoverPaket(d: Db, datum: string, segmentId: number, antal: number, sokningar?: number): { mapp: string; maxSok: number; antal: number } {
  const segment = allaSegment(d).find((s) => s.id === segmentId);
  if (!segment) throw new Error(`Segment ${segmentId} finns inte`);
  const kp = lasKundprofil();
  const kanda = kandaDomaner(d);
  const u = discoverUppgift(d, kp, segment, antal, kanda, sokningar);
  const mapp = discoverMapp(datum, segmentId);
  fs.writeFileSync(path.join(mapp, "discover-system.md"), u.system, "utf8");
  fs.writeFileSync(path.join(mapp, "discover-uppgift.md"), u.text, "utf8");
  skrivJson(path.join(mapp, "segment.json"), { ...segment, antal, maxSok: u.maxSok });
  return { mapp, maxSok: u.maxSok, antal };
}

/** En träff från sessionen: webbplatsen och var den hittades. En domän får bara komma från ett sökresultat eller en hämtad sida. */
export const PassTraffSchema = z.object({
  namn: z.string(),
  url: z.string(),
  varfor: z.string().optional(),
  /** Adressen till sökresultatet eller den sida där domänen hittades. */
  hittad_via: z.string(),
});
export type PassTraff = z.infer<typeof PassTraffSchema>;

/** Hämtar råa HTML för en sida, för katalogvägen och för att kontrollera var en domän hittades. */
export async function hamtaHtml(url: string, timeoutMs = 20000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const svar = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" }, redirect: "follow", signal: ctrl.signal });
    clearTimeout(t);
    if (!svar.ok) return null;
    return await svar.text();
  } catch {
    return null;
  }
}

/** Plattformar och kataloger som aldrig är en kandidats egen sajt. */
const INTE_EGEN_SAJT = /(^|\.)(facebook|instagram|linkedin|youtube|vimeo|twitter|x|tiktok|pinterest|google|wikipedia|hitta|eniro|allabolag|bokadirekt|reco|ratsit|merinfo|bolagsfakta|svenskakyrkan|behance|dribbble|etsy|tradera|blocket|apple|microsoft|wordpress|wix|squarespace|godaddy|one|loopia|cloudflare|gstatic|googleapis|facebook\.net|addthis|sharethis|mailchimp|spotify|soundcloud|bandcamp|issuu|cookiedatabase|readspeaker|sensus|studieframjandet|abf|bilda|nortic|billetto|tickster|ticketmaster|kulturbiljetter|swish|klarna|paypal|stripe)\.[a-z]+$/i;

/**
 * Katalogvägen: hämtar en medlemslista eller ett register och plockar ut de externa webbplatser den länkar till.
 * Lägger dem till traffar.json i segmentets mapp med hittad_via satt till katalogens adress.
 */
export async function discoverKatalog(d: Db, datum: string, segmentId: number, katalogUrl: string, varfor?: string): Promise<{ lankar: number; nya: number; fil: string }> {
  const mapp = discoverMapp(datum, segmentId);
  const html = await hamtaHtml(katalogUrl);
  if (!html) throw new Error(`Kunde inte hämta ${katalogUrl}`);
  const $ = cheerio.load(html);
  const egen = normaliseraDoman(katalogUrl);
  const kanda = kandaDomaner(d);
  const fil = path.join(mapp, "traffar.json");
  const befintliga: PassTraff[] = fs.existsSync(fil) ? (JSON.parse(fs.readFileSync(fil, "utf8")) as PassTraff[]) : [];
  const har = new Set(befintliga.map((t) => normaliseraDoman(t.url)));
  let lankar = 0;
  const nya: PassTraff[] = [];
  $("a[href]").each((_, a) => {
    const href = String($(a).attr("href") ?? "");
    if (!/^https?:\/\//i.test(href)) return;
    const dom = normaliseraDoman(href);
    if (!dom || dom === egen || kanda.has(dom) || har.has(dom) || INTE_EGEN_SAJT.test(dom)) return;
    lankar++;
    har.add(dom);
    const namn = $(a).text().replace(/\s+/g, " ").trim() || dom;
    nya.push({ namn: namn.slice(0, 80), url: href, varfor: varfor ?? `länkad från ${katalogUrl}`, hittad_via: katalogUrl });
  });
  fs.writeFileSync(fil, JSON.stringify([...befintliga, ...nya], null, 2), "utf8");
  return { lankar, nya: nya.length, fil };
}

/**
 * Läser sessionens träffar (traffar.json), kräver att varje domän kommer från ett sökresultat eller en hämtad sida,
 * sparar dem i soktraffar, hämtar varje kandidat och kör förfiltrets kodregler. Kandidater som klarar koden får ett
 * förfilterpaket för en underagent.
 */
export async function discoverIn(d: Db, datum: string, segmentId: number, fil?: string): Promise<{ traffar: number; avvisade: string[]; bortvaldaAvKod: number; tillForfilter: string[] }> {
  const segment = allaSegment(d).find((s) => s.id === segmentId);
  if (!segment) throw new Error(`Segment ${segmentId} finns inte`);
  const mapp = discoverMapp(datum, segmentId);
  const kalla = fil ?? path.join(mapp, "traffar.json");
  if (!fs.existsSync(kalla)) throw new Error(`${kalla} saknas`);
  const lista = z.array(PassTraffSchema).parse(JSON.parse(fs.readFileSync(kalla, "utf8")));
  const kanda = kandaDomaner(d);

  // Varje domän måste ha hittats någonstans: i ett sökresultat som pekar på sajten, eller på en hämtad sida som länkar dit
  const avvisade: string[] = [];
  const godtagna: Traff[] = [];
  const hamtadeSidor = new Map<string, string | null>();
  for (const t of lista) {
    const dom = normaliseraDoman(t.url);
    if (!dom || kanda.has(dom)) continue;
    const viaDom = normaliseraDoman(t.hittad_via);
    let ok = viaDom === dom;
    if (!ok) {
      if (!hamtadeSidor.has(t.hittad_via)) hamtadeSidor.set(t.hittad_via, await hamtaHtml(t.hittad_via));
      const html = hamtadeSidor.get(t.hittad_via);
      ok = !!html && html.toLowerCase().includes(dom.toLowerCase());
    }
    if (!ok) {
      avvisade.push(`${dom} (hittad_via ${t.hittad_via} pekar inte på sajten och länkar inte dit)`);
      continue;
    }
    kanda.add(dom);
    godtagna.push({ doman: dom, namn: t.namn || null, kalla: viaDom === dom ? "pass:webb" : `pass:katalog:${viaDom ?? "okänd"}`, segmentId: segment.id, kundtyp: segment.kundtyp, varfor: t.varfor ?? null });
  }
  const traffar = godtagna;
  d.prepare("UPDATE segment SET anvand = 1, traffar = traffar + ? WHERE id = ?").run(traffar.length, segment.id);
  sparaSoktraffar(d, traffar.map((t) => ({ segment_id: t.segmentId, kundtyp: t.kundtyp, kalla: t.kalla, doman: t.doman, namn: t.namn, varfor: t.varfor })));
  skrivJson(path.join(mapp, "traffar-tolkade.json"), { traffar, avvisade });
  for (const a of avvisade) logg.varning(`   avvisad: ${a}`);

  const kp = lasKundprofil();
  const insKandidat = d.prepare("INSERT OR IGNORE INTO kandidater (doman, namn, kalla, segment_id, kundtyp, likhet, utfall, orsak) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const fMapp = sakerstallMapp(path.join(mapp, "forfilter"));
  const tillForfilter: string[] = [];
  let bortvalda = 0;
  for (const t of traffar) {
    logg.info(`   ${t.doman}${t.namn ? ` (${t.namn})` : ""}`);
    try {
      const sajt = await hamtaForForfilter(t.doman);
      const stopp = kodskal(d, t.doman, sajt);
      if (stopp) {
        const r = bortvaldAvKod(t, sajt, stopp);
        insKandidat.run(t.doman, r.namn, t.kalla, t.segmentId, r.kundtyp, r.likhet, r.utfall, r.orsak);
        markeraSoktraffBehandlad(d, t.doman);
        bortvalda++;
        logg.info(`      bortvald: ${stopp}`);
        continue;
      }
      const namn = filnamnSaker(t.doman);
      fs.writeFileSync(path.join(fMapp, `${namn}.md`), forfilterUppgift(d, kp, t, sajt), "utf8");
      skrivJson(path.join(fMapp, `${namn}.json`), { traff: t, sajt });
      tillForfilter.push(t.doman);
    } catch (e) {
      insKandidat.run(t.doman, t.namn, t.kalla, t.segmentId, t.kundtyp, null, "fel", e instanceof Error ? e.message : String(e));
      markeraSoktraffBehandlad(d, t.doman);
      bortvalda++;
      logg.varning(`      fel: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  fs.writeFileSync(path.join(fMapp, "forfilter-system.md"), lasPrompt("forfilter"), "utf8");
  skrivJson(path.join(fMapp, "forfilter-schema.json"), jsonSchema(ForfilterSchema));
  fs.writeFileSync(
    path.join(fMapp, "forfilter-uppgift.md"),
    [`Bedöm varje kandidat för sig med bara dess fil som underlag:`, ...tillForfilter.map((dom) => `- ${dom}: ${filnamnSaker(dom)}.md, svar i ${filnamnSaker(dom)}-svar.json`), ``, `Varje svar följer forfilter-schema.json.`].join("\n"),
    "utf8",
  );
  return { traffar: traffar.length, avvisade, bortvaldaAvKod: bortvalda, tillForfilter };
}

/** Läser underagentens förfiltersvar och lägger godkända kandidater som prospekt, precis som discover gör via API. */
export function forfilterIn(d: Db, datum: string, segmentId: number): { godkanda: string[]; bortvalda: string[]; saknas: string[] } {
  const mapp = path.join(discoverMapp(datum, segmentId), "forfilter");
  const kp = lasKundprofil();
  const insKandidat = d.prepare("INSERT OR IGNORE INTO kandidater (doman, namn, kalla, segment_id, kundtyp, likhet, utfall, orsak) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const ut = { godkanda: [] as string[], bortvalda: [] as string[], saknas: [] as string[] };
  for (const fil of fs.readdirSync(mapp).filter((f) => f.endsWith(".json") && !f.endsWith("-svar.json") && f !== "forfilter-schema.json")) {
    const { traff: t, sajt } = lasJson<{ traff: Traff; sajt: EnkelSajt }>(path.join(mapp, fil));
    if (d.prepare("SELECT 1 FROM kandidater WHERE doman = ?").get(t.doman)) continue; // redan behandlad
    const svarFil = fil.replace(/\.json$/, "-svar.json");
    const svar = lasJsonSvar(mapp, svarFil);
    let bedomning;
    try {
      if (!svar.ok) throw new Error(svar.fel);
      bedomning = ForfilterSchema.parse(svar.data);
    } catch (e) {
      ut.saknas.push(`${t.doman}: ${zodFel(e).slice(0, 120)}`);
      continue;
    }
    const r = forfilterBedom(kp, t, sajt, bedomning);
    insKandidat.run(t.doman, r.namn, t.kalla, t.segmentId, r.kundtyp, r.likhet, r.utfall, r.orsak);
    markeraSoktraffBehandlad(d, t.doman);
    if (r.utfall === "godkand" && r.kundtyp) {
      const { ny, id } = laggTillProspekt(d, { doman: t.doman, namn: r.namn, bransch: r.yrke, ort: r.ort, kalla: t.kalla, kommentar: r.orsak, kundtyp: r.kundtyp, likhet: r.likhet });
      if (ny) loggaHandelse(d, id, "hittad", { kalla: t.kalla, kundtyp: r.kundtyp, likhet: r.likhet, segment: t.segmentId });
      ut.godkanda.push(`${t.doman} (kundtyp ${r.kundtyp}, likhet ${r.likhet?.toFixed(2)})`);
      logg.info(`   godkänd: ${t.doman}, kundtyp ${r.kundtyp}, likhet ${r.likhet?.toFixed(2)}`);
    } else {
      ut.bortvalda.push(`${t.doman}: ${r.orsak.slice(0, 120)}`);
      logg.info(`   bortvald: ${t.doman}: ${r.orsak.slice(0, 120)}`);
    }
  }
  return ut;
}

// ---------- status ----------

export function statusRader(datum: string): string[] {
  const alla = allaStatus(datum);
  if (alla.length === 0) return [`Inget pass för ${datum}.`];
  const rader = [`Pass ${datum}: ${alla.length} sajter`, `  ${"Sajt".padEnd(30)} ${"Steg".padEnd(14)} ${"Försök a/v/u/g".padEnd(16)} Utfall`];
  for (const s of alla) {
    rader.push(`  ${s.doman.padEnd(30)} ${s.steg.padEnd(14)} ${`${s.forsok.analys}/${s.forsok.verifiering}/${s.forsok.utkast}/${s.forsok.grind}`.padEnd(16)} ${s.utfall ?? ""}`);
  }
  const nasta = alla.filter((s) => ["forberedd", "analys", "verifiering", "utkast", "grind"].includes(s.steg));
  rader.push(nasta.length ? `Kvar: ${nasta.map((s) => `${s.doman} (${s.steg})`).join(", ")}` : "Alla sajter är klara. Nästa: granskaren send");
  return rader;
}

/** Kontrollerar att inget modellanrop har loggats sedan en given rad i kostnader. Beviset för att API:et inte användes. */
export function apiAnvandningSedan(d: Db, kostnadId: number): { anrop: number; usd: number } {
  const r = d.prepare("SELECT COUNT(*) n, COALESCE(SUM(kostnad_usd),0) s FROM kostnader WHERE id > ?").get(kostnadId) as { n: number; s: number };
  return { anrop: r.n, usd: r.s };
}

export function senasteKostnadId(d: Db): number {
  return (d.prepare("SELECT COALESCE(MAX(id),0) m FROM kostnader").get() as { m: number }).m;
}

export { konfig };
export type { Fynd, FyndRad };
