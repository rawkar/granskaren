import type { Db } from "./index.js";
import type { ProspektStatus } from "./schema.js";

export interface Prospekt {
  id: number;
  doman: string;
  namn: string | null;
  bransch: string | null;
  ort: string | null;
  organisationstyp: string | null;
  kalla: string;
  kommentar: string | null;
  status: ProspektStatus;
  orsak_hoppad: string | null;
  skapad: string;
  granskad: string | null;
}

export interface Sida {
  id: number;
  prospekt_id: number;
  roll: string;
  url: string;
  slutlig_url: string | null;
  statuskod: number | null;
  html_sokvag: string | null;
  text_sokvag: string | null;
  skarmbild_dator: string | null;
  skarmbild_mobil: string | null;
  svarstid_ms: number | null;
  laddtid_ms: number | null;
  titel: string | null;
  hamtad: string;
}

export interface Matning {
  id: number;
  prospekt_id: number;
  url: string;
  verktyg: string;
  radata: string;
  skapad: string;
}

export interface FyndRad {
  id: number;
  prospekt_id: number;
  fynd_id: string;
  omrade: string;
  tjansteomrade: string;
  rubrik: string;
  observation: string;
  belagg_url: string;
  belagg_typ: string;
  belagg_varde: string;
  effekt: string;
  atgard: string;
  allvar: number;
  sakerhet: number;
  latt_att_forklara: number;
  verifierad: number;
  verifieringsmetod: string | null;
  verifieringsnot: string | null;
  skapad: string;
}

export interface Kostnad {
  prospekt_id: number | null;
  steg: string;
  modell: string;
  tokens_in: number;
  tokens_ut: number;
  tokens_cache_las?: number;
  tokens_cache_skriv?: number;
  kostnad_usd?: number | null;
}

// ---------- prospekt ----------

