/**
 * Jämför en annan inställning (modell eller ändringar i .env) mot det som redan ligger i databasen (driften),
 * utan att röra driften.
 *
 * Arbetar mot en KOPIA av data/granskaren.db. Ingenting skrivs i den riktiga databasen och inget mejl skickas.
 * Samma hämtade sidor (data/underlag/<domän>.json) används som underlag, så skillnaden är bara inställningarna.
 *
 *   npx tsx scripts/jamfor-modeller.ts --steg steg1 --env MODEL_ANALYS=claude-sonnet-5-5 --sajter a.se,b.se
 *   npx tsx scripts/jamfor-modeller.ts --steg steg2 --env MODEL_ANALYS=claude-sonnet-5-5 --env ANALYS_MAX_FYND=4 --env ANALYS_KORT=true --sajter a.se
 *   npx tsx scripts/jamfor-modeller.ts --modell claude-sonnet-5-5 --discover 7 --segment --likhetsprofil
 *   npx tsx scripts/jamfor-modeller.ts --snabb claude-haiku-5-5 --verifiering a.se,b.se
 *
 * --env KEY=VÄRDE sätter vilken inställning som helst ur .env för körningen (kan upprepas). --modell är en kortform
 * för --env MODEL_ANALYS=..., --snabb för --env MODEL_SNABB=.... Sajterna går genom samma väg som driften: analys,
 * verifiering, upptrappning om den är på, val av fynd, utkast och grind. Resultatet skrivs till
 * data/jamforelse/<datum>-<klockslag>-<etikett>.md och .json.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const arg = (namn: string): string | undefined => {
  const i = args.indexOf(`--${namn}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const allaArg = (namn: string): string[] => args.flatMap((a, i) => (a === `--${namn}` && args[i + 1] ? [args[i + 1]] : []));
const flagga = (namn: string): boolean => args.includes(`--${namn}`);

// Måste sättas innan konfig() läses första gången. dotenv skriver inte över en satt variabel.
const overrides: Record<string, string> = {};
if (arg("modell")) overrides.MODEL_ANALYS = arg("modell")!;
if (arg("snabb")) overrides.MODEL_SNABB = arg("snabb")!;
for (const par of allaArg("env")) {
  const i = par.indexOf("=");
  if (i <= 0) throw new Error(`--env ska skrivas NYCKEL=VÄRDE, fick "${par}"`);
  overrides[par.slice(0, i)] = par.slice(i + 1);
}
for (const [kk, v] of Object.entries(overrides)) process.env[kk] = v;

const { DATA_DIR, konfig } = await import("../src/config.js");
const { db } = await import("../src/db/index.js");
const { analysMedUpptrappning } = await import("../src/audit.js");
const { verifieraFynd } = await import("../src/analyze/verifiering.js");
const { lasPrompt, strukturerat } = await import("../src/analyze/klient.js");
const { braForProspekt, fyndForProspekt } = await import("../src/db/fragor.js");
const { underlagSokvag } = await import("../src/report/rapport.js");
const { lasJson, sakerstallMapp } = await import("../src/util/fil.js");
const { valjFynd } = await import("../src/email/val.js");
const { sattIhop, skrivUtkast, tilltalFor } = await import("../src/email/utkast.js");
const { byggAmne, kvalitetsgrind } = await import("../src/email/grind.js");
const { kandaDomaner } = await import("../src/discover/discover.js");
const { WebbSokning } = await import("../src/discover/providers.js");
const { lasKundprofil } = await import("../src/discover/kundprofil.js");
const { forfiltrera, hamtaForForfilter } = await import("../src/discover/forfilter.js");
const { allaSegment, skapaSegment } = await import("../src/discover/segment.js");
const { hamtaEnkel } = await import("../src/discover/hamtaEnkel.js");
const { LikhetsprofilSchema } = await import("../src/discover/forebilder.js");
type Underlag = import("../src/analyze/underlag.js").Underlag;
type Prospekt = import("../src/db/fragor.js").Prospekt;
type FyndRad = import("../src/db/fragor.js").FyndRad;
type Fynd = import("../src/analyze/schema.js").Fynd;
type Huvudinsikt = import("../src/analyze/schema.js").Huvudinsikt;
type Profil = import("../src/analyze/schema.js").Profil;

const k = konfig();
for (const [kk, v] of Object.entries(overrides)) {
  const faktiskt = String((k as unknown as Record<string, unknown>)[kk]);
  if (faktiskt !== v && !(v === "true" && faktiskt === "true") && !(v === "false" && faktiskt === "false")) {
    throw new Error(`${kk} blev ${faktiskt}, väntade ${v}`);
  }
}
const ETIKETT = arg("steg") ?? [overrides.MODEL_ANALYS, overrides.MODEL_SNABB].filter(Boolean).join("+") ?? "drift";

const PROD = path.join(DATA_DIR, "granskaren.db");
const UT = sakerstallMapp(path.join(DATA_DIR, "jamforelse"));
const datum = new Date().toISOString().slice(0, 10);
const klockan = new Date().toTimeString().slice(0, 5).replace(":", "");
const KOPIA = path.join(UT, `kopia-${ETIKETT}.db`);

const prod = new Database(PROD, { readonly: true });
for (const f of [KOPIA, `${KOPIA}-wal`, `${KOPIA}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
await prod.backup(KOPIA);
const sb = db(KOPIA);
console.log(`Etikett ${ETIKETT}. Inställningar: ${JSON.stringify(overrides)}. Analysmodell ${k.MODEL_ANALYS}, snabb ${k.MODEL_SNABB}, upptrappning ${k.UPPTRAPPNING ? k.MODEL_UPPTRAPPNING : "av"}, max fynd ${k.ANALYS_MAX_FYND}, kort ${k.ANALYS_KORT}, ordmål ${k.MEJL_ORDMAL || "prompt"}, max ord ${k.MEJL_MAX_ORD}, fler fynd ${k.MEJL_FLER_FYND}, cache ${k.CACHE_TTL}.`);
console.log(`Kopia av databasen: ${KOPIA}`);

interface KostRad {
  steg: string;
  modell: string;
  n: number;
  usd: number;
  tin: number;
  tut: number;
  cl: number;
  cs: number;
}
const kostnadSedan = (startId: number): KostRad[] =>
  sb
    .prepare(
      "SELECT steg, modell, COUNT(*) n, COALESCE(SUM(kostnad_usd),0) usd, SUM(tokens_in) tin, SUM(tokens_ut) tut, SUM(tokens_cache_las) cl, SUM(tokens_cache_skriv) cs FROM kostnader WHERE id > ? GROUP BY steg, modell ORDER BY usd DESC",
    )
    .all(startId) as KostRad[];
const maxKostId = (): number => (sb.prepare("SELECT COALESCE(MAX(id),0) m FROM kostnader").get() as { m: number }).m;
const summa = (r: { usd: number }[]) => r.reduce((s, x) => s + x.usd, 0);

function sakraProfilpunkter(profil: Profil | null): Record<string, string> {
  if (!profil) return {};
  const ut: Record<string, string> = {};
  for (const [kk, v] of Object.entries(profil)) {
    if (kk === "borja_med" || kk === "person") continue;
    const p = v as { varde: string; sakerhet: number; gissning: boolean };
    if (p && typeof p.varde === "string" && !p.gissning && p.sakerhet >= 0.7) ut[kk] = p.varde;
  }
  return ut;
}

function hamtaProd(doman: string) {
  const p = prod.prepare("SELECT * FROM prospekt WHERE doman = ?").get(doman) as Prospekt | undefined;
  if (!p) throw new Error(`${doman} finns inte i databasen`);
  const u = lasJson<Underlag>(underlagSokvag(doman));
  const lankRad = prod.prepare("SELECT radata FROM matningar WHERE prospekt_id = ? AND verktyg = 'lankar' ORDER BY id DESC LIMIT 1").get(p.id) as { radata: string } | undefined;
  const lankar = lankRad ? JSON.parse(lankRad.radata) : [];
  const fynd = prod.prepare("SELECT * FROM fynd WHERE prospekt_id = ? ORDER BY id").all(p.id) as FyndRad[];
  const mejl = prod.prepare("SELECT * FROM mejl WHERE prospekt_id = ? AND typ = 'forsta' ORDER BY id DESC LIMIT 1").get(p.id) as
    | { mottagare: string | null; amne: string; text: string; anvanda_fynd: string }
    | undefined;
  const kostnad = prod.prepare("SELECT steg, modell, COUNT(*) n, COALESCE(SUM(kostnad_usd),0) usd FROM kostnader WHERE prospekt_id = ? GROUP BY steg, modell").all(p.id) as { steg: string; modell: string; n: number; usd: number }[];
  const utkastHandelse = prod.prepare("SELECT detaljer FROM handelser WHERE prospekt_id = ? AND typ = 'utkast_skapat' ORDER BY id LIMIT 1").get(p.id) as { detaljer: string } | undefined;
  return { p, u, lankar, fynd, mejl, kostnad, utkastHandelse };
}

interface FyndKort {
  id: string;
  omrade: string;
  djup: number;
  rubrik: string;
  verifierad: boolean;
  metod: string | null;
  not: string | null;
}
interface SajtResultat {
  doman: string;
  kundtyp: number | null;
  sekunder: number;
  huvudinsikt: string | null;
  fynd: FyndKort[];
  bekraftade: number;
  djup3Bekraftat: boolean;
  upptrappad: string | null;
  valda: string[];
  flerFynd: number | null;
  amne: string | null;
  mejl: string | null;
  grind: { godkand: boolean; godkandForstaForsoket: boolean; utfall: string; fel: string[]; varningar: string[]; forsok: number } | null;
  ingetMejl: string | null;
  kostnad: KostRad[];
  drift: {
    huvudinsikt: string | null;
    fynd: FyndKort[];
    bekraftade: number;
    djup3Bekraftat: boolean;
    valda: string[];
    amne: string | null;
    mejl: string | null;
    grindForstaForsoket: boolean | null;
    kostnad: { steg: string; modell: string; n: number; usd: number }[];
  };
}

async function jamforSajt(doman: string): Promise<SajtResultat> {
  const { p, u, lankar, fynd: driftFynd, mejl: driftMejl, kostnad: driftKost, utkastHandelse } = hamtaProd(doman);

  // Rensa det driften gjorde i kopian så att grinden och fyndvalet bara ser den nya körningens resultat
  sb.prepare("DELETE FROM fynd WHERE prospekt_id = ?").run(p.id);
  sb.prepare("DELETE FROM bra WHERE prospekt_id = ?").run(p.id);
  sb.prepare("DELETE FROM mejl WHERE prospekt_id = ?").run(p.id);
  sb.prepare("DELETE FROM handelser WHERE prospekt_id = ? AND typ = 'upptrappning'").run(p.id);

  console.log(`\n== ${doman} (#${p.id}, kundtyp ${p.kundtyp ?? "-"}) ==`);
  const start = maxKostId();
  const t0 = Date.now();
  const { utfall, upptrappad } = await analysMedUpptrappning(sb, p, u, lankar);
  const analys = utfall.analys;
  const fyndKort: FyndKort[] = (sb.prepare("SELECT * FROM fynd WHERE prospekt_id = ? ORDER BY id").all(p.id) as FyndRad[]).map((f) => ({
    id: f.fynd_id,
    omrade: f.omrade,
    djup: f.djup,
    rubrik: f.rubrik,
    verifierad: f.verifierad === 1,
    metod: f.verifieringsmetod,
    not: f.verifierad ? null : f.verifieringsnot,
  }));
  const huvudinsikt: Huvudinsikt | null = analys.huvudinsikt;

  const profil: Profil = { ...analys.profil, borja_med: analys.borja_med } as unknown as Profil;
  const fynd = fyndForProspekt(sb, p.id, true);
  const val = valjFynd(fynd, huvudinsikt);
  let mejl: string | null = null;
  let amne: string | null = null;
  let grind: SajtResultat["grind"] = null;
  let flerFynd: number | null = null;
  if (!val.orsak && huvudinsikt) {
    const pSb: Prospekt = { ...p, namn: p.namn ?? analys.organisationsnamn ?? null, organisationstyp: analys.organisationstyp };
    const tilltal = tilltalFor(profil, p.kundtyp);
    amne = byggAmne(k.AMNESMALL, p.doman, pSb.namn);
    const mottagare = driftMejl?.mottagare ?? "test@example.com";
    const bra = braForProspekt(sb, p.id);
    flerFynd = k.MEJL_FLER_FYND ? fynd.filter((f) => !val.fynd.includes(f)).length : null;
    const grindAlt = { testlage: false, huvudinsikt: huvudinsikt.text, profil: JSON.stringify(sakraProfilpunkter(profil)), tilltal: tilltal.tilltal, flerFynd };
    console.log(`   skriver utkast (${val.fynd.map((f) => f.fynd_id).join(", ")})${flerFynd !== null ? `, ${flerFynd} fynd till utanför mejlet` : ""}`);
    let utkast = await skrivUtkast(sb, pSb, val.fynd, huvudinsikt, profil, tilltal, [], flerFynd);
    let g = await kvalitetsgrind(sb, pSb, { amne, brodtext: utkast.brodtext }, val.fynd, bra, mottagare, grindAlt);
    const godkandForstaForsoket = g.godkand;
    let forsok = 1;
    if (!g.godkand) {
      console.log(`   grinden stoppade (${g.fel.join("; ")}), nytt försök`);
      forsok = 2;
      utkast = await skrivUtkast(sb, pSb, val.fynd, huvudinsikt, profil, tilltal, g.fel, flerFynd);
      g = await kvalitetsgrind(sb, pSb, { amne, brodtext: utkast.brodtext }, val.fynd, bra, mottagare, grindAlt);
    }
    mejl = sattIhop(utkast.brodtext, tilltal.tilltal);
    grind = { godkand: g.godkand, godkandForstaForsoket, utfall: g.utfall, fel: g.fel, varningar: g.varningar, forsok };
    console.log(`   grind: ${g.godkand ? "godkänt" : `STOPPAT: ${g.fel.join("; ")}`} -> ${g.utfall}${g.varningar.length ? ` (varningar: ${g.varningar.join("; ")})` : ""}`);
  } else {
    console.log(`   inget mejl: ${val.orsak ?? "ingen huvudinsikt"}`);
  }

  const kostnad = kostnadSedan(start);
  console.log(`   kostnad: ${summa(kostnad).toFixed(4)} USD, ${Math.round((Date.now() - t0) / 1000)} s${upptrappad ? `, upptrappad (${upptrappad})` : ""}`);
  let driftGrindForsta: boolean | null = null;
  if (utkastHandelse?.detaljer) {
    const det = JSON.parse(utkastHandelse.detaljer) as { fel?: string[] };
    driftGrindForsta = (det.fel ?? []).length === 0;
  }
  return {
    doman,
    kundtyp: p.kundtyp,
    sekunder: Math.round((Date.now() - t0) / 1000),
    huvudinsikt: huvudinsikt?.text ?? null,
    fynd: fyndKort,
    bekraftade: utfall.bekraftade,
    djup3Bekraftat: utfall.djup3Bekraftat,
    upptrappad,
    valda: val.fynd.map((f) => f.fynd_id),
    flerFynd,
    amne,
    mejl,
    grind,
    ingetMejl: val.orsak ?? (huvudinsikt ? null : "ingen huvudinsikt"),
    kostnad,
    drift: {
      huvudinsikt: p.huvudinsikt ? (JSON.parse(p.huvudinsikt) as Huvudinsikt).text : null,
      fynd: driftFynd.map((f) => ({ id: f.fynd_id, omrade: f.omrade, djup: f.djup, rubrik: f.rubrik, verifierad: f.verifierad === 1, metod: f.verifieringsmetod, not: f.verifierad ? null : f.verifieringsnot })),
      bekraftade: driftFynd.filter((f) => f.verifierad === 1).length,
      djup3Bekraftat: driftFynd.some((f) => f.verifierad === 1 && f.djup === 3),
      valda: driftMejl ? (JSON.parse(driftMejl.anvanda_fynd) as string[]) : [],
      amne: driftMejl?.amne ?? null,
      mejl: driftMejl?.text ?? null,
      grindForstaForsoket: driftGrindForsta,
      kostnad: driftKost,
    },
  };
}

/** Verifierar driftens fynd en gång till med den snabba modellen som är satt, och jämför utfallet. */
interface VerifieringsJamforelse {
  doman: string;
  rader: { id: string; omrade: string; djup: number; rubrik: string; drift: boolean; driftMetod: string | null; ny: boolean; nyNot: string }[];
  lika: number;
  kostnad: KostRad[];
  driftKostnad: number;
}
async function jamforVerifiering(doman: string): Promise<VerifieringsJamforelse> {
  const { p, u, lankar, fynd, kostnad } = hamtaProd(doman);
  console.log(`\n== verifiering ${doman}: ${fynd.length} fynd ==`);
  const start = maxKostId();
  const rader: VerifieringsJamforelse["rader"] = [];
  for (const r of fynd) {
    const f: Fynd = {
      id: r.fynd_id,
      omrade: r.omrade as Fynd["omrade"],
      tjansteomrade: r.tjansteomrade as Fynd["tjansteomrade"],
      rubrik: r.rubrik,
      observation: r.observation,
      belagg: { url: r.belagg_url, typ: r.belagg_typ as Fynd["belagg"]["typ"], varde: r.belagg_varde },
      belagg2: r.belagg2_url ? { url: r.belagg2_url, typ: r.belagg2_typ as Fynd["belagg"]["typ"], varde: r.belagg2_varde ?? "" } : null,
      effekt: r.effekt,
      atgard: r.atgard,
      allvar: r.allvar,
      sakerhet: r.sakerhet,
      latt_att_forklara: r.latt_att_forklara,
      djup: r.djup,
      insikt: r.insikt ?? "",
      rotorsak: r.rotorsak,
      forslag_konkret: r.forslag_konkret,
      insats: (r.insats ?? "medel") as Fynd["insats"],
      kopplar_till_syfte: r.kopplar_till_syfte === 1,
    };
    const v = await verifieraFynd(sb, p.id, u, f, lankar);
    rader.push({ id: r.fynd_id, omrade: r.omrade, djup: r.djup, rubrik: r.rubrik, drift: r.verifierad === 1, driftMetod: r.verifieringsmetod, ny: v.verifierad, nyNot: v.not });
    console.log(`   ${r.fynd_id}: drift ${r.verifierad ? "ok " : "nej"}, ny ${v.verifierad ? "ok " : "nej"}  ${r.rubrik}${v.verifierad === (r.verifierad === 1) ? "" : `  <-- SKILJER: ${v.not.slice(0, 200)}`}`);
  }
  const kost = kostnadSedan(start);
  const driftKostnad = summa(kostnad.filter((x) => x.steg === "verifiering"));
  console.log(`   lika: ${rader.filter((r) => r.drift === r.ny).length} av ${rader.length}. Kostnad ${summa(kost).toFixed(4)} USD mot driftens ${driftKostnad.toFixed(4)} USD`);
  return { doman, rader, lika: rader.filter((r) => r.drift === r.ny).length, kostnad: kost, driftKostnad };
}

