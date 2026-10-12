/**
 * Fördjupad analys för en sajt som har svarat: den fullständiga analysen med profil, huvudinsikt, det Rawaz skulle
 * börja med och rapport. Körs bara när Rawaz ber om det, via sessionen: granskaren fordjupa <domän> skriver ett
 * arbetspaket, en underagent (granskaren-analys) skriver analys.json, och granskaren fordjupa-in <domän> kontrollerar
 * beläggen med kod och skriver rapporten data/rapporter/<domän>-fordjupning.md. Databasens fynd rörs inte.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fordjupadSystem, fordjupadUppgift, tolkaFordjupad } from "../analyze/analys.js";
import { AnalysFordjupadSchema, OMRADEN, type AnalysFordjupad, type FyndFordjupad, type Omrade } from "../analyze/schema.js";
import type { Underlag } from "../analyze/underlag.js";
import { kontrolleraMedKod, rensaForslag } from "../analyze/verifiering.js";
import { DATA_DIR } from "../config.js";
import type { Db } from "../db/index.js";
import { hamtaProspektViaDoman, loggaHandelse } from "../db/fragor.js";
import type { LankKontroll } from "../measure/lankar.js";
import { matvardenTillMarkdown, underlagSokvag } from "../report/rapport.js";
import { dataMapp, filnamnSaker, lasJson, sakerstallMapp, skrivJson } from "../util/fil.js";

export function fordjupningsMapp(doman: string): string {
  return sakerstallMapp(path.join(DATA_DIR, "fordjupning", filnamnSaker(doman)));
}

export function fordjupadRapportSokvag(doman: string): string {
  return path.join(dataMapp("rapporter"), `${filnamnSaker(doman)}-fordjupning.md`);
}

/** Skriver arbetspaketet för den fördjupade analysen från det sparade underlaget. Hämtar inte om sajten. */
export function fordjupaPaket(d: Db, doman: string): { mapp: string; skarmbild: string | null } {
  const p = hamtaProspektViaDoman(d, doman);
  if (!p) throw new Error(`${doman} finns inte i databasen`);
  const fil = underlagSokvag(doman);
  if (!fs.existsSync(fil)) throw new Error(`Inget sparat underlag för ${doman} (${fil}). Sajten måste ha granskats i ett pass först.`);
  const underlag = lasJson<Underlag>(fil);
  const mapp = fordjupningsMapp(doman);
  const uppgift = fordjupadUppgift(underlag);
  let bild: string | null = null;
  if (uppgift.skarmbild) {
    bild = `analys-skarmbild${path.extname(uppgift.skarmbild) || ".png"}`;
    fs.copyFileSync(uppgift.skarmbild, path.join(mapp, bild));
  }
  skrivJson(path.join(mapp, "prospekt.json"), p);
  fs.writeFileSync(path.join(mapp, "analys-system.md"), fordjupadSystem(), "utf8");
  fs.writeFileSync(
    path.join(mapp, "analys-uppgift.md"),
    [bild && uppgift.skarmbildText ? `${uppgift.skarmbildText}\nBilden ligger i filen ${bild} i samma mapp. Läs den innan du läser underlaget.\n` : "", uppgift.text].filter(Boolean).join("\n"),
    "utf8",
  );
  skrivJson(path.join(mapp, "analys-schema.json"), z.toJSONSchema(AnalysFordjupadSchema, { target: "draft-7" }));
  for (const f of ["analys.json", "analys-fel.txt"]) if (fs.existsSync(path.join(mapp, f))) fs.unlinkSync(path.join(mapp, f));
  return { mapp, skarmbild: bild };
}

