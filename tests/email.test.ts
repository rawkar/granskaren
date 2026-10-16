import { describe, expect, it } from "vitest";
import { avkoda, hittaAdresser, utvinnKontakter } from "../src/email/kontakter.js";
import { valjFynd } from "../src/email/val.js";
import { antalOrd, byggAmne, sprakfel, tillaggsfel } from "../src/email/grind.js";
import { flerFyndText, langdText } from "../src/email/utkast.js";

describe("tillägg till mejlprompten", () => {
  it("är tomma när inställningarna är standard", () => {
    expect(langdText(0, 190)).toBe("");
    expect(flerFyndText(null)).toBe("");
  });
  it("anger ordmål och gräns", () => {
    expect(langdText(150, 190)).toContain("Sikta på 150 ord");
    expect(langdText(150, 190)).toContain("110 till 190");
    expect(langdText(0, 210)).toContain("Sikta på 160 ord");
  });
  it("säger att programmet skriver meningen om fler fynd när inställningen är på", () => {
    expect(flerFyndText(2)).toContain("programmet självt");
    expect(flerFyndText(0)).toContain("Skriv inte att Rawaz såg fler saker");
  });
});
import type { FyndRad } from "../src/db/fragor.js";

describe("adressutvinning", () => {
  it("avkodar vanliga förvrängningar", () => {
    expect(avkoda("info [at] exempel [dot] se")).toBe("info@exempel.se");
    expect(avkoda("kansli (a) exempel.se")).toBe("kansli@exempel.se");
    expect(avkoda("ordforande {snabel-a} exempel.se")).toBe("ordforande@exempel.se");
  });
  it("hittar mailto och text, hoppar över skräp", () => {
    const html = `<a href="mailto:Info@Exempel.se?subject=Hej">Mejla</a><p>Ordförande: kalle.k [at] exempel.se</p><img src="bild@2x.png"><a href="mailto:noreply@exempel.se">x</a>`;
    const adr = hittaAdresser(html, "Ordförande: kalle.k [at] exempel.se");
    expect(adr).toContain("info@exempel.se");
    expect(adr).toContain("kalle.k@exempel.se");
    expect(adr).not.toContain("noreply@exempel.se");
    expect(adr.some((a) => a.endsWith(".png"))).toBe(false);
  });
  it("limmar inte ihop text före adressen och tar bort hoplimmade varianter", () => {
    const html = `<p>Mejl</p><p>timo.westergard@hotmail.com</p><div><span>Kontakt</span><span>info@exempel.se</span></div>`;
    const adr = hittaAdresser(html, "Mejl\ntimo.westergard@hotmail.com\nKontaktinfo@exempel.se");
    expect(adr).toContain("timo.westergard@hotmail.com");
    expect(adr).toContain("info@exempel.se");
    expect(adr).not.toContain("mejltimo.westergard@hotmail.com");
    expect(adr).not.toContain("kontaktinfo@exempel.se");
  });
  it("prioriterar funktionsadress före person och egen domän före gmail", () => {
    const k = utvinnKontakter("exempel.se", [
      { roll: "om", url: "https://exempel.se/om", html: '<a href="mailto:anna.b@exempel.se">Anna</a>', text: "Anna" },
      { roll: "kontakt", url: "https://exempel.se/kontakt", html: '<a href="mailto:styrelsen.exempel@gmail.com">x</a> <a href="mailto:info@exempel.se">info</a>', text: "" },
    ]);
    expect(k[0].adress).toBe("info@exempel.se");
    expect(k[0].typ).toBe("funktion");
    expect(k[0].kallsida).toBe("https://exempel.se/kontakt");
    expect(k.map((x) => x.adress)).toContain("anna.b@exempel.se");
    expect(k[k.length - 1].adress).toBe("styrelsen.exempel@gmail.com");
  });
  it("tar inte gmail-adresser från undersidor", () => {
    const k = utvinnKontakter("exempel.se", [
      { roll: "nyhet", url: "https://exempel.se/nyhet", html: '<a href="mailto:nagon@gmail.com">x</a>', text: "" },
    ]);
    expect(k).toHaveLength(0);
  });
});