interface DiscoverResultat {
  segment: string;
  driftTraffar: { doman: string; utfall: string; orsak: string | null }[];
  traffar: { doman: string; namn: string | null; utfall: string; orsak: string | null; nyForModellen: boolean }[];
  kostnad: KostRad[];
  sekunder: number;
}

async function jamforDiscover(segmentId: number): Promise<DiscoverResultat> {
  const segment = allaSegment(sb).find((s) => s.id === segmentId);
  if (!segment) throw new Error(`Segment ${segmentId} finns inte`);
  const kp = lasKundprofil();
  const driftTraffar = prod.prepare("SELECT doman, utfall, orsak FROM kandidater WHERE segment_id = ? ORDER BY id").all(segmentId) as { doman: string; utfall: string; orsak: string | null }[];
  const kanda = kandaDomaner(sb);
  for (const t of driftTraffar) kanda.delete(t.doman); // låt modellen hitta samma sajter igen
  console.log(`\n== discover: segment ${segmentId}, ${segment.yrke} i ${segment.ort} (driften hittade ${driftTraffar.length}) ==`);
  const start = maxKostId();
  const t0 = Date.now();
  const traffar = await new WebbSokning().sok(sb, kp, segment, 15, kanda);
  console.log(`   ${traffar.length} träffar`);
  const ut: DiscoverResultat["traffar"] = [];
  for (const t of traffar) {
    const tidigare = driftTraffar.find((o) => o.doman === t.doman);
    if (tidigare) {
      ut.push({ doman: t.doman, namn: t.namn, utfall: tidigare.utfall, orsak: tidigare.orsak, nyForModellen: false });
      console.log(`   ${t.doman}: samma som driften (${tidigare.utfall})`);
      continue;
    }
    try {
      const sajt = await hamtaForForfilter(t.doman);
      const f = await forfiltrera(sb, kp, t, sajt);
      ut.push({ doman: t.doman, namn: f.namn ?? t.namn, utfall: f.utfall, orsak: f.orsak, nyForModellen: true });
      console.log(`   ${t.doman}: ${f.utfall} (${f.orsak.slice(0, 90)})`);
    } catch (e) {
      ut.push({ doman: t.doman, namn: t.namn, utfall: "fel", orsak: e instanceof Error ? e.message : String(e), nyForModellen: true });
    }
  }
  const kostnad = kostnadSedan(start);
  console.log(`   kostnad: ${summa(kostnad).toFixed(4)} USD`);
  return { segment: `${segment.yrke} i ${segment.ort} ("${segment.sokfras}")`, driftTraffar, traffar: ut, kostnad, sekunder: Math.round((Date.now() - t0) / 1000) };
}

