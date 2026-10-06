/**
 * Databasschema. Varje migrering körs en gång och antecknas i tabellen migreringar.
 * Lägg nya ändringar sist i listan, ändra aldrig en körd migrering.
 */
export const MIGRERINGAR: { namn: string; sql: string }[] = [
  {
    namn: "001_grund",
    sql: `
      CREATE TABLE prospekt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doman TEXT NOT NULL UNIQUE,
        namn TEXT,
        bransch TEXT,
        ort TEXT,
        organisationstyp TEXT,
        kalla TEXT NOT NULL DEFAULT 'lista',
        kommentar TEXT,
        status TEXT NOT NULL DEFAULT 'ny',
        orsak_hoppad TEXT,
        skapad TEXT NOT NULL DEFAULT (datetime('now')),
        granskad TEXT
      );

      CREATE TABLE sidor (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospekt_id INTEGER NOT NULL REFERENCES prospekt(id) ON DELETE CASCADE,
        roll TEXT NOT NULL,
        url TEXT NOT NULL,
        slutlig_url TEXT,
        statuskod INTEGER,
        html_sokvag TEXT,
        text_sokvag TEXT,
        skarmbild_dator TEXT,
        skarmbild_mobil TEXT,
        svarstid_ms INTEGER,
        laddtid_ms INTEGER,
        titel TEXT,
        hamtad TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX sidor_prospekt ON sidor(prospekt_id);

      CREATE TABLE matningar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospekt_id INTEGER NOT NULL REFERENCES prospekt(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        verktyg TEXT NOT NULL,
        radata TEXT NOT NULL,
        skapad TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX matningar_prospekt ON matningar(prospekt_id);

      CREATE TABLE fynd (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospekt_id INTEGER NOT NULL REFERENCES prospekt(id) ON DELETE CASCADE,
        fynd_id TEXT NOT NULL,
        omrade TEXT NOT NULL,
        tjansteomrade TEXT NOT NULL,
        rubrik TEXT NOT NULL,
        observation TEXT NOT NULL,
        belagg_url TEXT NOT NULL,
        belagg_typ TEXT NOT NULL,
        belagg_varde TEXT NOT NULL,
        effekt TEXT NOT NULL,
        atgard TEXT NOT NULL,
        allvar INTEGER NOT NULL,
        sakerhet REAL NOT NULL,
        latt_att_forklara INTEGER NOT NULL,
        verifierad INTEGER NOT NULL DEFAULT 0,
        verifieringsmetod TEXT,
        verifieringsnot TEXT,
        skapad TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX fynd_prospekt ON fynd(prospekt_id);

      CREATE TABLE bra (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospekt_id INTEGER NOT NULL REFERENCES prospekt(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        url TEXT
      );

      CREATE TABLE kontakter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospekt_id INTEGER NOT NULL REFERENCES prospekt(id) ON DELETE CASCADE,
        adress TEXT NOT NULL,
        typ TEXT NOT NULL,
        kallsida TEXT NOT NULL,
        prioritet INTEGER NOT NULL DEFAULT 99,
        skapad TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(prospekt_id, adress)
      );

      CREATE TABLE mejl (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospekt_id INTEGER NOT NULL REFERENCES prospekt(id) ON DELETE CASCADE,
        typ TEXT NOT NULL CHECK (typ IN ('forsta', 'uppfoljning')),
        mottagare TEXT,
        amne TEXT NOT NULL,
        text TEXT NOT NULL,
        anvanda_fynd TEXT NOT NULL,
        sakerhet REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'utkast',
        message_id TEXT,
        in_reply_to TEXT,
        skapad TEXT NOT NULL DEFAULT (datetime('now')),
        skickad TEXT
      );
      -- En domän får aldrig mer än ett förstamejl. Detta garanteras av databasen.
      CREATE UNIQUE INDEX mejl_ett_forstamejl ON mejl(prospekt_id) WHERE typ = 'forsta';
      CREATE UNIQUE INDEX mejl_en_uppfoljning ON mejl(prospekt_id) WHERE typ = 'uppfoljning';

      CREATE TABLE handelser (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospekt_id INTEGER REFERENCES prospekt(id) ON DELETE CASCADE,
        typ TEXT NOT NULL,
        detaljer TEXT,
        tidpunkt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX handelser_prospekt ON handelser(prospekt_id);

      CREATE TABLE sparrlista (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        varde TEXT NOT NULL UNIQUE,
        typ TEXT NOT NULL CHECK (typ IN ('doman', 'adress')),
        orsak TEXT,
        tillagd TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE kostnader (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospekt_id INTEGER REFERENCES prospekt(id) ON DELETE SET NULL,
        steg TEXT NOT NULL,
        modell TEXT NOT NULL,
        tokens_in INTEGER NOT NULL,
        tokens_ut INTEGER NOT NULL,
        tokens_cache_las INTEGER NOT NULL DEFAULT 0,
        tokens_cache_skriv INTEGER NOT NULL DEFAULT 0,
        kostnad_usd REAL,
        tidpunkt TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    namn: "002_profil_huvudinsikt_djup",
    sql: `
      ALTER TABLE prospekt ADD COLUMN profil TEXT;
      ALTER TABLE prospekt ADD COLUMN huvudinsikt TEXT;
      ALTER TABLE fynd ADD COLUMN djup INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE fynd ADD COLUMN insikt TEXT;
      ALTER TABLE fynd ADD COLUMN rotorsak TEXT;
      ALTER TABLE fynd ADD COLUMN forslag_konkret TEXT;
      ALTER TABLE fynd ADD COLUMN insats TEXT;
      ALTER TABLE fynd ADD COLUMN kopplar_till_syfte INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE fynd ADD COLUMN belagg2_url TEXT;
      ALTER TABLE fynd ADD COLUMN belagg2_typ TEXT;
      ALTER TABLE fynd ADD COLUMN belagg2_varde TEXT;
    `,
  },
  {
    namn: "003_kundtyp_forebilder_segment",
    sql: `
      ALTER TABLE prospekt ADD COLUMN kundtyp INTEGER;
      ALTER TABLE prospekt ADD COLUMN likhet REAL;

      CREATE TABLE likhetsprofil (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doman TEXT NOT NULL UNIQUE,
        beskrivning TEXT,
        kundtyp INTEGER NOT NULL,
        yrke TEXT,
        ort TEXT,
        profil TEXT NOT NULL,
        skapad TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE segment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kundtyp INTEGER NOT NULL,
        yrke TEXT NOT NULL,
        ort TEXT NOT NULL,
        sokfras TEXT NOT NULL,
        motivering TEXT,
        anvand INTEGER NOT NULL DEFAULT 0,
        traffar INTEGER NOT NULL DEFAULT 0,
        skapad TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(kundtyp, yrke, ort)
      );

      CREATE TABLE kandidater (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doman TEXT NOT NULL UNIQUE,
        namn TEXT,
        kalla TEXT NOT NULL,
        segment_id INTEGER REFERENCES segment(id) ON DELETE SET NULL,
        kundtyp INTEGER,
        likhet REAL,
        utfall TEXT NOT NULL,
        orsak TEXT,
        skapad TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE installningar (
        nyckel TEXT PRIMARY KEY,
        varde TEXT NOT NULL,
        andrad TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
];

export const PROSPEKT_STATUS = [
  "ny",
  "kvalificerad",
  "hoppad",
  "granskad",
  "utkast",
  "i_granskning",
  "koad",
  "skickad",
  "svar",
  "studs",
  "sparrad",
] as const;
export type ProspektStatus = (typeof PROSPEKT_STATUS)[number];
