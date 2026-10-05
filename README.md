# Granskaren

Webbgranskning och personlig outreach för RK Kommunikation. Ett lokalt kommandoradsverktyg som hittar webbplatser, granskar dem med en kommunikatörs blick, verifierar varje fynd mot rådata och (från fas 2) skriver ett personligt mejl till organisationen.

Det här är fas 1: grund och granskning. Import, hämtning, mätning, analys, verifiering och rapport. Mejl, utskick och svar kommer i senare faser.

## Installation

Kräver Node.js 22.19 eller senare (testat med Node 24).

```
npm install
npx playwright install chromium
cp .env.example .env
```

Fyll i `.env`. För fas 1 räcker `ANTHROPIC_API_KEY`, `MODEL_ANALYS` och `MODEL_SNABB`. Kontrollera aktuella modellnamn i Anthropics dokumentation innan du väljer. Förslagen i `.env.example` är en starkare modell för analys och en snabbare för enklare klassning.

`.env` och mappen `data/` ligger i `.gitignore` och ska aldrig checkas in.

## Kommandon

Kör med `npm run granskaren -- <kommando>` eller, efter `npm link`, bara `granskaren <kommando>`.

| Kommando | Vad det gör |
|---|---|
| `import <fil.csv>` | Läser in en lista. Kolumner: `url` (obligatorisk), `namn`, `bransch`, `ort`, `kommentar`. Domänen normaliseras och dubbletter hoppas över. |
| `audit [--antal N]` | Granskar sajter med status `ny` eller `kvalificerad`. Standard är 5 åt gången. |
| `audit --doman exempel.se [--igen]` | Granskar en viss domän. `--igen` tillåter omgranskning. |
| `audit --utan-modell` | Hämtar och mäter men hoppar över analysen. Bra för att testa utan API-nyckel. |
| `audit --utan-lighthouse` | Hoppar över Lighthouse. Snabbare. |
| `draft [--antal N]` | Skriver mejlutkast för granskade sajter. Letar upp mejladress på sajten, väljer två eller tre bekräftade fynd, skriver mejlet och kör kvalitetsgrinden. |
| `draft --doman exempel.se --test-till du@exempel.se` | Utkast för en viss sajt, adresserat till en testadress i stället för organisationens. |
| `review` | Går igenom granskningskön, ett utkast i taget. Godkänn, redigera i din textredigerare eller kasta. |
| `report <domän>` | Skriver ut rapporten för en sajt. |
| `status` | Visar prospekt per status, mätpunkter och kostnad. |
| `block <domän eller adress>` | Lägger till på spärrlistan. |

Kommandona `send`, `sync`, `followup`, `discover` och `run` tillkommer i fas 3 till 6.

## Mejlutkast och kvalitetsgrind

`draft` sparar utkastet i databasen och som fil i `data/utkast/<domän>.txt`. Kvalitetsgrinden kontrollerar med kod det som går (tankstreck, kolon, utropstecken, längd 120 till 180 ord, ämnesradens längd, otillåtna länkar, du-tilltal) och låter den snabba modellen kontrollera att varje påstående om sajten har stöd i ett bekräftat fynd. Utkast som stoppas får status `utkast` och syns i `review` tillsammans med orsaken. I läget `granska` hamnar alla godkända utkast i granskningskön. I läget `auto` köas utkast med säkerhet över `MIN_SAKERHET_AUTO` direkt för utskick.

Prompten för mejlet ligger i `prompts/mejl.md` och prompten för påståendekontrollen i `prompts/grind.md`. Signaturen byggs från `AVSANDARE_*` i `.env`.

Sajter där ingen mejladress hittas markeras `endast_formular` och får inget utkast. Verktyget fyller aldrig i formulär.

## En första körning

1. Skapa en CSV-fil, till exempel `lista.csv`:

   ```
   url,namn,bransch,ort,kommentar
   exempelforeningen.se,Exempelföreningen,idrottsförening,Uppsala,
   https://www.annanforening.se/,,kulturförening,Västerås,tips från Anna
   ```

