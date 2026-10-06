import { z } from "zod";
import { lasPrompt, strukturerat } from "../analyze/klient.js";
import { konfig } from "../config.js";
import type { Db } from "../db/index.js";
import { arSparrad, hamtaProspektViaDoman } from "../db/fragor.js";
import { forebildsText } from "./forebilder.js";
import { hamtaEnkel, type EnkelSajt } from "./hamtaEnkel.js";
import type { Kundprofil } from "./kundprofil.js";
import type { Traff } from "./providers.js";

export const ForfilterSchema = z.object({
  passar: z.boolean(),
  kundtyp: z.number().nullable(),
  likhet: z.number(),
  namn: z.string().nullable(),
  yrke: z.string().nullable(),
  ort: z.string().nullable(),
  egen_kommunikationsfunktion: z.boolean(),
  har_personal: z.boolean(),
  saljer_webb_eller_kommunikation: z.boolean(),
  offentlig: z.boolean(),
  sajten_viktig: z.boolean(),
  orsak: z.string(),
});
export type Forfilter = z.infer<typeof ForfilterSchema>;

export interface ForfilterResultat {
  utfall: "godkand" | "bortvald";
  orsak: string;
  kundtyp: number | null;
  likhet: number | null;
  namn: string | null;
  yrke: string | null;
  ort: string | null;
  adress: string | null;
}

const STOR_ORGANISATION = /presskontakt|pressansvarig|presschef|pressekreterare|kommunikationschef|kommunikationsavdelning|kommunikationsdirekt[oö]r|kommunikationsenhet|marknadschef/i;
const OFFENTLIG = /\b(kommun|region|myndighet|landsting|statlig|förvaltning)\b/i;

/** Kodbaserade skäl som avgörs utan modell. Returnerar orsak eller null. */
export function kodskal(d: Db, doman: string, sajt: EnkelSajt): string | null {
  if (arSparrad(d, doman)) return "spärrlista eller befintlig kund";
  if (hamtaProspektViaDoman(d, doman)) return "finns redan i databasen";
  if (!sajt.svarar) return sajt.fel ?? "svarar inte";
  if (sajt.adresser.length === 0) return "ingen publicerad mejladress";
  if (/\.(gov|mil)\.se$|\.se$/.test(doman) && /^(www\.)?[a-z-]+\.(kommun|regionen)\.se$/.test(doman)) return "offentlig domän";
  const ord = sajt.text.split(/\s+/).length;
  if (ord < 40) return "för lite text på sajten";
  return null;
}

/**
 * Förfiltrering: kodsignaler plus en likhetspoäng mot förebilderna från den snabba modellen.
 * Kravet på personal och på att inte ha egen kommunikationsfunktion gäller bara kundtyp 2 och 3.
 */
export async function forfiltrera(d: Db, kp: Kundprofil, t: Traff, sajt: EnkelSajt): Promise<ForfilterResultat> {
  const k = konfig();
  const stopp = kodskal(d, t.doman, sajt);
  const bas = { kundtyp: t.kundtyp, likhet: null, namn: t.namn, yrke: null, ort: null, adress: sajt.adresser[0] ?? null };
  if (stopp) return { utfall: "bortvald", orsak: stopp, ...bas };

  const svar = await strukturerat({
    d,
    prospektId: null,
    steg: "forfilter",
    modell: k.MODEL_SNABB,
    system: lasPrompt("forfilter"),
    innehall: [
      {
        type: "text",
        text: [
          `Kundprofil:\n${kp.text}`,
          `Likhetsprofiler för förebilder${t.kundtyp ? ` av kundtyp ${t.kundtyp}` : ""}:\n${forebildsText(d, t.kundtyp ?? undefined)}`,
          `Kandidaten hittades genom: ${t.kalla}${t.varfor ? ` (${t.varfor})` : ""}${t.kundtyp ? `, sökt kundtyp ${t.kundtyp}` : ""}`,
          `Kandidat: ${t.doman}${t.namn ? ` (${t.namn})` : ""}\nMejladresser som hittats: ${sajt.adresser.join(", ")}\nPlattform: ${sajt.plattformTecken ?? "okänd"}\n\nText från sidorna:\n${sajt.text}`,
        ].join("\n\n"),
      },
    ],
    schema: ForfilterSchema,
    maxTokens: 1500,
  });

  const kundtyp = svar.kundtyp ?? t.kundtyp;
  const res = { kundtyp, likhet: svar.likhet, namn: svar.namn ?? t.namn, yrke: svar.yrke, ort: svar.ort, adress: sajt.adresser[0] ?? null };
  const skal: string[] = [];
  if (!svar.passar || !kundtyp) skal.push("passar ingen kundtyp");
  if (svar.offentlig || OFFENTLIG.test(svar.namn ?? "")) skal.push("offentlig verksamhet");
  if (svar.saljer_webb_eller_kommunikation) skal.push("säljer själv webb eller kommunikation");
  if (kundtyp && kundtyp !== 1) {
    if (svar.egen_kommunikationsfunktion || STOR_ORGANISATION.test(sajt.text)) skal.push("egen kommunikationsfunktion");
    if (!svar.har_personal) skal.push("ingen personal utöver en enskild person");
  }
  if (svar.likhet < kp.minLikhet) skal.push(`likhet ${svar.likhet.toFixed(2)} under gränsen ${kp.minLikhet}`);
  if (skal.length) return { utfall: "bortvald", orsak: `${skal.join(", ")}. ${svar.orsak}`, ...res };
  return { utfall: "godkand", orsak: svar.orsak, ...res };
}

export async function hamtaForForfilter(doman: string): Promise<EnkelSajt> {
  return hamtaEnkel(doman, 3);
}
