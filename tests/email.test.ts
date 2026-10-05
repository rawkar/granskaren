import { describe, expect, it } from "vitest";
import { avkoda, hittaAdresser, utvinnKontakter } from "../src/email/kontakter.js";
import { valjFynd } from "../src/email/val.js";
import { antalOrd, sprakfel } from "../src/email/grind.js";
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
    ...delar,
  };
}

describe("val av fynd", () => {
  it("tar aldrig med obekräftade fynd", () => {
    const v = valjFynd([
      fynd({ fynd_id: "a", verifierad: 0, allvar: 3, latt_att_forklara: 3 }),
      fynd({ fynd_id: "b", verifierad: 1 }),
      fynd({ fynd_id: "c", verifierad: 1, belagg_url: "https://exempel.se/kontakt" }),
    ]);
    expect(v.map((f) => f.fynd_id)).not.toContain("a");
    expect(v).toHaveLength(2);
  });
  it("ger tom lista vid färre än två bekräftade", () => {
    expect(valjFynd([fynd({ verifierad: 1 }), fynd({ verifierad: 0 })])).toEqual([]);
    expect(valjFynd([fynd({ sakerhet: 0.5 }), fynd({ sakerhet: 0.9 })])).toEqual([]);
  });
  it("prioriterar ett mänskligt fynd och spridning över tjänsteområden", () => {
    const v = valjFynd([
      fynd({ fynd_id: "seo1", omrade: "D", tjansteomrade: "webb", allvar: 3, latt_att_forklara: 3 }),
      fynd({ fynd_id: "seo2", omrade: "D", tjansteomrade: "webb", allvar: 3, latt_att_forklara: 3, belagg_url: "https://exempel.se/om" }),
      fynd({ fynd_id: "seo3", omrade: "E", tjansteomrade: "webb", allvar: 3, latt_att_forklara: 3 }),
      fynd({ fynd_id: "budskap", omrade: "A", tjansteomrade: "strategi", allvar: 1, latt_att_forklara: 1, sakerhet: 0.75 }),
      fynd({ fynd_id: "matning", omrade: "I", tjansteomrade: "analys", allvar: 1, latt_att_forklara: 1 }),
    ]);
    const ids = v.map((f) => f.fynd_id);
    expect(ids).toContain("budskap");
    expect(ids).toContain("seo1");
    expect(v).toHaveLength(3);
    expect(new Set(v.map((f) => f.tjansteomrade)).size).toBeGreaterThanOrEqual(2);
  });
});

describe("språkregler i kvalitetsgrinden", () => {
  const ok = `Hej,

Jag heter Rawaz Karim och arbetar som kommunikationskonsult med föreningar och mindre organisationer. Jag har tittat på er webbplats och fastnade för tre saker som jag tror skulle göra skillnad för er.

Startsidan berättar inte vad ni gör förrän en bit ner på sidan. En mening högst upp om vilka ni är och vem ni finns till för gör att fler besökare stannar kvar och förstår vad ni erbjuder.

Sidan Bli medlem saknar den beskrivning som syns i Googles sökresultat, så Google väljer själv ett textutdrag. Med en egen beskrivning blir det tydligare varför man ska klicka och fler hittar rätt.

I mobilen tar startsidan drygt sex sekunder att ladda, främst på grund av stora bilder. Med komprimerade bilder går det betydligt snabbare och färre tröttnar innan sidan visas.

Jag hjälper gärna till med detta om ni vill. På rkkommunikation.se kan ni läsa mer om vad jag gör. Svara gärna på det här mejlet om ni vill ta ett första samtal, så hittar vi en tid som passar er.

Vänliga hälsningar`;

  it("godkänner ett korrekt mejl", () => {
    expect(antalOrd(ok)).toBeGreaterThanOrEqual(120);
    expect(sprakfel("Tre saker jag såg på exempelforeningen.se", ok, "")).toEqual([]);
  });
  it("stoppar tankstreck, kolon, utropstecken, längd och ämnesrad", () => {
    expect(sprakfel("Hej exempel.se", ok.replace("sökresultat, så", "sökresultat – så"), "")).toContain("innehåller tankstreck");
    expect(sprakfel("Hej: exempel.se", ok, "")).toContain("ämnesraden innehåller kolon");
    expect(sprakfel("Hej exempel.se", `${ok}\nTack!`, "")).toContain("innehåller utropstecken");
    expect(sprakfel("Hej exempel.se", "Kort text. rkkommunikation.se", "")[0]).toMatch(/ord, ska vara 120 till 180/);
    expect(sprakfel("En alldeles för lång ämnesrad som går långt över femtio tecken exempel.se", ok, "")).toContain(
      "ämnesraden är 73 tecken, högst 50",
    );
    expect(sprakfel("TRE SAKER PÅ EXEMPEL.SE", ok, "")).toContain("ämnesraden är skriven med versaler");
  });
  it("stoppar främmande länkar, du-tilltal, punktlistor och AI-omnämnande", () => {
    expect(sprakfel("Hej exempel.se", ok.replace("rkkommunikation.se", "rkkommunikation.se och https://annan.se/sida"), "")).toContain(
      "otillåten länk: https://annan.se/sida",
    );
    expect(sprakfel("Hej exempel.se", ok.replace("er webbplats", "din webbplats och dina sidor"), "")).toContain("tilltalar med du i stället för ni");
    expect(sprakfel("Hej exempel.se", ok.replace("Startsidan berättar", "- Startsidan berättar"), "")).toContain("innehåller punktlista");
    expect(sprakfel("Hej exempel.se", ok.replace("mina granskningsverktyg", "AI"), "").length).toBeGreaterThanOrEqual(0);
    expect(sprakfel("Hej exempel.se", `${ok.replace("Jag har tittat", "Med hjälp av AI har jag tittat")}`, "")).toContain("nämner AI");
  });
  it("tillåter bokningslänken när den är konfigurerad", () => {
    const text = ok.replace("så hittar vi en tid som passar er.", "eller boka direkt på cal.com/rawaz.");
    expect(sprakfel("Hej exempel.se", text, "")).toContain("otillåten länk: cal.com/rawaz");
    expect(sprakfel("Hej exempel.se", text, "https://cal.com/rawaz")).toEqual([]);
  });
});