export function laggTillProspekt(
  d: Db,
  p: {
    doman: string;
    namn?: string | null;
    bransch?: string | null;
    ort?: string | null;
    kalla?: string;
    kommentar?: string | null;
  },
): { id: number; ny: boolean } {
  const befintlig = d.prepare("SELECT id FROM prospekt WHERE doman = ?").get(p.doman) as
    | { id: number }
    | undefined;
  if (befintlig) return { id: befintlig.id, ny: false };
  const r = d
    .prepare(
      "INSERT INTO prospekt (doman, namn, bransch, ort, kalla, kommentar) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(p.doman, p.namn ?? null, p.bransch ?? null, p.ort ?? null, p.kalla ?? "lista", p.kommentar ?? null);
  return { id: Number(r.lastInsertRowid), ny: true };
}

export function hamtaProspekt(d: Db, id: number): Prospekt | undefined {
  return d.prepare("SELECT * FROM prospekt WHERE id = ?").get(id) as Prospekt | undefined;
}

export function hamtaProspektViaDoman(d: Db, doman: string): Prospekt | undefined {
  return d.prepare("SELECT * FROM prospekt WHERE doman = ?").get(doman) as Prospekt | undefined;
}

export function prospektMedStatus(
  d: Db,
  status: ProspektStatus | ProspektStatus[],
  antal?: number,
): Prospekt[] {
  const lista = Array.isArray(status) ? status : [status];
  const platser = lista.map(() => "?").join(",");
  const sql = `SELECT * FROM prospekt WHERE status IN (${platser}) ORDER BY id ${antal ? "LIMIT ?" : ""}`;
  const args: unknown[] = [...lista];
  if (antal) args.push(antal);
  return d.prepare(sql).all(...args) as Prospekt[];
}

export function allaProspekt(d: Db): Prospekt[] {
  return d.prepare("SELECT * FROM prospekt ORDER BY id").all() as Prospekt[];
}

export function sattStatus(d: Db, id: number, status: ProspektStatus, orsak?: string | null): void {
  if (status === "hoppad") {
    d.prepare("UPDATE prospekt SET status = ?, orsak_hoppad = ? WHERE id = ?").run(status, orsak ?? null, id);
  } else if (status === "granskad") {
    d.prepare("UPDATE prospekt SET status = ?, granskad = datetime('now') WHERE id = ?").run(status, id);
  } else {
    d.prepare("UPDATE prospekt SET status = ? WHERE id = ?").run(status, id);
  }
}

export function uppdateraProspekt(
  d: Db,
  id: number,
  falt: Partial<Pick<Prospekt, "namn" | "organisationstyp" | "bransch" | "ort">>,
): void {
  const nycklar = Object.keys(falt) as (keyof typeof falt)[];
  if (nycklar.length === 0) return;
  const set = nycklar.map((k) => `${k} = ?`).join(", ");
  d.prepare(`UPDATE prospekt SET ${set} WHERE id = ?`).run(...nycklar.map((k) => falt[k] ?? null), id);
}

// ---------- sidor ----------

export function sparaSida(d: Db, s: Omit<Sida, "id" | "hamtad">): number {
  const r = d
    .prepare(
      `INSERT INTO sidor (prospekt_id, roll, url, slutlig_url, statuskod, html_sokvag, text_sokvag,
        skarmbild_dator, skarmbild_mobil, svarstid_ms, laddtid_ms, titel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.prospekt_id,
      s.roll,
      s.url,
      s.slutlig_url,
      s.statuskod,
      s.html_sokvag,
      s.text_sokvag,
      s.skarmbild_dator,
      s.skarmbild_mobil,
      s.svarstid_ms,
      s.laddtid_ms,
      s.titel,
    );
  return Number(r.lastInsertRowid);
}

export function sidorForProspekt(d: Db, prospektId: number): Sida[] {
  return d.prepare("SELECT * FROM sidor WHERE prospekt_id = ? ORDER BY id").all(prospektId) as Sida[];
}

export function rensaGranskning(d: Db, prospektId: number): void {
  d.transaction(() => {
    d.prepare("DELETE FROM sidor WHERE prospekt_id = ?").run(prospektId);
    d.prepare("DELETE FROM matningar WHERE prospekt_id = ?").run(prospektId);
    d.prepare("DELETE FROM fynd WHERE prospekt_id = ?").run(prospektId);
    d.prepare("DELETE FROM bra WHERE prospekt_id = ?").run(prospektId);
  })();
}

// ---------- matningar ----------

export function sparaMatning(d: Db, prospektId: number, url: string, verktyg: string, radata: unknown): void {
  d.prepare("INSERT INTO matningar (prospekt_id, url, verktyg, radata) VALUES (?, ?, ?, ?)").run(
    prospektId,
    url,
    verktyg,
    JSON.stringify(radata),
  );
}

export function matningarForProspekt(d: Db, prospektId: number, verktyg?: string): Matning[] {
  if (verktyg) {
    return d
      .prepare("SELECT * FROM matningar WHERE prospekt_id = ? AND verktyg = ? ORDER BY id")
      .all(prospektId, verktyg) as Matning[];
  }
  return d.prepare("SELECT * FROM matningar WHERE prospekt_id = ? ORDER BY id").all(prospektId) as Matning[];
}

// ---------- fynd ----------

export function sparaFynd(
  d: Db,
  f: Omit<FyndRad, "id" | "skapad" | "verifierad" | "verifieringsmetod" | "verifieringsnot">,
): number {
  const r = d
    .prepare(
      `INSERT INTO fynd (prospekt_id, fynd_id, omrade, tjansteomrade, rubrik, observation, belagg_url,
        belagg_typ, belagg_varde, effekt, atgard, allvar, sakerhet, latt_att_forklara)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      f.prospekt_id,
      f.fynd_id,
      f.omrade,
      f.tjansteomrade,
      f.rubrik,
      f.observation,
      f.belagg_url,
      f.belagg_typ,
      f.belagg_varde,
      f.effekt,
      f.atgard,
      f.allvar,
      f.sakerhet,
      f.latt_att_forklara,
    );
  return Number(r.lastInsertRowid);
}

export function sattVerifiering(
  d: Db,
  fyndId: number,
  verifierad: boolean,
  metod: string,
  not: string | null,
): void {
  d.prepare("UPDATE fynd SET verifierad = ?, verifieringsmetod = ?, verifieringsnot = ? WHERE id = ?").run(
    verifierad ? 1 : 0,
    metod,
    not,
    fyndId,
  );
}

export function fyndForProspekt(d: Db, prospektId: number, baraVerifierade = false): FyndRad[] {
  const sql = `SELECT * FROM fynd WHERE prospekt_id = ? ${baraVerifierade ? "AND verifierad = 1" : ""} ORDER BY omrade, id`;
  return d.prepare(sql).all(prospektId) as FyndRad[];
}

export function sparaBra(d: Db, prospektId: number, text: string, url: string | null): void {
  d.prepare("INSERT INTO bra (prospekt_id, text, url) VALUES (?, ?, ?)").run(prospektId, text, url);
}

export function braForProspekt(d: Db, prospektId: number): { text: string; url: string | null }[] {
  return d.prepare("SELECT text, url FROM bra WHERE prospekt_id = ? ORDER BY id").all(prospektId) as {
    text: string;
    url: string | null;
  }[];
}

// ---------- händelser ----------

export function loggaHandelse(d: Db, prospektId: number | null, typ: string, detaljer?: unknown): void {
  d.prepare("INSERT INTO handelser (prospekt_id, typ, detaljer) VALUES (?, ?, ?)").run(
    prospektId,
    typ,
    detaljer === undefined ? null : typeof detaljer === "string" ? detaljer : JSON.stringify(detaljer),
  );
}

// ---------- spärrlista ----------

export function laggTillSparr(d: Db, varde: string, orsak: string): boolean {
  const v = varde.toLowerCase().trim();
  const typ = v.includes("@") ? "adress" : "doman";
  const r = d.prepare("INSERT OR IGNORE INTO sparrlista (varde, typ, orsak) VALUES (?, ?, ?)").run(v, typ, orsak);
  return r.changes > 0;
}

export function arSparrad(d: Db, domanEllerAdress: string): boolean {
  const v = domanEllerAdress.toLowerCase().trim();
  const traff = d.prepare("SELECT 1 FROM sparrlista WHERE varde = ?").get(v);
  if (traff) return true;
  if (v.includes("@")) {
    const dom = v.split("@")[1];
    return !!d.prepare("SELECT 1 FROM sparrlista WHERE varde = ? AND typ = 'doman'").get(dom);
  }
  return false;
}

export function harFattMejl(d: Db, prospektId: number): boolean {
  return !!d
    .prepare("SELECT 1 FROM mejl WHERE prospekt_id = ? AND typ = 'forsta' AND status IN ('skickad', 'koad')")
    .get(prospektId);
}

// ---------- kostnader ----------

export function sparaKostnad(d: Db, k: Kostnad): void {
  d.prepare(
    `INSERT INTO kostnader (prospekt_id, steg, modell, tokens_in, tokens_ut, tokens_cache_las, tokens_cache_skriv, kostnad_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    k.prospekt_id,
    k.steg,
    k.modell,
    k.tokens_in,
    k.tokens_ut,
    k.tokens_cache_las ?? 0,
    k.tokens_cache_skriv ?? 0,
    k.kostnad_usd ?? null,
  );
}

export function kostnadForProspekt(d: Db, prospektId: number): number {
  const r = d
    .prepare("SELECT COALESCE(SUM(kostnad_usd), 0) AS s FROM kostnader WHERE prospekt_id = ?")
    .get(prospektId) as { s: number };
  return r.s;
}
