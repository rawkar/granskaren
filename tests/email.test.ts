import { describe, expect, it } from "vitest";
import { avkoda, hittaAdresser, utvinnKontakter } from "../src/email/kontakter.js";
import { valjFynd } from "../src/email/val.js";
import { antalOrd, sprakfel, tillaggsfel } from "../src/email/grind.js";
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
    djup: 2, insikt: "i", rotorsak: null, forslag_konkret: null, insats: "liten", kopplar_till_syfte: 1,
    belagg2_url: null, belagg2_typ: null, belagg2_varde: null,
    ...delar,
  };
}

describe("val av fynd", () => {
  const hi = { text: "Huvudinsikt", fynd_ids: ["djup3", "titel"] };

  it("ger inget mejl utan huvudinsikt eller utan fynd med djup 3", () => {
    expect(valjFynd([fynd({ fynd_id: "djup3", djup: 3 }), fynd({ fynd_id: "titel", djup: 1 })], null).orsak).toBe("ingen huvudinsikt");
    expect(valjFynd([fynd({ fynd_id: "djup3", djup: 2 }), fynd({ fynd_id: "titel", djup: 1 })], hi).orsak).toBe("inget bekräftat fynd med djup 3");
  });
  it("tar aldrig med obekräftade fynd eller fynd utanför syftet", () => {
    const v = valjFynd(
      [
        fynd({ fynd_id: "djup3", djup: 3, verifierad: 0, forslag_konkret: "x" }),
        fynd({ fynd_id: "titel", djup: 1, forslag_konkret: "Ny titel" }),
        fynd({ fynd_id: "annat", djup: 3, kopplar_till_syfte: 0 }),
      ],
      hi,
    );
    expect(v.fynd).toEqual([]);
    expect(v.orsak).toBe("inget bekräftat fynd med djup 3");
  });
  it("väljer djup 3 som stöder huvudinsikten, högst ett djup 1, och ett med konkret förslag", () => {
    const v = valjFynd(
      [
        fynd({ fynd_id: "titel", djup: 1, forslag_konkret: "Grafisk identitet för företag i Västerås", belagg_url: "https://exempel.se/" }),
        fynd({ fynd_id: "titel2", djup: 1, omrade: "D", belagg_url: "https://exempel.se/om" }),
        fynd({ fynd_id: "djup3", djup: 3, omrade: "A", tjansteomrade: "strategi", belagg_url: "https://exempel.se/" }),
        fynd({ fynd_id: "formular", djup: 2, omrade: "H", belagg_url: "https://exempel.se/kontakt" }),
      ],
      hi,
    );
    expect(v.orsak).toBeNull();
    const ids = v.fynd.map((f) => f.fynd_id);
    expect(ids).toContain("djup3");
    expect(ids).toContain("titel");
    expect(ids).not.toContain("titel2");
    expect(v.fynd.filter((f) => f.djup === 1)).toHaveLength(1);
    expect(v.fynd.some((f) => f.forslag_konkret)).toBe(true);
    expect(v.fynd.length).toBeLessThanOrEqual(3);
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
    expect(antalOrd(ok)).toBeGreaterThanOrEqual(150);
    expect(antalOrd(ok)).toBeLessThanOrEqual(220);
    expect(sprakfel("Era case på exempelbyran.se säljer er under värde", ok, "")).toEqual([]);
    expect(tillaggsfel(ok, fyndOk)).toEqual([]);
  });
  it("stoppar tankstreck, kolon, utropstecken, längd och ämnesrad", () => {
    expect(sprakfel("Hej exempel.se", ok.replace("det, och", "det – och"), "")).toContain("innehåller tankstreck");
    expect(sprakfel("Hej: exempel.se", ok, "")).toContain("ämnesraden innehåller kolon");
    expect(sprakfel("Hej exempel.se", `${ok}\nTack!`, "")).toContain("innehåller utropstecken");
    expect(sprakfel("Hej exempel.se", "Kort text. rkkommunikation.se", "")[0]).toMatch(/ord, ska vara 150 till 220/);
    expect(sprakfel("En alldeles för lång ämnesrad som går långt över femtio tecken exempel.se", ok, "")).toContain(
      "ämnesraden är 73 tecken, högst 50",
    );
    expect(sprakfel("TRE SAKER PÅ EXEMPEL.SE", ok, "")).toContain("ämnesraden är skriven med versaler");
  });
  it("stoppar främmande länkar, du-tilltal, punktlistor, AI och påståendet att mätning saknas", () => {
    expect(sprakfel("Hej exempel.se", ok.replace("rkkommunikation.se", "rkkommunikation.se och https://annan.se/sida"), "")).toContain(
      "otillåten länk: https://annan.se/sida",
    );
    expect(sprakfel("Hej exempel.se", ok.replace("er webbplats", "din webbplats och dina sidor"), "")).toContain("tilltalar med du i stället för ni");
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
  it("kräver djup 3, konkret förslag på egen rad och siffror ur fynden", () => {
    expect(tillaggsfel(ok, fyndOk.map((f) => ({ ...f, djup: Math.min(f.djup, 2) })))).toContain("inget av fynden har djup 3");
    expect(tillaggsfel(ok, fyndOk.map((f) => ({ ...f, forslag_konkret: null })))).toContain("inget av fynden har ett konkret förslag");
    expect(tillaggsfel(ok.replace("\n\nGrafisk identitet och webb för företag i Västerås | Exempelbyrån\n\n", " "), fyndOk)).toContain(
      "det konkreta förslaget står inte ordagrant på en egen rad",
    );
    expect(tillaggsfel(ok.replace("nio fält", "12 fält"), fyndOk)).toContain("siffran 12 finns inte i fynden");
    expect(tillaggsfel(ok.replace("nio fält", "9 fält"), fyndOk)).toEqual([]);
    expect(tillaggsfel(ok, [...fyndOk, fynd({ fynd_id: "x", djup: 1 })])).toContain("fler än ett fynd med djup 1");
  });
});
