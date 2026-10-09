import { describe, expect, it } from "vitest";
import type { FyndRad } from "../src/db/fragor.js";
import { byggFaktakallor, egennamn, faktafel, forslagsfel, medPresentation, PRESENTATION } from "../src/email/fakta.js";

const fynd = (x: Partial<FyndRad>): FyndRad =>
  ({
    id: 1,
    prospekt_id: 1,
    fynd_id: "F1",
    omrade: "A",
    tjansteomrade: "strategi",
    rubrik: "",
    observation: "",
    belagg_url: "https://exempel.se/",
    belagg_typ: "citat",
    belagg_varde: "",
    effekt: "",
    atgard: "",
    allvar: 2,
    sakerhet: 0.9,
    latt_att_forklara: 2,
    verifierad: 1,
    verifieringsmetod: "kod",
    verifieringsnot: null,
    skapad: "",
    djup: 3,
    insikt: "",
    rotorsak: null,
    forslag_konkret: null,
    insats: "liten",
    kopplar_till_syfte: 1,
    belagg2_url: null,
    belagg2_typ: null,
    belagg2_varde: null,
    ...x,
  }) as FyndRad;

describe("presentationen sätts in av programmet", () => {
  it("lägger den fasta meningen efter hälsningen", () => {
    const r = medPresentation("Hej,\n\nJag har gått igenom er webbplats och ser en ridklubb i Bålsta.\n\nAndra stycket.");
    expect(r.fel).toEqual([]);
    expect(r.brodtext).toBe(`Hej,\n\n${PRESENTATION} Jag har gått igenom er webbplats och ser en ridklubb i Bålsta.\n\nAndra stycket.`);
  });
  it("stoppar när modellen skriver sin egen presentation, som kommunikationskonsult för föreningar", () => {
    const r = medPresentation("Hej,\n\nJag heter Rawaz Karim och är kommunikationskonsult för föreningar. Jag har gått igenom er webbplats.");
    expect(r.fel).toContain("presentationen skrivs av programmet, modellen skrev en egen");
  });
  it("hanterar hälsning med förnamn", () => {
    const r = medPresentation("Hej Helena,\n\nJag har gått igenom din webbplats.");
    expect(r.brodtext.startsWith(`Hej Helena,\n\n${PRESENTATION} Jag har`)).toBe(true);
  });
});