async function jamforSegment(): Promise<{ befintliga: string[]; nya: string[]; kostnad: KostRad[] }> {
  console.log("\n== segment ==");
  const befintliga = allaSegment(sb).map((s) => `kundtyp ${s.kundtyp}: ${s.yrke} i ${s.ort} ("${s.sokfras}")`);
  const start = maxKostId();
  const nya = await skapaSegment(sb, 6);
  const kostnad = kostnadSedan(start);
  console.log(`   kostnad: ${summa(kostnad).toFixed(4)} USD`);
  return { befintliga, nya: nya.map((s) => `kundtyp ${s.kundtyp}: ${s.yrke} i ${s.ort} ("${s.sokfras}") – ${s.motivering ?? ""}`), kostnad };
}

async function jamforLikhetsprofil(): Promise<{ doman: string; drift: unknown; ny: unknown; kostnad: KostRad[] }[]> {
  console.log("\n== likhetsprofil ==");
  const kp = lasKundprofil();
  const ut = [];
  for (const f of kp.forebilder) {
    const rad = prod.prepare("SELECT profil FROM likhetsprofil WHERE doman = ?").get(f.doman) as { profil: string } | undefined;
    const sajt = await hamtaEnkel(f.doman, 4);
    if (!sajt.svarar) {
      console.log(`   ${f.doman} svarar inte`);
      continue;
    }
    const start = maxKostId();
    const profil = await strukturerat({
      d: sb,
      prospektId: null,
      steg: "likhetsprofil",
      modell: k.MODEL_ANALYS,
      system: lasPrompt("likhetsprofil"),
      innehall: [{ type: "text", text: `Kundprofil:\n${kp.text}\n\nRawaz beskrivning av kunden: ${f.beskrivning || "(ingen)"}\n\nSajten ${f.doman}, text från sidorna:\n${sajt.text}` }],
      schema: LikhetsprofilSchema,
      maxTokens: 3000,
      effort: "medium",
    });
    const kostnad = kostnadSedan(start);
    console.log(`   ${f.doman}: kundtyp ${profil.kundtyp}, ${profil.yrke}. Liknande: ${profil.liknande_yrken.join(", ")}. ${summa(kostnad).toFixed(4)} USD`);
    ut.push({ doman: f.doman, drift: rad ? JSON.parse(rad.profil) : null, ny: profil, kostnad });
  }
  return ut;
}

