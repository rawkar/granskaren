import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { konfig, type Konfig } from "../config.js";
import type { Db } from "../db/index.js";
import { arSparrad, hamtaProspekt, loggaHandelse, sattStatus } from "../db/fragor.js";
import { dataMapp, filnamnSaker } from "../util/fil.js";
import { logg, paus } from "../util/logg.js";

export interface MejlRad {
  id: number;
  prospekt_id: number;
  typ: "forsta" | "uppfoljning";
  mottagare: string | null;
  amne: string;
  text: string;
  anvanda_fynd: string;
  sakerhet: number;
  status: string;
  message_id: string | null;
  in_reply_to: string | null;
}

// ---------- rena funktioner som testas utan nätverk ----------

export function arVardag(d: Date): boolean {
  const dag = d.getDay();
  return dag >= 1 && dag <= 5;
}

/** Är klockslaget inom fönstret start till slut (lokal tid)? */
export function inomFonster(d: Date, start: string, slut: string): boolean {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = slut.split(":").map(Number);
  const nu = d.getHours() * 60 + d.getMinutes();
  return nu >= sh * 60 + sm && nu <= eh * 60 + em;
}

export function skickadeIdag(d: Db, nu = new Date()): number {
  const dag = lokaltDatum(nu);
  return (d.prepare("SELECT COUNT(*) AS n FROM mejl WHERE status = 'skickad' AND substr(skickad, 1, 10) = ?").get(dag) as { n: number }).n;
}