function fynd(delar: Partial<FyndRad>): FyndRad {
  return {
    id: 0, prospekt_id: 1, fynd_id: "f", omrade: "D", tjansteomrade: "webb", rubrik: "r", observation: "o",
    belagg_url: "https://exempel.se/", belagg_typ: "saknat_element", belagg_varde: "h1", effekt: "e", atgard: "a",
    allvar: 2, sakerhet: 0.9, latt_att_forklara: 2, verifierad: 1, verifieringsmetod: "kod", verifieringsnot: null, skapad: "",
    djup: 2, insikt: "i", rotorsak: null, forslag_konkret: null, insats: "liten", kopplar_till_syfte: 1,
    belagg2_url: null, belagg2_typ: null, belagg2_varde: null, galler_inte: null,
    ...delar,
  };
}

describe("val av fynd", () => {
  it("ger inget mejl med färre än två bekräftade fynd", () => {
    expect(valjFynd([fynd({ fynd_id: "a" }), fynd({ fynd_id: "b", verifierad: 0 })]).orsak).toBe("bara 1 bekräftat fynd, minst två krävs");
    expect(valjFynd([]).orsak).toBe("bara 0 bekräftat fynd, minst två krävs");
  });
  it("tar aldrig med obekräftade fynd och räknar samma område och sida som ett", () => {
    const v = valjFynd([
      fynd({ fynd_id: "a", omrade: "A", belagg_url: "https://exempel.se/" }),
      fynd({ fynd_id: "a2", omrade: "A", belagg_url: "https://exempel.se/" }),
      fynd({ fynd_id: "b", omrade: "H", belagg_url: "https://exempel.se/kontakt" }),
      fynd({ fynd_id: "c", omrade: "D", verifierad: 0 }),
    ]);
    expect(v.orsak).toBeNull();
    expect(v.fynd.map((f) => f.fynd_id)).toEqual(["a", "b"]);
  });
  it("väljer högst allvar först, högst tre, och en knapptext sist vid lika allvar", () => {
    const v = valjFynd([
      fynd({ id: 1, fynd_id: "knapp", omrade: "H", allvar: 2, rubrik: "Knappen heter Läs mer", belagg_url: "https://exempel.se/" }),
      fynd({ id: 2, fynd_id: "titel", omrade: "D", allvar: 1, belagg_url: "https://exempel.se/" }),
      fynd({ id: 3, fynd_id: "priser", omrade: "A", allvar: 2, belagg_url: "https://exempel.se/tjanster" }),
      fynd({ id: 4, fynd_id: "formular", omrade: "G", allvar: 3, belagg_url: "https://exempel.se/kontakt" }),
    ]);
    expect(v.orsak).toBeNull();
    expect(v.fynd.map((f) => f.fynd_id)).toEqual(["formular", "priser", "knapp"]);
    expect(v.huvud?.fynd_id).toBe("formular");
  });
});

