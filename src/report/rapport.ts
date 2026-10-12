import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { Db } from "../db/index.js";
import { fyndForProspekt, hamtaProspekt, type FyndRad } from "../db/fragor.js";
import { OMRADEN, type Omrade } from "../analyze/schema.js";
import type { Underlag } from "../analyze/underlag.js";
import { dataMapp, filnamnSaker } from "../util/fil.js";

export function rapportSokvag(doman: string): string {
  return path.join(dataMapp("rapporter"), `${filnamnSaker(doman)}.md`);
}

/** Läser en profilpunkt oavsett om den är text (lätta analysen) eller ett objekt med varde (äldre analyser). */
export function profilText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && "varde" in v) {
    const p = v as { varde?: unknown; gissning?: boolean };
    return typeof p.varde === "string" && !p.gissning ? p.varde : null;
  }
  return null;
}

interface SparadProfil {
  person?: { drivs_av_namngiven_person: boolean; fornamn: string | null; sakerhet: number; belagg: string | null };
  vad_de_gor?: unknown;
  huvudhandling?: unknown;
}

/** Skriver data/rapporter/<domän>.md: den lätta granskningens fynd och mätvärden. Rawaz underlag när någon svarar. */
export function skrivRapport(d: Db, prospektId: number, u: Underlag, valskott: boolean): string {
  const p = hamtaProspekt(d, prospektId);
  if (!p) throw new Error(`Prospekt ${prospektId} saknas`);
  const fynd = fyndForProspekt(d, prospektId);
  const bekraftade = fynd.filter((f) => f.verifierad === 1);
  const ejBekraftade = fynd.filter((f) => f.verifierad !== 1);
  const profil = p.profil ? (JSON.parse(p.profil) as SparadProfil) : null;

  const r: string[] = [];
  r.push(`# Granskning av ${p.namn ?? p.doman}`);
  r.push("");
  r.push(`Domän: ${p.doman}  `);
  r.push(`Granskad: ${u.granskad.slice(0, 16).replace("T", " ")}  `);
  if (p.bransch || p.ort) r.push(`Bransch och ort: ${[p.bransch, p.ort].filter(Boolean).join(", ")}  `);
  r.push(`Organisationstyp: ${p.organisationstyp ?? "okänd"}  `);
  if (u.matt?.plattform) r.push(`Plattform: ${[u.matt.plattform, u.matt.tema ? `tema ${u.matt.tema}` : null].filter(Boolean).join(", ")}  `);
  r.push(`Bekräftade fynd: ${bekraftade.length} av ${fynd.length}  `);
  if (valskott) r.push(`Bedömning: sajten är överlag välskött, inget mejl skickas.  `);
  r.push("");

  if (profil) {
    r.push("## Profil");
    r.push("");
    if (profil.person) r.push(`- **Namngiven person.** ${profil.person.drivs_av_namngiven_person ? `ja, ${profil.person.fornamn ?? "förnamn saknas"} (tilltal du)` : "nej (tilltal ni)"}${profil.person.belagg ? ` Belägg: "${profil.person.belagg}"` : ""}`);
    const vad = profilText(profil.vad_de_gor);
    const handling = profilText(profil.huvudhandling);
    if (vad) r.push(`- **Vad de gör.** ${vad}`);
    if (handling) r.push(`- **Handlingen sajten vill leda till.** ${handling}`);
    r.push("");
  }

  r.push("## Bekräftade fynd");
  r.push("");
  if (bekraftade.length === 0) r.push("Inga fynd kunde bekräftas.");
  for (const omrade of Object.keys(OMRADEN) as Omrade[]) {
    const lista = bekraftade.filter((f) => f.omrade === omrade);
    if (lista.length === 0) continue;
    r.push(`### ${omrade}. ${OMRADEN[omrade].namn}`);
    r.push("");
    for (const f of lista) r.push(...fyndTillMarkdown(f));
  }

  if (ejBekraftade.length > 0) {
    r.push("## Fynd som inte kunde bekräftas");
    r.push("");
    r.push("Dessa används aldrig i ett mejl. De finns med för att du ska kunna se vad modellen föreslog och varför det stoppades.");
    r.push("");
    for (const f of ejBekraftade) r.push(`- **${f.rubrik}** (${f.omrade}, ${f.belagg_typ}). ${f.verifieringsnot ?? "Ingen notering."}`);
    r.push("");
  }

  r.push(...matvardenTillMarkdown(u, dataMapp("rapporter")));
  r.push("");
  r.push(`En fördjupad analys med huvudinsikt och åtgärdslista görs med: granskaren fordjupa ${p.doman}`);

  const sokvag = rapportSokvag(p.doman);
  fs.writeFileSync(sokvag, r.join("\n"), "utf8");
  return sokvag;
}