export function lokaltDatum(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function lokalTid(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${lokaltDatum(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Slumpad paus mellan mejl, mellan PAUS_MIN_MINUTER och PAUS_MAX_MINUTER (standard 4 till 15). */
export function slumpadPausMs(): number {
  const k = konfig();
  const min = Math.max(1, k.PAUS_MIN_MINUTER);
  const max = Math.max(min, k.PAUS_MAX_MINUTER);
  return (min + Math.random() * (max - min)) * 60 * 1000;
}

export function nyttMessageId(avsandare: string): string {
  const doman = avsandare.split("@")[1] || "rkkommunikation.se";
  return `<granskaren.${Date.now()}.${crypto.randomBytes(6).toString("hex")}@${doman}>`;
}

/** Varför ett mejl inte får skickas just nu, eller null om det är fritt fram. */
export function hinder(d: Db, k: Konfig, m: MejlRad, nu = new Date()): string | null {
  if (!m.mottagare) return "mottagare saknas";
  if (arSparrad(d, m.mottagare)) return "mottagaren finns på spärrlistan";
  const p = hamtaProspekt(d, m.prospekt_id);
  if (!p) return "prospektet saknas";
  if (arSparrad(d, p.doman)) return "domänen finns på spärrlistan";
  if (m.typ === "forsta") {
    const redan = d.prepare("SELECT 1 FROM mejl WHERE prospekt_id = ? AND typ = 'forsta' AND status = 'skickad' AND id != ?").get(m.prospekt_id, m.id);
    if (redan) return "domänen har redan fått ett förstamejl";
  }
  if (!arVardag(nu)) return "inte en vardag";
  if (!inomFonster(nu, k.SANDFONSTER_START, k.SANDFONSTER_SLUT)) return `utanför sändfönstret ${k.SANDFONSTER_START} till ${k.SANDFONSTER_SLUT}`;
  if (skickadeIdag(d, nu) >= k.MAX_MEJL_PER_DAG) return `dagens tak på ${k.MAX_MEJL_PER_DAG} mejl är nått`;
  return null;
}

// ---------- transport ----------

export function skapaTransport(k: Konfig) {
  if (!k.SMTP_HOST || !k.SMTP_USER || !k.SMTP_PASS) throw new Error("SMTP_HOST, SMTP_USER och SMTP_PASS måste vara satta i .env.");
  return nodemailer.createTransport({
    host: k.SMTP_HOST,
    port: k.SMTP_PORT,
    secure: k.SMTP_PORT === 465,
    auth: { user: k.SMTP_USER, pass: k.SMTP_PASS },
  });
}

interface Brev {
  till: string;
  amne: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
}

/** Skickar ett rent textmejl utan spårning. Returnerar Message-ID som servern accepterade. */
export async function skickaBrev(k: Konfig, b: Brev): Promise<string> {
  const transport = skapaTransport(k);
  const fran = k.AVSANDARE_EPOST || k.SMTP_USER;
  const info = await transport.sendMail({
    from: { name: k.AVSANDARE_NAMN, address: fran },
    to: b.till,
    subject: b.amne,
    text: b.text,
    messageId: b.messageId,
    ...(b.inReplyTo ? { inReplyTo: b.inReplyTo, references: b.inReplyTo } : {}),
    headers: { "X-Mailer": "granskaren" },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return info.messageId || b.messageId;
}

/** Vid torrkörning skrivs mejlet till data/torrkorning/ i stället för att skickas. */
export function skrivTorrkorning(b: Brev, doman: string): string {
  const fil = path.join(dataMapp("torrkorning"), `${lokalTid(new Date()).replace(/[: ]/g, "-")}_${filnamnSaker(doman)}.eml`);
  const k = konfig();
  const innehall = [
    `From: ${k.AVSANDARE_NAMN} <${k.AVSANDARE_EPOST || k.SMTP_USER}>`,
    `To: ${b.till}`,
    `Subject: ${b.amne}`,
    `Message-ID: ${b.messageId}`,
    b.inReplyTo ? `In-Reply-To: ${b.inReplyTo}` : null,
    `Date: ${new Date().toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    b.text,
  ]
    .filter((r) => r !== null)
    .join("\n");
  fs.writeFileSync(fil, innehall, "utf8");
  return fil;
}

/** Varje skarpt skickat mejl sparas som fil i data/skickade/ så att det går att läsa i efterhand. */
export function skrivKopia(b: Brev, doman: string, tid: string): string {
  const k = konfig();
  const fil = path.join(dataMapp("skickade"), `${tid.replace(/[: ]/g, "-")}_${filnamnSaker(doman)}.txt`);
  fs.writeFileSync(
    fil,
    [`Från: ${k.AVSANDARE_NAMN} <${k.AVSANDARE_EPOST || k.SMTP_USER}>`, `Till: ${b.till}`, `Skickat: ${tid}`, `Message-ID: ${b.messageId}`, `Ämne: ${b.amne}`, "", b.text].join("\n"),
    "utf8",
  );
  return fil;
}

export interface SkickatMejl {
  id: number;
  doman: string;
  namn: string | null;
  mottagare: string | null;
  amne: string;
  text: string;
  skickad: string | null;
  message_id: string | null;
  typ: string;
}

/** Alla skarpt skickade mejl, senaste först. */
export function skickadeMejl(d: Db, doman?: string): SkickatMejl[] {
  const sql = `SELECT m.id, p.doman, p.namn, m.mottagare, m.amne, m.text, m.skickad, m.message_id, m.typ
               FROM mejl m JOIN prospekt p ON p.id = m.prospekt_id
               WHERE m.status = 'skickad' ${doman ? "AND p.doman = ?" : ""} ORDER BY m.skickad DESC`;
  return (doman ? d.prepare(sql).all(doman) : d.prepare(sql).all()) as SkickatMejl[];
}

// ---------- utskick ----------

export interface SandAlternativ {
  max?: number; // högsta antal att skicka i den här körningen
  pausMs?: () => number; // för tester
}

/** Skickar ett enskilt köat mejl, eller skriver det till torrkörning. Förutsätter att hinder() är kontrollerad. */
export async function skickaEtt(d: Db, m: MejlRad): Promise<"skickad" | "torrkord" | "stoppad"> {
  const k = konfig();
  const p = hamtaProspekt(d, m.prospekt_id);
  const messageId = m.message_id ?? nyttMessageId(k.AVSANDARE_EPOST || k.SMTP_USER);
  const brev: Brev = { till: m.mottagare!, amne: m.amne, text: m.text, messageId, inReplyTo: m.in_reply_to };
  if (k.TORRKORNING) {
    const fil = skrivTorrkorning(brev, p?.doman ?? String(m.prospekt_id));
    d.prepare("UPDATE mejl SET status = 'torrkord', message_id = ?, skickad = ? WHERE id = ?").run(messageId, lokalTid(new Date()), m.id);
    loggaHandelse(d, m.prospekt_id, "torrkorning", { fil, mottagare: m.mottagare });
    logg.info(`   torrkörning: ${p?.doman} -> ${fil}`);
    return "torrkord";
  }
  // Spärrlistan kontrolleras i samma ögonblick som mejlet skickas
  if (arSparrad(d, m.mottagare!) || (p && arSparrad(d, p.doman))) return "stoppad";
  const id = await skickaBrev(k, brev);
  const tid = lokalTid(new Date());
  d.prepare("UPDATE mejl SET status = 'skickad', message_id = ?, skickad = ? WHERE id = ?").run(id, tid, m.id);
  sattStatus(d, m.prospekt_id, "skickad");
  const kopia = skrivKopia({ ...brev, messageId: id }, p?.doman ?? String(m.prospekt_id), tid);
  loggaHandelse(d, m.prospekt_id, "skickat", { mottagare: m.mottagare, message_id: id, amne: m.amne, fynd: JSON.parse(m.anvanda_fynd), kopia });
  logg.info(`   skickat till ${m.mottagare} (${p?.doman}), Message-ID ${id}`);
  return "skickad";
}

/** Nästa köade mejl, eller undefined. */
export function nastaKoade(d: Db): MejlRad | undefined {
  return d.prepare("SELECT * FROM mejl WHERE status = 'koad' ORDER BY id LIMIT 1").get() as MejlRad | undefined;
}

/** Skickar köade mejl inom tidsfönster och dagligt tak, med slumpad paus mellan. */
export async function skickaKoade(d: Db, alt: SandAlternativ = {}): Promise<{ skickade: number; torrkorda: number; stoppade: number }> {
  const k = konfig();
  const ko = d.prepare("SELECT * FROM mejl WHERE status = 'koad' ORDER BY id").all() as MejlRad[];
  const res = { skickade: 0, torrkorda: 0, stoppade: 0 };
  if (ko.length === 0) {
    logg.info("Inga köade mejl.");
    return res;
  }
  logg.info(`${ko.length} köade mejl. Torrkörning: ${k.TORRKORNING ? "PÅ" : "av"}. Läge: ${k.SANDLAGE}.`);
  let antal = 0;
  for (const m of ko) {
    if (alt.max && antal >= alt.max) break;
    const p = hamtaProspekt(d, m.prospekt_id);
    const stopp = hinder(d, k, m);
    if (stopp) {
      res.stoppade++;
      logg.info(`   ${p?.doman ?? m.prospekt_id}: ${stopp}`);
      if (/fönstret|vardag|tak/.test(stopp)) break; // tidsregler stoppar hela körningen
      continue;
    }
    if (antal > 0) {
      const ms = (alt.pausMs ?? slumpadPausMs)();
      logg.info(`   pausar ${Math.round(ms / 60000)} minuter`);
      await paus(ms);
      if (hinder(d, k, m)) continue; // kontrollera igen efter pausen
    }
    const utfall = await skickaEtt(d, m);
    if (utfall === "skickad") res.skickade++;
    else if (utfall === "torrkord") res.torrkorda++;
    else {
      res.stoppade++;
      continue;
    }
    antal++;
  }
  return res;
}

/**
 * Skickar ett utkast som test till en egen adress. Går runt torrkörning, fönster och tak,
 * men rör inte utkastets status så att det riktiga mejlet fortfarande kan skickas senare.
 */
export async function skickaTest(d: Db, mejlId: number, till: string): Promise<string> {
  const k = konfig();
  const m = d.prepare("SELECT * FROM mejl WHERE id = ?").get(mejlId) as MejlRad | undefined;
  if (!m) throw new Error(`Mejl ${mejlId} finns inte.`);
  const p = hamtaProspekt(d, m.prospekt_id);
  const messageId = nyttMessageId(k.AVSANDARE_EPOST || k.SMTP_USER);
  const id = await skickaBrev(k, { till, amne: m.amne, text: m.text, messageId });
  loggaHandelse(d, m.prospekt_id, "testmejl_skickat", { till, message_id: id, mejl_id: m.id });
  logg.info(`Testmejl för ${p?.doman} skickat till ${till}, Message-ID ${id}`);
  return id;
}
