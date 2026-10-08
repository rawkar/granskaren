import { KostnadstakError } from "../analyze/klient.js";
import type { Db } from "../db/index.js";
import {
  allaProspekt,
  laggTillProspekt,
  loggaHandelse,
  markeraSoktraffBehandlad,
  obehandladeSoktraffar,
  segmentSoktNyligen,
  SOKTRAFF_DAGAR,
  sparaSoktraffar,
} from "../db/fragor.js";
import { logg, paus } from "../util/logg.js";
import { forfiltrera, hamtaForForfilter } from "./forfilter.js";
import { likhetsprofiler } from "./forebilder.js";
import { aktuellFordelning, fordelaAntal, lasKundprofil } from "./kundprofil.js";
import { providerFor, type Traff } from "./providers.js";
import { allaSegment, skapaSegment, type SegmentRad } from "./segment.js";

export interface DiscoverAlternativ {
  antal: number; // önskat antal godkända prospekt
  kallor: string[]; // webb, lankar
  kundtyp?: number;
  segmentId?: number;
}

/** Domäner som redan är kända: prospekt, kandidater, förebilder och spärrlista. */
export function kandaDomaner(d: Db): Set<string> {
  const s = new Set<string>();
  for (const p of allaProspekt(d)) s.add(p.doman);
  for (const r of d.prepare("SELECT doman FROM kandidater").all() as { doman: string }[]) s.add(r.doman);
  for (const r of d.prepare("SELECT doman FROM likhetsprofil").all() as { doman: string }[]) s.add(r.doman);
  for (const r of d.prepare("SELECT varde FROM sparrlista WHERE typ = 'doman'").all() as { varde: string }[]) s.add(r.varde);
  return s;
}

/**
 * Hittar nya prospekt: tar fram segment vid behov, söker via valda källor, förfiltrerar varje träff
 * och lägger godkända i tabellen prospekt med kundtyp och likhet. Allt loggas i kandidater.
 *
 * Alla träffar från en webbsökning sparas i soktraffar. Träffar som inte hann prövas innan målet
 * var nått prövas nästa gång innan någon ny sökning görs, i upp till SOKTRAFF_DAGAR dagar.
 */