// ---------- kör ----------
const lista = (namn: string) => (arg(namn) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const resultat: {
  etikett: string;
  installningar: Record<string, string>;
  analysmodell: string;
  snabbModell: string;
  datum: string;
  sajter: SajtResultat[];
  verifiering: VerifieringsJamforelse[];
  discover?: DiscoverResultat;
  segment?: Awaited<ReturnType<typeof jamforSegment>>;
  likhetsprofil?: Awaited<ReturnType<typeof jamforLikhetsprofil>>;
} = { etikett: ETIKETT, installningar: overrides, analysmodell: k.MODEL_ANALYS, snabbModell: k.MODEL_SNABB, datum, sajter: [], verifiering: [] };

for (const dom of lista("sajter")) {
  try {
    resultat.sajter.push(await jamforSajt(dom));
  } catch (e) {
    console.error(`FEL ${dom}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
for (const dom of lista("verifiering")) {
  try {
    resultat.verifiering.push(await jamforVerifiering(dom));
  } catch (e) {
    console.error(`FEL verifiering ${dom}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const discoverSegment = arg("discover");
if (discoverSegment) resultat.discover = await jamforDiscover(Number.parseInt(discoverSegment, 10));
if (flagga("segment")) resultat.segment = await jamforSegment();
if (flagga("likhetsprofil")) resultat.likhetsprofil = await jamforLikhetsprofil();

const bas = path.join(UT, `${datum}-${klockan}-${ETIKETT}`);
fs.writeFileSync(`${bas}.json`, JSON.stringify(resultat, null, 2), "utf8");

// ---------- markdown ----------
const M = ETIKETT;
const rader: string[] = [
  `# Jämförelse ${ETIKETT}, ${datum} ${klockan.slice(0, 2)}:${klockan.slice(2)}`,
  "",
  `Inställningar: ${Object.entries(overrides).map(([a, b]) => `${a}=${b}`).join(", ") || "(driftens)"}. Analysmodell ${k.MODEL_ANALYS}, snabb modell ${k.MODEL_SNABB}. Samma hämtade sidor som underlag. Körd mot en kopia av databasen, inget skickat.`,
  "",
];
const ja = (b: boolean | null) => (b === null ? "-" : b ? "ja" : "nej");
if (resultat.sajter.length) {
  rader.push("## Mått per sajt", "");
  rader.push("| Sajt | Fynd | Bekräftade | Djup 3 | Grind första försöket | Upptrappad | Kostnad | Drift: fynd | Drift: bekräftade | Drift: kostnad |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const s of resultat.sajter) {
    rader.push(
      `| ${s.doman} | ${s.fynd.length} | ${s.bekraftade} (${Math.round((100 * s.bekraftade) / Math.max(1, s.fynd.length))} %) | ${ja(s.djup3Bekraftat)} | ${s.grind ? ja(s.grind.godkandForstaForsoket) : `inget mejl: ${s.ingetMejl}`} | ${s.upptrappad ?? "nej"} | ${summa(s.kostnad).toFixed(3)} | ${s.drift.fynd.length} | ${s.drift.bekraftade} (${Math.round((100 * s.drift.bekraftade) / Math.max(1, s.drift.fynd.length))} %) | ${summa(s.drift.kostnad).toFixed(3)} |`,
    );
  }
  const tot = resultat.sajter.reduce((a, s) => ({ f: a.f + s.fynd.length, b: a.b + s.bekraftade, k: a.k + summa(s.kostnad), df: a.df + s.drift.fynd.length, db: a.db + s.drift.bekraftade, dk: a.dk + summa(s.drift.kostnad) }), { f: 0, b: 0, k: 0, df: 0, db: 0, dk: 0 });
  rader.push(`| **Summa** | ${tot.f} | ${tot.b} (${Math.round((100 * tot.b) / Math.max(1, tot.f))} %) | | | ${resultat.sajter.filter((s) => s.upptrappad).length} | ${tot.k.toFixed(3)} (${(tot.k / resultat.sajter.length).toFixed(3)} per sajt) | ${tot.df} | ${tot.db} (${Math.round((100 * tot.db) / Math.max(1, tot.df))} %) | ${tot.dk.toFixed(3)} (${(tot.dk / resultat.sajter.length).toFixed(3)} per sajt) |`, "");
}
const fyndLista = (f: FyndKort[]) => f.map((x) => `- ${x.verifierad ? "ok " : "NEJ"} ${x.id} ${x.omrade} djup ${x.djup}: ${x.rubrik}${x.not ? ` _(${x.not.slice(0, 160)})_` : ""}`).join("\n");
const kostTabell = (r: { steg: string; modell: string; n: number; usd: number }[]) =>
  ["| Steg | Modell | Anrop | USD |", "|---|---|---|---|", ...r.map((x) => `| ${x.steg} | ${x.modell} | ${x.n} | ${x.usd.toFixed(4)} |`), `| **Summa** | | | **${summa(r).toFixed(4)}** |`].join("\n");
for (const s of resultat.sajter) {
  rader.push(`## ${s.doman}`, "");
  rader.push(`| | Drift (Opus) | ${M} |`, "|---|---|---|");
  rader.push(`| Bekräftade fynd | ${s.drift.bekraftade} av ${s.drift.fynd.length} | ${s.bekraftade} av ${s.fynd.length} |`);
  rader.push(`| Bekräftat fynd med djup 3 | ${ja(s.drift.djup3Bekraftat)} | ${ja(s.djup3Bekraftat)} |`);
  rader.push(`| Upptrappad | - | ${s.upptrappad ?? "nej"} |`);
  rader.push(`| Valda fynd i mejlet | ${s.drift.valda.join(", ") || "-"} | ${s.valda.join(", ") || "-"} |`);
  rader.push(`| Grind | ${s.drift.grindForstaForsoket === null ? "skickat" : s.drift.grindForstaForsoket ? "godkänt första försöket" : "godkänt efter nytt försök"} | ${s.grind ? `${s.grind.godkand ? "godkänt" : "stoppat"} -> ${s.grind.utfall}, ${s.grind.forsok} försök` : s.ingetMejl} |`);
  rader.push(`| Kostnad | ${summa(s.drift.kostnad).toFixed(4)} USD | ${summa(s.kostnad).toFixed(4)} USD |`);
  rader.push(`| Tid | | ${s.sekunder} s |`, "");
  rader.push("### Huvudinsikt", "", `**Drift:** ${s.drift.huvudinsikt ?? "(ingen)"}`, "", `**${M}:** ${s.huvudinsikt ?? "(ingen)"}`, "");
  rader.push("### Fynd", "", "**Drift**", "", fyndLista(s.drift.fynd), "", `**${M}**`, "", fyndLista(s.fynd), "");
  rader.push("### Mejl", "", "**Drift (det som skickades)**", "", "```", s.drift.mejl ?? "(inget)", "```", "", `**${M}**`, "", "```", s.mejl ?? `(inget: ${s.ingetMejl})`, "```", "");
  if (s.grind?.varningar.length) rader.push(`Varningar från grinden: ${s.grind.varningar.join("; ")}`, "");
  if (s.grind && !s.grind.godkand) rader.push(`Grindfel: ${s.grind.fel.join("; ")}`, "");
  rader.push("### Kostnad", "", "**Drift**", "", kostTabell(s.drift.kostnad), "", `**${M}**`, "", kostTabell(s.kostnad), "");
}
for (const v of resultat.verifiering) {
  rader.push(`## verifiering ${v.doman} med ${k.MODEL_SNABB}`, "");
  rader.push(`Lika utfall: ${v.lika} av ${v.rader.length}. Kostnad ${summa(v.kostnad).toFixed(4)} USD mot driftens ${v.driftKostnad.toFixed(4)} USD.`, "");
  rader.push("| Fynd | Drift | Ny | Rubrik | Not vid skillnad |", "|---|---|---|---|---|");
  for (const r of v.rader) rader.push(`| ${r.id} ${r.omrade} djup ${r.djup} | ${r.drift ? "ok" : "nej"} | ${r.ny ? "ok" : "nej"} | ${r.rubrik} | ${r.drift === r.ny ? "" : r.nyNot.slice(0, 200).replace(/\|/g, "/")} |`);
  rader.push("");
}
if (resultat.discover) {
  const dsc = resultat.discover;
  rader.push(`## discover: ${dsc.segment}`, "");
  rader.push(`Driften hittade ${dsc.driftTraffar.length}: ${dsc.driftTraffar.map((t) => `${t.doman} (${t.utfall})`).join(", ")}`, "");
  rader.push(`${M} hittade ${dsc.traffar.length}, ${dsc.sekunder} s:`, "");
  for (const t of dsc.traffar) rader.push(`- ${t.doman}${t.namn ? ` (${t.namn})` : ""}: ${t.utfall}${t.nyForModellen ? "" : " [samma som driften]"}${t.orsak ? ` – ${t.orsak.slice(0, 140)}` : ""}`);
  rader.push("", kostTabell(dsc.kostnad), "");
}
if (resultat.segment) {
  rader.push("## segment", "", "**Befintliga (drift)**", "", ...resultat.segment.befintliga.map((s) => `- ${s}`), "", `**Nya från ${M}**`, "", ...resultat.segment.nya.map((s) => `- ${s}`), "", kostTabell(resultat.segment.kostnad), "");
}
if (resultat.likhetsprofil) {
  rader.push("## likhetsprofil", "");
  for (const l of resultat.likhetsprofil) {
    rader.push(`### ${l.doman}`, "", "**Drift**", "", "```json", JSON.stringify(l.drift, null, 1), "```", "", `**${M}**`, "", "```json", JSON.stringify(l.ny, null, 1), "```", "", kostTabell(l.kostnad), "");
  }
}
fs.writeFileSync(`${bas}.md`, rader.join("\n"), "utf8");
console.log(`\nKlart. ${bas}.md`);
sb.close();
prod.close();
for (const f of [KOPIA, `${KOPIA}-wal`, `${KOPIA}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