/** Läser analys.json, kontrollerar beläggen med kod och skriver den fördjupade rapporten. */
export function fordjupaIn(d: Db, doman: string): { ok: true; rapport: string; fynd: number; bekraftade: number } | { ok: false; fel: string } {
  const p = hamtaProspektViaDoman(d, doman);
  if (!p) throw new Error(`${doman} finns inte i databasen`);
  const mapp = fordjupningsMapp(doman);
  const fil = path.join(mapp, "analys.json");
  if (!fs.existsSync(fil)) return { ok: false, fel: `${fil} saknas` };
  let analys: AnalysFordjupad;
  try {
    const text = fs.readFileSync(fil, "utf8").replace(/^﻿/, "").trim();
    analys = tolkaFordjupad(JSON.parse(text.match(/^```(?:json)?\s*([\s\S]*?)```$/)?.[1] ?? text));
  } catch (e) {
    const fel = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n") : e instanceof Error ? e.message : String(e);
    fs.writeFileSync(path.join(mapp, "analys-fel.txt"), `Förra svaret godtogs inte:\n${fel}\n\nSkriv om analys.json så att den följer analys-schema.json exakt.`, "utf8");
    return { ok: false, fel };
  }
  const underlag = lasJson<Underlag>(underlagSokvag(doman));
  const rad = d.prepare("SELECT radata FROM matningar WHERE prospekt_id = ? AND verktyg = 'lankar' ORDER BY id DESC LIMIT 1").get(p.id) as { radata: string } | undefined;
  const lankar = rad ? (JSON.parse(rad.radata) as LankKontroll[]) : [];
  rensaForslag(underlag, analys.fynd);

  // Kodkontroll av beläggen, ingen modell
  const kontroll = new Map<string, { ok: boolean; not: string }>();
  for (const f of analys.fynd) {
    const k1 = kontrolleraMedKod(underlag, f.belagg, lankar);
    const k2 = f.belagg2 ? kontrolleraMedKod(underlag, f.belagg2, lankar) : null;
    const ok = (k1?.ok ?? true) && (k2?.ok ?? true);
    kontroll.set(f.id, { ok, not: [k1?.not, k2 ? `Andra belägget: ${k2.not}` : null].filter(Boolean).join(" ") || "Belägget kontrolleras inte med kod." });
  }
  skrivJson(path.join(mapp, "analys-tolkad.json"), analys);
  const rapport = skrivFordjupadRapport(p.doman, p.namn, underlag, analys, kontroll);
  loggaHandelse(d, p.id, "fordjupning", { fynd: analys.fynd.length, bekraftade: [...kontroll.values()].filter((k) => k.ok).length, rapport });
  return { ok: true, rapport, fynd: analys.fynd.length, bekraftade: [...kontroll.values()].filter((k) => k.ok).length };
}

const PROFILRUBRIKER: Record<string, string> = {
  vad_de_gor: "Vad de gör",
  for_vem: "För vem",
  omrade: "Område",
  syfte: "Sajtens syfte",
  huvudhandling: "Viktigaste handling",
  skiljer_sig: "Vad som skiljer dem",
  ton: "Ton och tilltal",
};