export async function discover(d: Db, alt: DiscoverAlternativ): Promise<{ godkanda: number; bortvalda: number; traffar: number }> {
  const kp = lasKundprofil();
  if (likhetsprofiler(d).length === 0) {
    throw new Error("Inga förebilder är profilerade. Kör först: granskaren forebilder");
  }
  const res = { godkanda: 0, bortvalda: 0, traffar: 0 };
  const kanda = kandaDomaner(d);
  const fordelning = aktuellFordelning(d, kp);
  const malPerTyp = alt.kundtyp ? { [alt.kundtyp]: alt.antal } : fordelaAntal(alt.antal, fordelning);
  const godkandaPerTyp: Record<number, number> = {};
  logg.info(`Mål: ${Object.entries(malPerTyp).map(([t, n]) => `kundtyp ${t}: ${n}`).join(", ")}. Källor: ${alt.kallor.join(", ")}`);

  const insKandidat = d.prepare(
    "INSERT OR IGNORE INTO kandidater (doman, namn, kalla, segment_id, kundtyp, likhet, utfall, orsak) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const behandla = async (t: Traff): Promise<void> => {
    res.traffar++;
    logg.info(`   ${t.doman}${t.namn ? ` (${t.namn})` : ""}`);
    try {
      const sajt = await hamtaForForfilter(t.doman);
      const f = await forfiltrera(d, kp, t, sajt);
      insKandidat.run(t.doman, f.namn, t.kalla, t.segmentId, f.kundtyp, f.likhet, f.utfall, f.orsak);
      markeraSoktraffBehandlad(d, t.doman);
      if (f.utfall === "godkand" && f.kundtyp) {
        const mal = malPerTyp[f.kundtyp] ?? 0;
        if ((godkandaPerTyp[f.kundtyp] ?? 0) >= mal && !alt.kundtyp) {
          logg.info(`      passar (kundtyp ${f.kundtyp}, likhet ${f.likhet?.toFixed(2)}) men målet för typen är nått, sparas som kandidat`);
          return;
        }
        const { ny, id } = laggTillProspekt(d, { doman: t.doman, namn: f.namn, bransch: f.yrke, ort: f.ort, kalla: t.kalla, kommentar: f.orsak, kundtyp: f.kundtyp, likhet: f.likhet });
        if (ny) {
          loggaHandelse(d, id, "hittad", { kalla: t.kalla, kundtyp: f.kundtyp, likhet: f.likhet, segment: t.segmentId });
          godkandaPerTyp[f.kundtyp] = (godkandaPerTyp[f.kundtyp] ?? 0) + 1;
          res.godkanda++;
          logg.info(`      godkänd: kundtyp ${f.kundtyp}, likhet ${f.likhet?.toFixed(2)}, ${f.yrke ?? ""}${f.ort ? ` i ${f.ort}` : ""}, ${f.adress}`);
        }
      } else {
        res.bortvalda++;
        logg.info(`      bortvald: ${f.orsak}`);
      }
    } catch (e) {
      if (e instanceof KostnadstakError) throw e;
      res.bortvalda++;
      insKandidat.run(t.doman, t.namn, t.kalla, t.segmentId, t.kundtyp, null, "fel", e instanceof Error ? e.message : String(e));
      markeraSoktraffBehandlad(d, t.doman);
      logg.varning(`      fel: ${e instanceof Error ? e.message : String(e)}`);
    }
    await paus(1500);
  };

  /** Prövar sparade träffar från tidigare sökningar innan någon ny sökning görs. */
  const provaSparade = async (typ: number, mal: number): Promise<void> => {
    const sparade = obehandladeSoktraffar(d, alt.segmentId ? { segmentId: alt.segmentId } : { kundtyp: typ });
    const attProva = sparade.filter((t) => !kanda.has(t.doman));
    for (const t of sparade) if (kanda.has(t.doman)) markeraSoktraffBehandlad(d, t.doman); // redan prospekt, kandidat eller spärrad
    if (attProva.length === 0) return;
    logg.info(`Prövar ${attProva.length} sparade träffar för kundtyp ${typ} från tidigare sökningar (högst ${SOKTRAFF_DAGAR} dagar gamla)`);
    for (const t of attProva) {
      if ((godkandaPerTyp[typ] ?? 0) >= mal) break;
      kanda.add(t.doman);
      await behandla({ doman: t.doman, namn: t.namn, kalla: t.kalla, segmentId: t.segment_id, kundtyp: t.kundtyp ?? typ, varfor: t.varfor });
    }
  };

  const klart = () => Object.entries(malPerTyp).every(([t, n]) => (godkandaPerTyp[Number(t)] ?? 0) >= n);

  for (const kallaNamn of alt.kallor) {
    if (klart()) break;
    const provider = providerFor(kallaNamn);

    if (provider.namn === "lankar") {
      const traffar = await provider.sok(d, kp, { id: 0, kundtyp: 0, yrke: "", ort: "", sokfras: "", motivering: null, anvand: 0, traffar: 0 }, alt.antal * 3, kanda);
      logg.info(`Källan ${provider.namn} gav ${traffar.length} kandidater`);
      for (const t of traffar) {
        if (klart()) break;
        await behandla(t);
      }
      continue;
    }

    // Webbsökning: först sparade träffar, sedan ett segment i taget per kundtyp tills målet är nått
    for (const [typStr, mal] of Object.entries(malPerTyp)) {
      const typ = Number(typStr);
      await provaSparade(typ, mal);
      // Oprövade sparade träffar ska inte komma tillbaka som nya träffar i sökningen
      for (const t of obehandladeSoktraffar(d, { kundtyp: typ })) kanda.add(t.doman);
      let varv = 0;
      while ((godkandaPerTyp[typ] ?? 0) < mal && varv < 6) {
        varv++;
        const segment = await nastaSegment(d, typ, alt.segmentId);
        if (!segment) {
          logg.varning(`Inga segment kvar för kundtyp ${typ}.`);
          break;
        }
        const nyligen = segmentSoktNyligen(d, segment.id);
        if (nyligen) {
          logg.info(`Segmentet ${segment.yrke} i ${segment.ort} söktes ${nyligen} och söks inte om inom ${SOKTRAFF_DAGAR} dagar. Sparade träffar är redan prövade.`);
          break;
        }
        const kvar = mal - (godkandaPerTyp[typ] ?? 0);
        logg.info(`Söker (${provider.namn}): kundtyp ${typ}, ${segment.yrke} i ${segment.ort}, ${kvar} kvar`);
        const traffar = await provider.sok(d, kp, segment, Math.min(15, kvar * 3), kanda);
        d.prepare("UPDATE segment SET anvand = 1, traffar = traffar + ? WHERE id = ?").run(traffar.length, segment.id);
        sparaSoktraffar(
          d,
          traffar.map((t) => ({ segment_id: t.segmentId, kundtyp: t.kundtyp, kalla: t.kalla, doman: t.doman, namn: t.namn, varfor: t.varfor })),
        );
        logg.info(`   ${traffar.length} träffar, sparade i ${SOKTRAFF_DAGAR} dagar`);
        for (const t of traffar) {
          if ((godkandaPerTyp[typ] ?? 0) >= mal) break;
          await behandla(t);
        }
      }
    }
  }
  logg.info(`Klart. Träffar: ${res.traffar}, godkända: ${res.godkanda}, bortvalda: ${res.bortvalda}`);
  return res;
}

async function nastaSegment(d: Db, kundtyp: number, segmentId?: number): Promise<SegmentRad | undefined> {
  if (segmentId) return allaSegment(d).find((s) => s.id === segmentId);
  let s = allaSegment(d, true).find((x) => x.kundtyp === kundtyp);
  if (!s) {
    await skapaSegment(d, 6);
    s = allaSegment(d, true).find((x) => x.kundtyp === kundtyp);
  }
  return s;
}