describe("faktaspårning", () => {
  const habo = byggFaktakallor(
    { namn: "Håbo Ridklubb", doman: "haboridklubb.se", ort: "Bålsta", bransch: "ridklubb" },
    [
      fynd({ fynd_id: "F1", observation: "Överst står en välkomstrubrik och en knapp till lektionsschemat för höstterminen. Lediga platser för barn och vuxna står längre ner.", belagg_varde: "Här finner du lektionsschemat för höstterminen 2026." }),
      fynd({ fynd_id: "F2", observation: "Ludde har utsetts till Årets Ridskoleponny 2026.", belagg_varde: "Vår fantastiska Ludde har utsetts till Årets Ridskoleponny 2026" }),
      fynd({ fynd_id: "F3", observation: "Startsidan tar lång tid att visa i mobilen.", belagg_typ: "matvarde", belagg_varde: "lighthouse.lcp_ms=16867" }),
    ],
    null,
    null,
  );

  it("stoppar 'lediga platser i höst' när höst inte står i fynden", () => {
    const fel = faktafel("Hej,\n\nRidskola för barn och vuxna i Bålsta, med lediga platser i höst", habo);
    expect(fel).toContainEqual(expect.stringMatching(/tidsuttrycket "i höst"/));
  });
  it("godtar ord som står i fynden: Bålsta, Ludde, Årets Ridskoleponny 2026, höstterminen", () => {
    const fel = faktafel("Hej,\n\nAtt Ludde utsetts till Årets Ridskoleponny 2026 syns långt ner. Ridskola i Bålsta med lektionsschema för höstterminen.", habo);
    expect(fel).toEqual([]);
  });
  it("stoppar ett mätvärde omräknat till sekunder", () => {
    const fel = faktafel("Hej,\n\nStartsidan tar knappt 17 sekunder att visa sitt största innehåll.", habo);
    expect(fel).toContainEqual(expect.stringMatching(/siffran 17/));
  });
  it("stoppar räkneord som inte finns i källorna men släpper dem som finns", () => {
    expect(faktafel("Hej,\n\nStartsidan tar drygt sexton sekunder.", habo)).toContainEqual(expect.stringMatching(/räkneordet sexton/));
    const medMatt = byggFaktakallor({ namn: null, doman: "x.se", ort: null, bransch: null }, [fynd({ observation: "Formuläret har nio fält." })], null, null);
    expect(faktafel("Hej,\n\nFormuläret har nio fält.", medMatt)).toEqual([]);
  });

  const uakFynd = [
    fynd({ fynd_id: "F2", observation: "Startsidan visar två inlägg daterade 10 april 2023 och 2 januari 2022. Evenemangssidan visar flera konserter under 2024 och 2025.", belagg_varde: "kontroll.senaste_datum=2023-04-10" }),
    fynd({ fynd_id: "F3", observation: "Om oss berättar att kören räknas bland de främsta i Sverige, att Eric Ericson var dess förste ledare.", belagg_varde: "idag räknas bland de främsta körerna i Sverige" }),
  ];
  const uak = byggFaktakallor({ namn: "Uppsala Akademiska Kammarkör", doman: "uak.se", ort: "Uppsala", bransch: "kör" }, uakFynd, null, null);

  it("stoppar årtalet 1957 som inte står i något fynd", () => {
    const fel = faktafel("Hej,\n\nUppsala Akademiska Kammarkör har sedan 1957 räknats bland Sveriges främsta körer", uak);
    expect(fel).toContainEqual(expect.stringMatching(/årtalet 1957/));
  });
  it("släpper årtal som står i fynden och egennamn som Eric Ericson och Sverige", () => {
    const fel = faktafel("Hej,\n\nEvenemangssidan visar konserter under 2024 och 2025, medan senaste inlägget är från 2023. Om oss nämner Eric Ericson som förste ledare och att kören räknas bland de främsta i Sverige.", uak);
    expect(fel).toEqual([]);
  });
  it("stoppar ett årtal som bara står på sajten men inte i fynden", () => {
    const fel = faktafel("Hej,\n\nEvenemangssidan visar flera framträdanden under 2026, bland annat på Kulturnatten.", uak);
    expect(fel).toContainEqual(expect.stringMatching(/årtalet 2026/));
    expect(fel).toContainEqual(expect.stringMatching(/egennamnet Kulturnatten/));
  });
  it("stoppar egennamn som inte finns i källorna", () => {
    expect(faktafel("Hej,\n\nNi har byggt inredning åt Riddarhuset.", uak)).toContainEqual(expect.stringMatching(/egennamnet Riddarhuset/));
  });
  it("plockar egennamn men inte meningsinledare eller avsändaren", () => {
    expect(egennamn("Hej,\n\nJag har gått igenom er sajt. Ludde bor i Bålsta. Mer finns på rkkommunikation.se.\n\nVänliga hälsningar")).toEqual(["Bålsta"]);
  });
});

describe("värderande förslag", () => {
  const sidtexter = ["Uppsala Akademiska Kammarkör (UAK) bildades 1957 och är en blandad kör med ca 35 medlemmar som idag räknas bland de främsta körerna i Sverige."];
  it("stryker ett förslag som kombinerar fakta till ett nytt värderande påstående", () => {
    expect(forslagsfel("Uppsala Akademiska Kammarkör har sedan 1957 räknats bland Sveriges främsta körer", sidtexter)).toMatch(/främsta/);
  });
  it("godtar ett förslag som flyttar sajtens egen formulering", () => {
    expect(forslagsfel("idag räknas bland de främsta körerna i Sverige", sidtexter)).toBeNull();
  });
  it("godtar förslag utan värderande ord", () => {
    expect(forslagsfel("Blandad kammarkör i Uppsala med modern a cappella-musik som specialitet", sidtexter)).toBeNull();
    expect(forslagsfel(null, sidtexter)).toBeNull();
  });
});