describe("språkregler i kvalitetsgrinden", () => {
  const ok = `Hej,

Jag heter Rawaz Karim och arbetar som kommunikationskonsult. Jag har gått igenom er webbplats och ser en byrå som gör genomarbetade identiteter åt lokala företag, men sajten berättar det sämre än arbetet förtjänar.

Era sex kundcase visar vad ni har gjort men aldrig vad kunden fick ut av det. Den som väljer mellan er och en annan byrå letar efter just det, och ett par meningar om resultatet i varje case skulle göra stor skillnad för hur ni uppfattas.

Samma sak syns i sök. Startsidans titel börjar med ordet Start, så Google får ingen hjälp att förstå vad ni erbjuder. Ett exempel på hur den skulle kunna lyda

Grafisk identitet och webb för företag i Västerås | Exempelbyrån

Kontaktformuläret har dessutom nio fält, vilket brukar få en del att ge upp på vägen. Namn, mejl och en rad om uppdraget räcker för ett första samtal och ni kan alltid fråga mer senare.

Jag hjälper gärna till med detta. Mer om vad jag gör finns på rkkommunikation.se. Svara gärna på det här mejlet om ni vill boka ett första möte, så hittar vi en tid som passar er.

Vänliga hälsningar`;

  const fyndOk = [
    fynd({ fynd_id: "case", djup: 3, observation: "Sex kundcase visar vad som gjordes men inte resultatet." }),
    fynd({ fynd_id: "titel", djup: 1, forslag_konkret: "Grafisk identitet och webb för företag i Västerås | Exempelbyrån" }),
    fynd({ fynd_id: "formular", djup: 2, observation: "Kontaktformuläret har 9 fält.", belagg_varde: "matt.formular_1_falt=9" }),
  ];

  it("godkänner ett korrekt mejl", () => {
    expect(antalOrd(ok)).toBeGreaterThanOrEqual(110);
    expect(antalOrd(ok)).toBeLessThanOrEqual(190);
    expect(sprakfel("Era case på exempelbyran.se säljer er under värde", ok, "")).toEqual([]);
    expect(tillaggsfel(ok, fyndOk)).toEqual([]);
  });
  it("stoppar tankstreck, kolon, utropstecken, längd och ämnesrad", () => {
    expect(sprakfel("Hej exempel.se", ok.replace("det, och", "det – och"), "")).toContain("innehåller tankstreck");
    expect(sprakfel("Hej: exempel.se", ok, "")).toContain("ämnesraden innehåller kolon");
    expect(sprakfel("Hej exempel.se", `${ok}\nTack!`, "")).toContain("innehåller utropstecken");
    expect(sprakfel("Hej exempel.se", "Kort text. rkkommunikation.se", "")[0]).toMatch(/ord, ska vara 110 till 190/);
    expect(sprakfel("Hej exempel.se", "Kort text. rkkommunikation.se", "", undefined, [], 210)[0]).toMatch(/ord, ska vara 110 till 210/);
    expect(sprakfel("Hej exempel.se", ok, "", undefined, [], antalOrd(ok) - 1)).toContainEqual(expect.stringMatching(/ska vara 110 till/));
    expect(sprakfel("Hej exempel.se", ok, "", undefined, [], antalOrd(ok))).toEqual([]);
    expect(sprakfel("En alldeles för lång ämnesrad som går långt över femtio tecken exempel.se", ok, "")).toContain(
      "ämnesraden är 73 tecken, högst 60",
    );
    expect(sprakfel("TRE SAKER PÅ EXEMPEL.SE", ok, "")).toContain("ämnesraden är skriven med versaler");
  });
  it("stoppar främmande länkar, du-tilltal, punktlistor, AI och påståendet att mätning saknas", () => {
    expect(sprakfel("Hej exempel.se", ok.replace("rkkommunikation.se", "rkkommunikation.se och https://annan.se/sida"), "")).toContain(
      "otillåten länk: https://annan.se/sida",
    );
    expect(sprakfel("Hej exempel.se", ok.replace("er webbplats", "din webbplats och dina sidor"), "", "ni")).toContain("tilltalar med du i stället för ni");
    expect(sprakfel("Hej exempel.se", ok.replace("er webbplats", "din webbplats och dina sidor"), "")).not.toContain("tilltalar med du i stället för ni");
    expect(sprakfel("Hej exempel.se", ok, "", "du")).toContain("tilltalar med ni i stället för du");
    const duText = ok.replace(/\b(ni|er|era)\b/gi, "du").replace("Hej,", "Hej Anna,").replace("byrå som gör", "byrå med vana från reklambyråer som gör");
    expect(sprakfel("Hej exempel.se", duText, "", "du")).not.toContain("tilltalar med ni i stället för du");
    expect(sprakfel("Hej exempel.se", ok, "", "du")).toContain("hälsar inte med förnamn");
    expect(sprakfel("Hej exempel.se", ok.replace("Era sex kundcase", "Era sex kundcase har rubriker som kunde stå var som helst och"), "")).toContainEqual(expect.stringMatching(/kritiserar mottagarens formulering/));
    expect(sprakfel("Hej exempel.se", ok.replace("Era sex kundcase", "- Era sex kundcase"), "")).toContain("innehåller punktlista");
    expect(sprakfel("Hej exempel.se", ok.replace("Jag har gått igenom", "Med hjälp av AI har jag gått igenom"), "")).toContain("nämner AI");
    expect(sprakfel("Hej exempel.se", ok.replace("Samma sak syns i sök.", "Dessutom saknar sajten mätning."), "")).toContain(
      "påstår att mätning saknas, ska vara att inget mätverktyg syns",
    );
  });
  it("tillåter bokningslänken när den är konfigurerad", () => {
    const text = ok.replace("så hittar vi en tid som passar er.", "eller boka direkt på cal.com/rawaz.");
    expect(sprakfel("Hej exempel.se", text, "")).toContain("otillåten länk: cal.com/rawaz");
    expect(sprakfel("Hej exempel.se", text, "https://cal.com/rawaz")).toEqual([]);
  });
  it("kräver förslaget på egen rad bara när något fynd har ett, och siffror ur fynden", () => {
    expect(tillaggsfel(ok, fyndOk.map((f) => ({ ...f, forslag_konkret: null })))).toEqual([]);
    expect(tillaggsfel(ok.replace("\n\nGrafisk identitet och webb för företag i Västerås | Exempelbyrån\n\n", " "), fyndOk)).toContain(
      "det konkreta förslaget står inte ordagrant på en egen rad",
    );
    expect(tillaggsfel(ok.replace("nio fält", "12 fält"), fyndOk)).toContain("siffran 12 finns inte i fynden");
    expect(tillaggsfel(ok.replace("nio fält", "9 fält"), fyndOk)).toEqual([]);
    // Meningen om fler fynd får bara finnas när det finns fler bekräftade fynd
    const medFler = ok.replace("Jag hjälper gärna", "Jag såg fler saker som går att förbättra på sajten och dem berättar jag gärna om i ett samtal. Jag hjälper gärna");
    expect(tillaggsfel(medFler, fyndOk, 0)).toContainEqual(expect.stringMatching(/påstår att det finns fler saker/));
    expect(tillaggsfel(medFler, fyndOk, 2)).toContainEqual(expect.stringMatching(/skriver själv att det finns fler saker/));
    expect(tillaggsfel(medFler, fyndOk)).toEqual([]);
    expect(tillaggsfel(ok, fyndOk, 0)).toEqual([]);
  });
});

