import fs from "node:fs";
import path from "node:path";
import { analysera, tjansteomradeFor } from "./analyze/analys.js";
import type { Analys } from "./analyze/schema.js";
import { byggSidUnderlag, type Underlag } from "./analyze/underlag.js";
import { rensaForslag, verifieraFynd, type VerifieringsResultat } from "./analyze/verifiering.js";
import { hamtaSajt } from "./crawl/hamta.js";
import type { Db } from "./db/index.js";
import type { LankKontroll } from "./measure/lankar.js";
import {
  arSparrad,
  harFattMejl,
  loggaHandelse,
  rensaGranskning,
  sattStatus,
  sattVerifiering,
  sparaFynd,
  sparaMatning,
  sparaSida,
  uppdateraProspekt,
  type Prospekt,
} from "./db/fragor.js";
import { arKontaktad } from "./db/kontaktade.js";
import { korAxe } from "./measure/axe.js";
import { kontrolleraSajt, kontrolleraSida, type SidKontroll } from "./measure/kontroller.js";
import { kontrolleraLankar } from "./measure/lankar.js";
import { korLighthouse } from "./measure/lighthouse.js";
import { mattForSajt, mattForSida, type SidMatt } from "./measure/matt.js";
import { skrivRapport, underlagSokvag } from "./report/rapport.js";
import { dataMapp, filnamnSaker, skrivJson } from "./util/fil.js";
import { logg } from "./util/logg.js";

export interface AuditAlternativ {
  utanModell?: boolean; // hämta och mät men hoppa över analys
  utanLighthouse?: boolean;
}

const STOR_ORGANISATION = /presskontakt|pressansvarig|presschef|pressekreterare|presstj[aä]nst|kommunikationschef|kommunikationsavdelning|kommunikationsdirekt[oö]r|kommunikationsenhet|marknadschef|head of communications|press officer/i;
const PARKERAD = /domain is parked|parkerad dom[aä]n|k[oö]p denna dom[aä]n|this domain (is|may be) for sale|dom[aä]nen [aä]r till salu|under construction|under uppbyggnad|kommer snart|coming soon|website coming soon|sidan [aä]r inte tillg[aä]nglig|account suspended|403 forbidden|index of \//i;

/** Hela granskningen för ett prospekt via API: kvalificering, hämtning, mätning, analys, verifiering och rapport. Används inte i driften. */
export async function granskaProspekt(d: Db, p: Prospekt, alt: AuditAlternativ = {}): Promise<"granskad" | "hoppad" | "fel"> {
  const h = await hamtaOchMat(d, p, alt);
  if (h.typ === "hoppad") return "hoppad";
  const { underlag, lankar } = h;

  if (alt.utanModell) {
    const rapport = skrivRapport(d, p.id, underlag, false);
    sattStatus(d, p.id, "kvalificerad");
    logg.info(`   rapport utan analys: ${rapport}`);
    return "granskad";
  }

  const utfall = await analyseraOchVerifiera(d, p, underlag, lankar);
  avslutaGranskning(d, p, underlag, utfall.analys, utfall.bekraftade);
  return "granskad";
}

export type HamtningsUtfall = { typ: "hoppad"; orsak: string } | { typ: "ok"; underlag: Underlag; lankar: LankKontroll[] };

/**
 * Allt som inte kräver modell: kvalificering, hämtning, egna kontroller, kodmått, länkar, Lighthouse och axe.
 * Skriver data/underlag/<domän>.json och sparar sidor och mätningar i databasen.
 */
