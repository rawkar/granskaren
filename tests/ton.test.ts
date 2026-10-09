import { describe, expect, it } from "vitest";
import { lasForbjudnaFraser, stycken, tonfel } from "../src/email/grind.js";

const dalig = `Hej,

Jag heter Rawaz Karim och är kommunikationskonsult. Med mina granskningsverktyg har jag gått igenom er webbplats och ser en familjeverkstad som funnits på samma adress i Södertälje sedan 1981 och som även tar emot husbilar och lätta lastbilar.

Ni har ovanligt konkreta skäl att erbjuda den som jämför verkstäder, men flera av dem står på undersidorna i stället för där besökaren bestämmer sig.

Tre års garanti på reservdelar nämns i dag bara på sidan Om oss.`;

const bra = `Hej,

Jag heter Rawaz Karim och är kommunikationskonsult. Jag har gått igenom er webbplats och har några förslag som jag tror kan ge er fler bokningar.

Garantin och svarstiden står inte på startsidan. Tre års garanti på reservdelar och svar med pris inom 24 timmar står bara på Om oss. Den som jämför verkstäder i Södertälje läser sällan så långt.

Tre års garanti på reservdelar nämns i dag bara på sidan Om oss.`;

describe("tonreglerna i grinden", () => {
  it("läser förbjudna fraser ur promptfilen utan parenteser och delar varianter", () => {
    const f = lasForbjudnaFraser();
    expect(f).toContain("med mina granskningsverktyg");
    expect(f).toContain("ser en");
    expect(f).toContain("ser ett");
    expect(f).toContain("där besökaren bestämmer sig");
    expect(f.some((x) => x.includes("("))).toBe(false);
  });

  it("delar brödtexten i stycken utan hälsningen", () => {
    const s = stycken(bra);
    expect(s[0]).toMatch(/^Jag heter Rawaz Karim/);
    expect(s[1]).toMatch(/^Garantin/);
  });

  it("underkänner det dåliga exemplet på flera grunder", () => {
    const fel = tonfel(dalig);
    expect(fel).toContainEqual(expect.stringMatching(/förbjuden fras: "med mina granskningsverktyg"/));
    expect(fel).toContainEqual(expect.stringMatching(/förbjuden fras: "ser en"/));
    expect(fel).toContainEqual(expect.stringMatching(/förbjuden fras: "skäl att erbjuda"/));
    expect(fel).toContainEqual(expect.stringMatching(/förbjuden fras: "där besökaren bestämmer sig"/));
    expect(fel).toContainEqual(expect.stringMatching(/förbjuden fras: "ovanligt konkreta"/));
    expect(fel).toContainEqual(expect.stringMatching(/första stycket innehåller ett årtal/));
    expect(fel).toContainEqual(expect.stringMatching(/första stycket innehåller ortsnamn eller egennamn: Södertälje/));
    expect(fel).toContainEqual(expect.stringMatching(/första stycket beskriver mottagarens verksamhet/));
    expect(fel).toContainEqual(expect.stringMatching(/huvudpoängens första mening är \d+ ord, högst 12/));
    expect(tonfel(dalig.replace("har jag gått igenom er webbplats", "har jag tittat på er sajt"))).toContainEqual(expect.stringMatching(/saknar "Jag har gått igenom/));
  });

  it("godkänner den bättre versionen", () => {
    expect(tonfel(bra)).toEqual([]);
  });

  it("stoppar återanvändning av exemplets formuleringar och fler än två meningar i inledningen", () => {
    const kopia = bra.replace("Garantin och svarstiden står inte på startsidan.", "Det bästa ni har att säga står inte på startsidan.");
    expect(tonfel(kopia)).toContainEqual(expect.stringMatching(/förbjuden fras: "det bästa ni har att säga står inte på startsidan"/));
    const tre = bra.replace("fler bokningar.", "fler bokningar. Ni gör ett fint jobb.");
    expect(tonfel(tre)).toContainEqual(expect.stringMatching(/första stycket har 3 meningar/));
  });

  it("stoppar den som jämför som subjekt i huvudpoängens första mening", () => {
    const d = bra.replace("Garantin och svarstiden står inte på startsidan.", "Den som jämför verkstäder hittar inte garantin.");
    expect(tonfel(d)).toContainEqual(expect.stringMatching(/den som jämför/));
  });
});