/** Rapporten för den fördjupade analysen: profil, huvudinsikt, det Rawaz skulle börja med, sammanfattning, bra, fynd och mätvärden. */
export function skrivFordjupadRapport(doman: string, namn: string | null, u: Underlag, a: AnalysFordjupad, kontroll: Map<string, { ok: boolean; not: string }>): string {
  const r: string[] = [];
  r.push(`# Fördjupad analys av ${namn ?? a.organisationsnamn ?? doman}`);
  r.push("");
  r.push(`Domän: ${doman}  `);
  r.push(`Underlag hämtat: ${u.granskad.slice(0, 16).replace("T", " ")}  `);
  r.push(`Organisationstyp: ${a.organisationstyp}  `);
  r.push(`Fynd: ${a.fynd.length}, varav ${[...kontroll.values()].filter((k) => k.ok).length} med belägg som kodkontrollen bekräftar  `);
  if (a.valskott) r.push("Bedömning: sajten är överlag välskött.  ");
  r.push("");
  r.push("## Profil");
  r.push("");
  r.push(`- **Namngiven person.** ${a.profil.person.drivs_av_namngiven_person ? `ja, ${a.profil.person.fornamn ?? "förnamn saknas"}` : "nej"}${a.profil.person.belagg ? ` Belägg: "${a.profil.person.belagg}"` : ""}`);
  for (const [nyckel, rubrik] of Object.entries(PROFILRUBRIKER)) {
    const punkt = (a.profil as unknown as Record<string, { varde: string; sakerhet: number; belagg: string | null; gissning: boolean }>)[nyckel];
    if (!punkt) continue;
    r.push(`- **${rubrik}.** ${punkt.varde}${punkt.gissning ? " (gissning)" : ""} [säkerhet ${punkt.sakerhet.toFixed(2)}]${punkt.belagg ? ` Belägg: "${punkt.belagg}"` : ""}`);
  }
  r.push("");
  r.push("## Huvudinsikt");
  r.push("");
  r.push(a.huvudinsikt ? `${a.huvudinsikt.text}\n\nBygger på fynd: ${a.huvudinsikt.fynd_ids.join(", ")}` : "Ingen huvudinsikt kunde formuleras med stöd i fynden.");
  r.push("");
  if (a.borja_med.length) {
    r.push("## Det här skulle jag börja med");
    r.push("");
    a.borja_med.forEach((b, i) => r.push(`${i + 1}. ${b.atgard} (insats ${b.insats}). ${b.effekt}`));
    r.push("");
  }
  r.push("## Sammanfattning");
  r.push("");
  r.push(a.sammanfattning);
  r.push("");
  r.push("## Det som fungerar bra");
  r.push("");
  if (!a.bra.length) r.push("Inget särskilt noterat.");
  for (const b of a.bra) r.push(`- ${b.text}${b.url ? ` (${b.url})` : ""}`);
  r.push("");
  r.push("## Fynd");
  r.push("");
  for (const omrade of Object.keys(OMRADEN) as Omrade[]) {
    const lista = a.fynd.filter((f) => f.omrade === omrade);
    if (!lista.length) continue;
    r.push(`### ${omrade}. ${OMRADEN[omrade].namn}`);
    r.push("");
    for (const f of lista) r.push(...fyndTillMarkdown(f, kontroll.get(f.id)));
  }
  r.push(...matvardenTillMarkdown(u, dataMapp("rapporter")));
  const sokvag = fordjupadRapportSokvag(doman);
  fs.writeFileSync(sokvag, r.join("\n"), "utf8");
  return sokvag;
}

function fyndTillMarkdown(f: FyndFordjupad, k: { ok: boolean; not: string } | undefined): string[] {
  const rader = [`#### ${f.rubrik}`, "", f.observation, "", `- Djup ${f.djup}, insats ${f.insats}${f.kopplar_till_syfte ? "" : ", kopplar inte till sajtens syfte"}`];
  if (f.insikt) rader.push(`- Insikt: ${f.insikt}`);
  if (f.rotorsak) rader.push(`- Trolig orsak: ${f.rotorsak}`);
  rader.push(`- Belägg: ${f.belagg.typ} på ${f.belagg.url}, \`${f.belagg.varde.replace(/`/g, "'")}\``);
  if (f.belagg2) rader.push(`- Andra belägget: ${f.belagg2.typ} på ${f.belagg2.url}, \`${f.belagg2.varde.replace(/`/g, "'")}\``);
  rader.push(`- Effekt: ${f.effekt}`);
  rader.push(`- Åtgärd: ${f.atgard}`);
  if (f.forslag_konkret) rader.push(`- Konkret förslag: ${f.forslag_konkret}`);
  rader.push(`- Allvar ${f.allvar}, säkerhet ${f.sakerhet.toFixed(2)}, lätt att förklara ${f.latt_att_forklara}. Kodkontroll: ${k ? (k.ok ? "ok" : "UNDERKÄNT") : "ingen"}. ${k?.not ?? ""}`);
  rader.push("");
  return rader;
}