export async function hamtaOchMat(d: Db, p: Prospekt, alt: AuditAlternativ = {}): Promise<HamtningsUtfall> {
  logg.info(`Granskar ${p.doman} (#${p.id})`);

  if (arSparrad(d, p.doman)) return hoppaMed(d, p, "spärrlista");
  if (harFattMejl(d, p.id)) return hoppaMed(d, p, "har redan fått mejl");
  if (arKontaktad(p.doman)) return hoppaMed(d, p, "har fått mejl eller spärrats enligt kontaktade.txt");

  rensaGranskning(d, p.id);

  // Hämtning
  logg.steg("hämtar sidor");
  const h = await hamtaSajt(p.doman);
  if (h.blockerad) return hoppaMed(d, p, "robots.txt tillåter inte hämtning");
  const start = h.sidor[0];
  if (!start || start.fel || !start.html) return hoppaMed(d, p, `svarar inte (${start?.fel ?? "ingen startsida"})`);
  if (start.statuskod && start.statuskod >= 400) return hoppaMed(d, p, `startsidan ger status ${start.statuskod}`);

  const startText = start.text.trim();
  const ordStart = startText.split(/\s+/).filter(Boolean).length;
  if (ordStart < 25 || (ordStart < 120 && PARKERAD.test(startText))) {
    if (PARKERAD.test(startText) || ordStart < 10) return hoppaMed(d, p, "parkerad eller under uppbyggnad");
  }

  for (const s of h.sidor) {
    sparaSida(d, {
      prospekt_id: p.id,
      roll: s.roll,
      url: s.url,
      slutlig_url: s.slutligUrl,
      statuskod: s.statuskod,
      html_sokvag: s.html ? s.htmlSokvag : null,
      text_sokvag: s.text ? s.textSokvag : null,
      skarmbild_dator: s.skarmbildDator,
      skarmbild_mobil: s.skarmbildMobil,
      svarstid_ms: s.svarstidMs,
      laddtid_ms: s.laddtidMs,
      titel: s.titel,
    });
  }
  if (h.robotsTxt) sparaMatning(d, p.id, `https://${p.doman}/robots.txt`, "robots", { text: h.robotsTxt, regler: h.robots });
  if (h.sitemapXml) sparaMatning(d, p.id, h.sitemapUrl!, "sitemap", { text: h.sitemapXml.slice(0, 20000) });

  // Egna kontroller och kodmått
  logg.steg("kör egna kontroller och kodmått");
  const hamtade = h.sidor.filter((s) => !s.fel && s.html);
  const kontroller = new Map<string, SidKontroll>();
  const matt = new Map<string, SidMatt>();
  for (const s of hamtade) {
    const url = s.slutligUrl || s.url;
    const k = kontrolleraSida(s.html, url, s.text);
    kontroller.set(s.url, k);
    sparaMatning(d, p.id, s.url, "kontroll", k);
    const m = mattForSida(s.html, url, s.text);
    matt.set(s.url, m);
    sparaMatning(d, p.id, s.url, "matt", m);
  }
  const sajtMatt = mattForSajt(hamtade.map((s) => ({ url: s.slutligUrl || s.url, html: s.html })), h.sitemapXml);
  sparaMatning(d, p.id, h.slutligStartUrl, "matt_sajt", sajtMatt);

  const kontaktText = hamtade.filter((s) => s.roll === "kontakt" || s.roll === "om").map((s) => s.text).join("\n");
  const traff = kontaktText.match(STOR_ORGANISATION);
  if (traff) return hoppaMed(d, p, `stor organisation med egen kommunikationsfunktion ("${traff[0]}" på kontakt- eller om-sidan)`);

  logg.steg("kontrollerar länkar");
  const lankar = await kontrolleraLankar(hamtade.map((s) => ({ url: s.slutligUrl || s.url, html: s.html })));
  sparaMatning(d, p.id, h.slutligStartUrl, "lankar", lankar.resultat);

  // Lighthouse och axe på startsida och handlingssida (eller tjänstesida om handlingssida saknas)
  const handling = hamtade.find((s) => s.roll === "handling") ?? hamtade.find((s) => s.roll === "tjanst");
  const matSidor = hamtade.filter((s) => s.roll === "start" || s === handling);
  const lh = new Map<string, Awaited<ReturnType<typeof korLighthouse>>>();
  const ax = new Map<string, Awaited<ReturnType<typeof korAxe>>>();
  for (const s of matSidor) {
    const url = s.slutligUrl || s.url;
    if (!alt.utanLighthouse) {
      logg.steg(`lighthouse på ${s.roll}`);
      const res = await korLighthouse(url, path.join(dataMapp("lighthouse", filnamnSaker(p.doman)), `${s.roll}.json`));
      if (res.fel) logg.varning(`lighthouse misslyckades på ${url}: ${res.fel}`);
      lh.set(s.url, res);
      sparaMatning(d, p.id, url, "lighthouse", res);
    }
    logg.steg(`axe på ${s.roll}`);
    const a = await korAxe(url);
    if (a.fel) logg.varning(`axe misslyckades på ${url}: ${a.fel}`);
    ax.set(s.url, a);
    sparaMatning(d, p.id, url, "axe", a);
  }

  const sajt = kontrolleraSajt(
    hamtade.map((s) => ({ url: s.slutligUrl || s.url, roll: s.roll, kontroll: kontroller.get(s.url)!, sparningsAnrop: s.sparningsAnrop })),
    { sitemapUrl: h.sitemapUrl, robotsFinns: !!h.robotsTxt, https: h.https, lankar: lankar.resultat, antalKontrolleradeLankar: lankar.antal },
  );
  sparaMatning(d, p.id, h.slutligStartUrl, "sajt", sajt);

  const underlag: Underlag = {
    doman: p.doman,
    namn: p.namn,
    bransch: p.bransch,
    ort: p.ort,
    granskad: new Date().toISOString(),
    sajt,
    matt: sajtMatt,
    sidor: hamtade.map((s) => byggSidUnderlag(s, kontroller.get(s.url)!, matt.get(s.url) ?? null, lh.get(s.url) ?? null, ax.get(s.url) ?? null)),
  };
  skrivJson(underlagSokvag(p.doman), underlag);
  loggaHandelse(d, p.id, "hamtad", { sidor: hamtade.length, lankar: lankar.antal });
  return { typ: "ok", underlag, lankar: lankar.resultat };
}