describe("ämnesrad från mall", () => {
  it("fyller i domänen utan www och byter till namnet över 60 tecken", () => {
    expect(byggAmne("Några förslag för {domän}", "www.exempel.se", "Exempel AB")).toBe("Några förslag för exempel.se");
    expect(byggAmne("Några förslag för {domän}", "https://exempel.se/", null)).toBe("Några förslag för exempel.se");
    const lang = "en-valdigt-lang-domän-som-foreningen-har-registrerat-for-sig.se";
    expect(byggAmne("Några förslag för {domän}", lang, "Föreningen")).toBe("Några förslag för Föreningen");
    expect(byggAmne("Tre idéer till {namn}", "exempel.se", null)).toBe("Tre idéer till exempel.se");
  });
});

describe("tilltalskontrollen och organisationens namn", () => {
  const ni = "Hej,\n\nJag har gått igenom er webbplats. Högst upp står \"Välkommen till Din Veterinär i Enköping\" och Din Veterinär i Enköping tar emot hund och katt. Mer på rkkommunikation.se.";
  it("räknar inte Din i ett citat eller i organisationens namn som du-tilltal", () => {
    const fel = sprakfel("Några förslag", ni, "", "ni", [], 190, "Din Veterinär i Enköping");
    expect(fel.filter((f) => /tilltalar/.test(f))).toEqual([]);
  });
  it("räknar fortfarande ett riktigt du-tilltal", () => {
    const fel = sprakfel("Några förslag", `${ni} Du får gärna svara.`, "", "ni", [], 190, "Din Veterinär i Enköping");
    expect(fel).toContain("tilltalar med du i stället för ni");
  });
});
