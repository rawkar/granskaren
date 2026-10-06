import * as cheerio from "cheerio";
import type { Db } from "../db/index.js";
import { normaliseraDoman } from "../util/domain.js";

export type KontaktTyp = "funktion" | "kommunikation" | "ledning" | "person" | "okand";

export interface Kontakt {
  adress: string;
  typ: KontaktTyp;
  kallsida: string;
  prioritet: number;
}

const FUNKTION = /^(info|kansli|kontakt|hej|hello|office|post|mail|reception|expedition|styrelsen|admin|kundtjanst|kundservice|bokning|support)@/;
const KOMMUNIKATION = /kommunikat|press|webb|web|marknad|media|info\./i;
const LEDNING = /ordforande|ordförande|vd|verksamhetschef|verksamhetsledare|generalsekreterare|kanslichef|chef|rektor|forestandare|föreståndare/i;

const BORT = /\.(png|jpe?g|gif|svg|webp|css|js)$|^(noreply|no-reply|donotreply|wordpress|example|exempel|sentry|mailer-daemon)@|@(example|sentry|wixpress|wordpress)\./i;

/** Avkodar vanliga förvrängningar som [at], (a), {snabel-a}, " at " och [dot]/(punkt). */
export function avkoda(text: string): string {
  return text
    .replace(/\s*[\[({<]\s*(at|a|snabel-?a|@)\s*[\])}>]\s*/gi, "@")
    .replace(/\s+at\s+(?=[a-z0-9-]+\s*[\[({<]?\s*(dot|punkt)|[a-z0-9-]+\.[a-z]{2,})/gi, "@")
    .replace(/\s*[\[({<]\s*(dot|punkt)\s*[\])}>]\s*/gi, ".")
    .replace(/\s+(dot|punkt)\s+(?=[a-z]{2,}\b)/gi, ".");
}

/** Letar efter mejladresser på en sida: mailto-länkar först, sedan text med förvrängningar. */
export function hittaAdresser(html: string, text: string): string[] {
  const $ = cheerio.load(html);
  const funna = new Set<string>();
  $('a[href^="mailto:"]').each((_, el) => {
    const raw = ($(el).attr("href") ?? "").replace(/^mailto:/i, "").split("?")[0];
    for (const a of raw.split(/[,;]/)) {
      const adr = decodeURIComponent(a).trim().toLowerCase();
      if (giltig(adr)) funna.add(adr);
    }
  });
  // Textnoder skiljs med mellanslag så att "Mejl" och adressen inte limmas ihop till en felaktig adress
  const textnoder: string[] = [];
  $("body *")
    .contents()
    .each((_, n) => {
      if (n.type === "text") textnoder.push((n as { data?: string }).data ?? "");
    });
  const avkodad = avkoda(`${text}\n${textnoder.join(" ")}`);
  for (const m of avkodad.matchAll(/(^|[\s<>("'“”‘’,;:|])([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const adr = m[2].toLowerCase().replace(/^[._-]+|[._-]+$/g, "");
    if (giltig(adr)) funna.add(adr);
  }
  // En adress som bara är en annan med extra tecken framför (t.ex. "ntimo@..." mot "timo@...") är ett hoplimningsfel
  const lista = [...funna];
  return lista.filter((a) => !lista.some((b) => b !== a && a.endsWith(b) && a.length > b.length));
}

export function giltig(adr: string): boolean {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(adr) && !BORT.test(adr) && adr.length < 80;
}

export function klassa(adr: string, sammanhang: string): KontaktTyp {
  if (FUNKTION.test(adr)) return "funktion";
  if (KOMMUNIKATION.test(adr) || KOMMUNIKATION.test(sammanhang)) return "kommunikation";
  if (LEDNING.test(adr) || LEDNING.test(sammanhang)) return "ledning";
  if (/^[a-z]+\.[a-z]+@/.test(adr) || /^[a-z]+@/.test(adr)) return "person";
  return "okand";
}

const PRIORITET: Record<KontaktTyp, number> = { funktion: 1, kommunikation: 2, ledning: 3, person: 4, okand: 5 };
const SIDPRIORITET: Record<string, number> = { kontakt: 0, start: 1, om: 2 };

/** Textomgivning runt adressen, för klassning (till exempel "Ordförande: kalle@..."). */
function sammanhang(text: string, adr: string): string {
  const i = avkoda(text).toLowerCase().indexOf(adr);
  if (i < 0) return "";
  return text.slice(Math.max(0, i - 120), i + adr.length + 40);
}

/**
 * Går igenom hämtade sidor och returnerar adresser i prioritetsordning.
 * Bara adresser på organisationens egen domän eller tydliga funktionsadresser används. Inget gissas.
 */
export function utvinnKontakter(
  doman: string,
  sidor: { roll: string; url: string; html: string; text: string }[],
): Kontakt[] {
  const resultat = new Map<string, Kontakt>();
  const ordnade = [...sidor].sort((a, b) => (SIDPRIORITET[a.roll] ?? 9) - (SIDPRIORITET[b.roll] ?? 9));
  for (const s of ordnade) {
    for (const adr of hittaAdresser(s.html, s.text)) {
      const adrDoman = normaliseraDoman(adr.split("@")[1]);
      const egen = adrDoman === doman || (adrDoman?.endsWith(`.${doman}`) ?? false);
      const typ = klassa(adr, sammanhang(s.text, adr));
      // Adresser på andra domäner (gmail, hotmail) godtas bara om de står på kontakt- eller startsidan
      if (!egen && !["kontakt", "start"].includes(s.roll)) continue;
      const prioritet = PRIORITET[typ] + (egen ? 0 : 3) + (SIDPRIORITET[s.roll] ?? 3) * 0.1;
      const befintlig = resultat.get(adr);
      if (!befintlig || befintlig.prioritet > prioritet) resultat.set(adr, { adress: adr, typ, kallsida: s.url, prioritet });
    }
  }
  return [...resultat.values()].sort((a, b) => a.prioritet - b.prioritet);
}

export function sparaKontakter(d: Db, prospektId: number, kontakter: Kontakt[]): void {
  const ins = d.prepare("INSERT OR REPLACE INTO kontakter (prospekt_id, adress, typ, kallsida, prioritet) VALUES (?, ?, ?, ?, ?)");
  d.transaction(() => {
    // Gamla rader tas bort så att en tidigare felaktig utvinning inte ligger kvar
    d.prepare("DELETE FROM kontakter WHERE prospekt_id = ?").run(prospektId);
    for (const k of kontakter) ins.run(prospektId, k.adress, k.typ, k.kallsida, k.prioritet);
  })();
}

export function bastaKontakt(d: Db, prospektId: number): Kontakt | undefined {
  return d
    .prepare("SELECT adress, typ, kallsida, prioritet FROM kontakter WHERE prospekt_id = ? ORDER BY prioritet LIMIT 1")
    .get(prospektId) as Kontakt | undefined;
}