/** Avslutar granskningen: rapport, status granskad, händelse och loggrad. */
export function avslutaGranskning(d: Db, p: Prospekt, underlag: Underlag, analys: Analys, bekraftade: number): string {
  const rapport = skrivRapport(d, p.id, underlag, analys.valskott);
  sattStatus(d, p.id, "granskad");
  loggaHandelse(d, p.id, "granskad", { fynd: analys.fynd.length, bekraftade, valskott: analys.valskott });
  logg.info(`   ${bekraftade} av ${analys.fynd.length} fynd bekräftade.${analys.valskott ? " Sajten bedöms som välskött." : ""} Rapport: ${rapport}`);
  return rapport;
}

export interface AnalysUtfall {
  analys: Analys;
  bekraftade: number;
  bekraftadeIds: Set<string>;
}

/** Analyserar med modellen via API, sparar profil och fynd och verifierar varje fynd mot rådata. Används inte i driften. */
export async function analyseraOchVerifiera(d: Db, p: Prospekt, underlag: Underlag, lankar: LankKontroll[]): Promise<AnalysUtfall> {
  logg.steg("analyserar med språkmodell");
  const analys = await analysera(d, p.id, underlag);
  for (const rad of rensaForslag(underlag, analys.fynd)) logg.info(`   ${rad}`);
  const radIds = sparaAnalys(d, p, analys);

  logg.steg(`verifierar ${analys.fynd.length} fynd`);
  const resultat = new Map<string, VerifieringsResultat>();
  for (const f of analys.fynd) {
    try {
      resultat.set(f.id, await verifieraFynd(d, p.id, underlag, f, lankar));
    } catch (e) {
      resultat.set(f.id, { verifierad: false, metod: "ingen", not: `Verifieringen misslyckades: ${e instanceof Error ? e.message : String(e)}`, gallerInte: null });
    }
  }
  return tillampaVerifiering(d, p, analys, radIds, resultat);
}

/** Sparar analysens profil och fynd i databasen. Returnerar radnummer per fynd-id. Kolumner från den fördjupade analysen får neutrala värden. */
export function sparaAnalys(d: Db, p: Prospekt, analys: Analys): Map<string, number> {
  uppdateraProspekt(d, p.id, {
    organisationstyp: analys.organisationstyp,
    namn: p.namn ?? analys.organisationsnamn ?? null,
    profil: JSON.stringify(analys.profil),
    huvudinsikt: null,
  });
  const radIds = new Map<string, number>();
  for (const f of analys.fynd) {
    radIds.set(
      f.id,
      sparaFynd(d, {
        prospekt_id: p.id,
        fynd_id: f.id,
        omrade: f.omrade,
        tjansteomrade: tjansteomradeFor(f.omrade),
        rubrik: f.rubrik,
        observation: f.observation,
        belagg_url: f.belagg.url,
        belagg_typ: f.belagg.typ,
        belagg_varde: f.belagg.varde,
        effekt: f.effekt,
        atgard: "",
        allvar: f.allvar,
        sakerhet: 1,
        latt_att_forklara: 2,
        djup: 1,
        insikt: null,
        rotorsak: null,
        forslag_konkret: f.forslag_konkret,
        insats: null,
        kopplar_till_syfte: 1,
        belagg2_url: null,
        belagg2_typ: null,
        belagg2_varde: null,
        galler_inte: null,
      }),
    );
  }
  return radIds;
}

/** Skriver verifieringens utfall per fynd, med galler_inte, och loggar. Fynd utan resultat räknas som inte kontrollerade. */
export function tillampaVerifiering(d: Db, p: Prospekt, analys: Analys, radIds: Map<string, number>, resultat: Map<string, VerifieringsResultat>): AnalysUtfall {
  let bekraftade = 0;
  const bekraftadeIds = new Set<string>();
  for (const f of analys.fynd) {
    const v = resultat.get(f.id) ?? { verifierad: false, metod: "ingen" as const, not: "Ingen kontroll kunde göras.", gallerInte: null };
    const radId = radIds.get(f.id);
    if (radId !== undefined) sattVerifiering(d, radId, v.verifierad, v.metod, v.not, v.gallerInte);
    if (v.verifierad) {
      bekraftade++;
      bekraftadeIds.add(f.id);
    }
    logg.info(`   ${v.verifierad ? "ok " : "nej"}  ${f.id} ${f.omrade} allvar ${f.allvar}  ${f.rubrik}  [${v.metod}] ${v.verifierad ? (v.gallerInte ? `delvis, gäller inte: ${v.gallerInte}` : "") : v.not}`);
  }
  void p;
  return { analys, bekraftade, bekraftadeIds };
}

function hoppaMed(d: Db, p: Prospekt, orsak: string): HamtningsUtfall {
  sattStatus(d, p.id, "hoppad", orsak);
  loggaHandelse(d, p.id, "hoppad", orsak);
  logg.info(`   hoppar över ${p.doman}: ${orsak}`);
  return { typ: "hoppad", orsak };
}

export function finnsUnderlag(doman: string): boolean {
  return fs.existsSync(underlagSokvag(doman));
}