2. Läs in den:

   ```
   npm run granskaren -- import lista.csv
   ```

3. Granska upp till tre sajter:

   ```
   npm run granskaren -- audit --antal 3
   ```

   För varje sajt hämtas startsidan, kontaktsidan, om oss, den viktigaste handlingssidan (bli medlem, boka, stöd oss, tjänster, priser), senaste nyhet och upp till tre menysidor, högst åtta sidor med minst två sekunders paus. robots.txt respekteras. Lighthouse (mobil) och axe körs på startsidan och handlingssidan. Egna kontroller körs på alla sidor. Sedan analyserar språkmodellen underlaget, varje fynd verifieras i ett separat steg, och en rapport skrivs.

4. Läs rapporten:

   ```
   npm run granskaren -- report exempelforeningen.se
   ```

   Rapporten finns också som fil i `data/rapporter/<domän>.md` och går bra att öppna i VS Code med förhandsvisning, då syns skärmbilderna.

5. Se läget:

   ```
   npm run granskaren -- status
   ```

## Vad som sparas

| Plats | Innehåll |
|---|---|
| `data/granskaren.db` | SQLite-databasen med prospekt, sidor, mätningar, fynd, händelser, spärrlista och kostnader. |
| `data/sidor/<domän>/` | Renderad HTML, ren text och skärmbilder (dator och mobil) för varje hämtad sida, samt robots.txt och sitemap.xml. |
| `data/lighthouse/<domän>/` | Fullständiga Lighthouse-rapporter som JSON. |
| `data/underlag/<domän>.json` | Hela underlaget som modellen fick, inklusive alla mätvärden. Det är hit verifieringen går för att kontrollera belägg. |
| `data/rapporter/<domän>.md` | Rapporten. |

## Så kontrollerar du ett fynd för hand

Varje fynd i rapporten har ett belägg med URL, typ och värde.

- `saknat_element`. Värdet är en CSS-selektor. Öppna sidans HTML i `data/sidor/<domän>/` och sök efter elementet. Det ska inte finnas.
- `matvarde`. Värdet är `nyckel=värde`. Nyckeln finns i `data/underlag/<domän>.json` under sidan (`kontroll`, `lighthouse`, `axe`) eller under `sajt`.
- `citat`. Värdet ska finnas ordagrant i sidans text, se `.txt`-filen i `data/sidor/<domän>/`.
- `statuskod`. Statuskoden för URL:en, antingen en hämtad sida eller en kontrollerad länk (`lankar` i databasen).
- `skarmbild`. Titta på skärmbilden som rapporten länkar till.

Fynd om budskap, innehåll och vägen till handling (område A, C och H) kontrolleras dessutom av ett andra modellanrop som bara får rådata och fyndet. Bara fynd som bekräftas av alla tillämpliga kontroller markeras som verifierade. Övriga listas i rapporten under "Fynd som inte kunde bekräftas" med orsak.

## Promptar

Alla promptar ligger i `prompts/` som markdown. Ändra ton och regler där utan att röra koden.

- `prompts/analys.md` styr granskningen och vilka fynd modellen får föreslå.
- `prompts/verifiering.md` styr det andra modellanropet som kontrollerar bedömningsfynd.

## Kvalificering

En sajt hoppas över och markeras med orsak om domänen inte svarar, verkar parkerad eller under uppbyggnad, om kontakt- eller om-sidan visar att organisationen har egen kommunikationsfunktion (presskontakt, kommunikationschef och liknande), om domänen finns på spärrlistan eller redan har fått ett mejl. Hoppade sajter och orsaken syns i `status`.

## Tester

```
npm test
```

Testerna använder sparade HTML-sidor i `tests/fixtures/` och en databas i minnet. Inga tester anropar riktiga sajter eller modellen.

## Kostnad

Varje modellanrop loggas i tabellen `kostnader` med steg, modell och tokens. `status` visar total kostnad och kostnad per granskad sajt. Lägg dessutom ett kostnadstak på Anthropic-kontot.