function fyndTillMarkdown(f: FyndRad): string[] {
  const rader = [`#### ${f.rubrik}`, "", `${f.observation}`, "", `- Allvar ${f.allvar}`, `- Belägg: ${f.belagg_typ} på ${f.belagg_url}`, `- Värde: \`${f.belagg_varde.replace(/`/g, "'")}\``, `- Effekt: ${f.effekt}`];
  if (f.forslag_konkret) rader.push(`- Konkret förslag: ${f.forslag_konkret}`);
  if (f.galler_inte) rader.push(`- Gäller inte (får inte användas i mejl): ${f.galler_inte}`);
  rader.push(`- Verifierad med ${f.verifieringsmetod ?? "okänt"}. ${f.verifieringsnot ?? ""}`);
  rader.push("");
  return rader;
}

/** Mätvärdesavsnittet, gemensamt för den lätta och den fördjupade rapporten. */
export function matvardenTillMarkdown(u: Underlag, rapportMapp: string): string[] {
  const rel = (s: string | null) => (s ? path.relative(rapportMapp, s).replace(/\\/g, "/") : null);
  const r: string[] = [];
  r.push("## Mätvärden");
  r.push("");
  r.push("### Sajten");
  r.push("");
  r.push(`- HTTPS: ${u.sajt.https_ok ? "ok" : `problem (${u.sajt.https_fel ?? "okänt"})`}`);
  r.push(`- sitemap.xml: ${u.sajt.sitemap_finns ? u.sajt.sitemap_url : "saknas"}`);
  r.push(`- robots.txt: ${u.sajt.robots_finns ? "finns" : "saknas"}`);
  if (u.matt) {
    r.push(`- Plattform: ${u.matt.plattform ?? "okänd"}${u.matt.tema ? `, tema ${u.matt.tema}` : ""}${u.matt.tillagg.length ? `, tillägg: ${u.matt.tillagg.join(", ")}` : ""}`);
    r.push(`- Case eller referenser: ${u.matt.case_antal} hittade${u.matt.case_urls.length ? ` (${u.matt.case_urls.slice(0, 5).join(", ")})` : ""}`);
    r.push(`- Tjänstesidor: ${u.matt.tjanstesidor_antal}`);
  }
  r.push(`- Mätverktyg som syns på sidan: ${u.sajt.analysverktyg.length ? u.sajt.analysverktyg.join(", ") : "inget"}`);
  r.push(`- Samtyckesverktyg för kakor: ${u.sajt.samtyckesverktyg ?? "inget känt hittat"}`);
  r.push(`- Spårningsanrop innan samtycke: ${u.sajt.sparning_fore_samtycke.length ? u.sajt.sparning_fore_samtycke.join(", ") : "inga upptäckta"}`);
  r.push(`- Döda länkar: ${u.sajt.doda_lankar.length} av ${u.sajt.antal_kontrollerade_lankar} kontrollerade`);
  for (const l of u.sajt.doda_lankar.slice(0, 15)) r.push(`  - ${l.url} (status ${l.status ?? "inget svar"}, länkad från ${l.fran})`);
  if (u.sajt.sidor_utan_metabeskrivning.length) r.push(`- Sidor utan metabeskrivning: ${u.sajt.sidor_utan_metabeskrivning.join(", ")}`);
  if (u.sajt.sidor_utan_h1.length) r.push(`- Sidor utan H1: ${u.sajt.sidor_utan_h1.join(", ")}`);
  if (u.sajt.sidor_med_flera_h1.length) r.push(`- Sidor med flera H1: ${u.sajt.sidor_med_flera_h1.join(", ")}`);
  if (u.sajt.titlar_dubbletter.length) r.push(`- Dubblerade sidtitlar: ${u.sajt.titlar_dubbletter.map((t) => `"${t}"`).join(", ")}`);
  r.push("");

  r.push("### Sidor");
  r.push("");
  r.push("| Roll | URL | Status | Laddtid | Titel | Metabeskrivning | H1 | Bilder utan alt | Ord | Vi-andel | LIX | Formulärfält |");
  r.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of u.sidor) {
    const k = s.kontroll;
    const m = s.matt;
    r.push(
      `| ${s.roll} | ${s.url} | ${s.statuskod ?? "fel"} | ${s.laddtid_ms !== null ? `${(s.laddtid_ms / 1000).toFixed(1)} s` : ""} | ${k.titel_saknas ? "saknas" : `${k.titel_langd} tecken`} | ${k.metabeskrivning_saknas ? "saknas" : `${k.metabeskrivning_langd} tecken`} | ${k.h1_antal} | ${k.bilder_utan_alt}/${k.bilder_antal} | ${k.ordantal} | ${m?.vi_andel !== null && m?.vi_andel !== undefined ? `${Math.round(m.vi_andel * 100)} %` : ""} | ${m?.lix ?? ""} | ${m?.formular.map((f) => f.antal_falt).join(", ") ?? ""} |`,
    );
  }
  r.push("");

  const medLh = u.sidor.filter((s) => s.lighthouse && !s.lighthouse.fel);
  if (medLh.length) {
    r.push("### Lighthouse (mobil)");
    r.push("");
    r.push("| Sida | Prestanda | SEO | Tillgänglighet | Bästa praxis | LCP | CLS | Sidvikt | Bilder | Möjlig bildbesparing |");
    r.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const s of medLh) {
      const l = s.lighthouse!;
      r.push(
        `| ${s.roll} | ${l.poang_prestanda ?? ""} | ${l.poang_seo ?? ""} | ${l.poang_tillganglighet ?? ""} | ${l.poang_basta_praxis ?? ""} | ${l.lcp_ms !== null ? `${(l.lcp_ms / 1000).toFixed(1)} s` : ""} | ${l.cls ?? ""} | ${l.sidvikt_kb !== null ? `${l.sidvikt_kb} kB` : ""} | ${l.bilder_kb !== null ? `${l.bilder_kb} kB` : ""} | ${l.bildbesparing_kb !== null ? `${l.bildbesparing_kb} kB` : ""} |`,
      );
    }
    r.push("");
    for (const s of medLh) {
      const l = s.lighthouse!;
      if (l.misslyckade_revisioner.length === 0) continue;
      r.push(`Underkända Lighthouse-kontroller på ${s.roll}: ${l.misslyckade_revisioner.map((m) => `${m.titel}${m.varde ? ` (${m.varde})` : ""}`).join("; ")}`);
      r.push("");
    }
  }

  const medAxe = u.sidor.filter((s) => s.axe && !s.axe.fel);
  if (medAxe.length) {
    r.push("### Tillgänglighet (axe)");
    r.push("");
    for (const s of medAxe) {
      const a = s.axe!;
      r.push(`${s.roll} (${s.url}): ${a.critical_antal} kritiska, ${a.serious_antal} allvarliga, ${a.moderate_antal} måttliga, ${a.minor_antal} mindre.`);
      for (const b of a.brister.slice(0, 8)) r.push(`- ${b.allvar}: ${b.hjalp} (${b.antal_element} element, regel ${b.id})`);
      r.push("");
    }
  }

  r.push("## Skärmbilder");
  r.push("");
  for (const s of u.sidor) {
    const dator = rel(s.skarmbild_dator);
    const mobil = rel(s.skarmbild_mobil);
    if (!dator && !mobil) continue;
    r.push(`### ${s.roll}: ${s.url}`);
    r.push("");
    if (dator) r.push(`![${s.roll} dator](${dator})`);
    if (mobil) r.push(`![${s.roll} mobil](${mobil})`);
    r.push("");
  }
  return r;
}

export function underlagSokvag(doman: string): string {
  return path.join(dataMapp("underlag"), `${filnamnSaker(doman)}.json`);
}

export { DATA_DIR };
