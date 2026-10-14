# Granskaren

Webbgranskning och personlig outreach för RK Kommunikation. Ett lokalt kommandoradsverktyg som hittar webbplatser hos mindre organisationer, granskar dem med en kommunikatörs blick, verifierar varje fynd mot rådata, skriver ett kort personligt mejl och skickar det när Rawaz har godkänt det.

Driften går helt via Claude Code-sessionen på prenumerationen. Inget API används: `TILLAT_API=false` i `.env` gör att API-klienten vägrar starta och att ingen nyckel läses in. Modellstegen görs av underagenter som startas från färdigheten `/dagens`, och verktygets kod gör allt annat: hämtning, mätning, kodkontroller, scheman, databas, kö och utskick.

## Installation

Kräver Node.js 22.19 eller senare (testat med Node 24).

```
npm install
npx playwright install chromium
cp .env.example .env
```

Fyll i SMTP-uppgifterna och avsändaren i `.env`. Övriga värden i `.env.example` är driftens aktuella inställningar. `.env` och mappen `data/` ligger i `.gitignore` och ska aldrig checkas in.

## Så går ett pass

Ett pass körs i en ny Claude Code-session med `/dagens <session kvar> <vecka kvar> [antal sajter]`, där de två första värdena är andelen kvar av femtimmarssessionen och av veckan enligt `/usage`. Passledaren (sessionen) gör inga modellsteg själv utom webbsökningen i discover. Varje modellsteg görs av en underagent med tomt sammanhang som bara får läsa ett arbetspaket och skriva sin resultatfil. Högst två underagenter körs samtidigt.

| Steg | Vem | Vad |
|---|---|---|
| `pass forbered --antal N` | kod | Hämtar och mäter sajter med status ny eller kvalificerad och skriver ett arbetspaket per sajt i `data/pass/<datum>/<domän>/`. Egenföretagare (kundtyp 1) ligger sist och får högst var tionde plats. |
| analys | `granskaren-analys`, claude-opus-5-5 | Tre till fyra fynd med belägg, effekt, allvar och eventuellt ett konkret förslag, plus en kort profil (person, vad de gör, viktigaste handling). Ingen skärmbild, bantat underlag. |
| `pass analys-in` | kod | Tolkar svaret mot zod-schemat, kontrollerar belägg mot rådata och skriver verifieringspaket för fynd som behöver modellens kontroll. |
| verifiering | `granskaren-verifiering`, claude-haiku-4-5-20251001 | Bedömer bara fakta: `bekraftat`, `delvis` med `galler_inte` (den del av påståendet som inte håller) eller `fel`. Värdeord och tolkningar är inte skäl att underkänna. |
| `pass verifiering-in` | kod | Sparar bedömningarna, avslutar granskningen, skriver rapporten och utkastpaketet när minst två fynd är bekräftade. |
| utkast | `granskaren-utkast`, claude-opus-5-5 | Mejlet. |
| `pass utkast-in` | kod | Kodgrinden. I läget `granska` sparas godkända utkast direkt i granskningskön. Modellgrinden (`granskaren-grind`) körs bara i läget `auto`. |

Efter varje steg kontrollerar passledaren med `pass modellkontroll --steg <steg>` att underagenten faktiskt kördes på den modell som agentdefinitionen anger. Avviker den avbryts passet. Agentdefinitionerna i `.claude/agents/` har alltid fullständiga modellnamn, aldrig alias.

Tar prospekten slut görs discover i sessionen: `pass discover-paket`, webbsökning eller en katalogsida (`pass discover-katalog --url`), `pass discover-in`, förfilter med `granskaren-forfilter` och `pass forfilter-in`. Katalogsidor som 1177:s kontaktkort och Wikipedias infoboxar ger bättre träffar än webbsökningen.

Efter passet visar `pass status` steg, utfall och tokens per sajt och steg, `pass api-kontroll --sedan <rad>` visar att noll API-anrop gjordes, och `pass kvot --efter <session> --vecka <vecka>` loggar förbrukningen per sajt i `data/jamforelse/kvot-logg.csv` och visar hur många sajter som ryms i en session och hur många pass veckan räcker till.

## Granskning och utskick

Alla mejl hamnar i granskningskön (`SANDLAGE=granska`). Rawaz läser varje mejl och avgör godkänn, ändra eller kasta.

```
npx tsx src/cli.ts review --lista
npx tsx src/cli.ts review --godkann 60 61 62 --orsak "godkänt av Rawaz 2026-10-14"
npx tsx src/cli.ts review --kasta 51 --orsak "samma organisation som agilokliniken.se"
npx tsx src/cli.ts review
npx tsx src/cli.ts send
```

`review --lista` skriver ut alla mejl i kön i sin helhet med id, mottagare och ämnesrad. `--godkann` köar, `--kasta` kastar (prospektet är kvar som granskat). Utan flaggor går `review` igenom kön interaktivt med möjlighet att redigera i textredigeraren. `send` skickar köade mejl på vardagar inom sändfönstret `SANDFONSTER_START` till `SANDFONSTER_SLUT`, högst `MAX_MEJL_PER_DAG` per dag, med en slumpad paus på `PAUS_MIN_MINUTER` till `PAUS_MAX_MINUTER` minuter mellan varje. Faller nätet mitt i väntar `send` fem minuter och försöker igen, upp till fyra gånger, innan det ger upp; mejlet ligger kvar som köat tills det har gått. `SAND_PAUSAD=true` stänger kön helt. Vid `TORRKORNING=true` skrivs mejlen som `.eml`-filer i `data/torrkorning/` i stället. Ingen schemalagd körning finns; utskicket startas när Rawaz säger det.

Databasen tillåter bara ett förstamejl per domän, så ett utskick kan inte dubbleras.

## Kommandon

Kör med `npx tsx src/cli.ts <kommando>` eller `npm run granskaren -- <kommando>`.

| Kommando | Vad det gör |
|---|---|
| `pass forbered [--antal N]` | Hämtar, mäter och skriver arbetspaket. |
| `pass analys-in`, `verifiering-in`, `utkast-paket`, `utkast-in`, `grind-in <domän>` | Läser in underagentens resultatfil, kör kodkontrollerna och säger vilket steg som är nästa (`UTFALL`-raden). |
| `pass status` | Per sajt: steg, försök, utfall, samt tokens per sajt och steg. |
| `pass tokens <domän>` | Tokens per steg för en sajt. |
| `pass modellkontroll --steg <steg>` | Läser underagentens transkript och kontrollerar att rätt modell användes. |
| `pass kvot --fore/--efter <session> --vecka <vecka>` | Loggar kvotförbrukningen per pass och visar snitt. |
| `pass api-kontroll [--sedan N]` | Visar att API:t är avstängt och hur många API-anrop som loggats sedan rad N. |
| `pass discover-paket`, `discover-katalog --url`, `discover-in --segment`, `forfilter-in --segment` | Discover i sessionen, se färdigheten. |
| `review [--lista] [--godkann id...] [--kasta id...] [--orsak text]` | Granskningskön. |
| `send [--max N]` | Skickar köade mejl. `send --test-till du@exempel.se [--doman x.se]` skickar ett utkast till din egen adress utan att röra kön. |
| `skickade [--doman x.se]` | Listar mejl som faktiskt har skickats i skarpt läge. Kopior ligger i `data/skickade/`. |
| `fordjupa <domän>` och `fordjupa-in <domän>` | Fördjupad analys på begäran, till exempel när en organisation har svarat. Arbetspaket i `data/fordjupning/<domän>/`, rapport i `data/rapporter/<domän>-fordjupning.md`. |
| `segment --fil <json>` och `segment --lista` | Läser in segment (yrke, ort, sökfras per kundtyp) skrivna i sessionen, eller listar dem. |
| `forebilder` | Profilerar förebilderna i `prompts/kundprofil.md` och lägger dem på spärrlistan som befintliga kunder. |
| `import <fil.csv>` | Läser in en lista med kolumnerna `url`, `namn`, `bransch`, `ort`, `kommentar`. |
| `report <domän>` | Skriver ut rapporten för en sajt. |
| `status` | Prospekt per status, mätpunkter, kostnad och tokens. |
| `block <domän eller adress>` | Lägger till på spärrlistan. |
| `paus [--av]` | Visar eller tar bort kvalitetsvaktens paus. |

Kommandona `audit`, `draft`, `discover`, `segment --antal` och `run` är API-vägen från den tidigare driften. De finns kvar för ett medvetet undantag men vägrar köra så länge `TILLAT_API=false`.

## Så bedömer analysen

Ribban är låg med flit: ett mejl skrivs så snart två fynd är bekräftade, oavsett hur djupa de är. Analysen tar fram tre till fyra fynd på startsidan, kontaktsidan och den viktigaste handlingssidan. Varje fynd har område, rubrik, observation, belägg (URL, typ och värde), effekt för besökaren, allvar 1 till 3 och eventuellt ett konkret förslag, till exempel en ny knapptext, som sedan skrivs ordagrant på en egen rad i mejlet.

Siffror som används i fynd och mejl kommer från kodräknade mått i `data/underlag/<domän>.json` under `matt` och från Lighthouse och axe. Modellen räknar aldrig själv och byter aldrig enhet.

Verifieringen kontrollerar fakta, inte nivå. Ett fynd är bekräftat när påståendet håller mot rådatan, delvis bekräftat när en del inte håller (den delen sparas som `galler_inte` och får inte användas i mejlet; ett konkret förslag som innehåller den stryks), och fel när påståendet inte stämmer. Fynd om budskap, innehåll, tillit och vägen till handling (område A, C, G och H) går till modellens verifiering; övriga kontrolleras av kod.

Filen `prompts/rawaz-perspektiv.md` är din. Fyll i den med dina principer och vanligaste iakttagelser, så vägs de in i analysen.

## Mejlet

Mejlet öppnar med det fynd som har högst allvar och tar upp två eller tre fynd. Brödtexten är 110 till 190 ord med målet 150 (`MEJL_ORDMAL`, `MEJL_MAX_ORD`). Varje stycke om ett fynd säger varför det spelar roll för besökaren. Ett exempel skrivs bara när fyndet har ett konkret förslag. Med `MEJL_FLER_FYND=true` lägger programmet in en fast mening ur `prompts/fler-fynd.md` före erbjudandet när det finns bekräftade fynd som inte fick plats; modellen skriver aldrig den meningen själv.

Ämnesraden skrivs från mallen `AMNESMALL` i `.env`, där `{domän}` byts mot domänen utan www och `{namn}` mot organisationens namn. Blir raden längre än 60 tecken används namnet.

Tilltalet avgörs i profilen. Drivs sajten av en namngiven person hälsar mejlet med förnamn och säger du, annars ni. En egenföretagare utan känt förnamn tilltalas ni. Mejlet kritiserar aldrig mottagarens formuleringar utan lyfter det som redan är starkt och föreslår en mer framträdande plats. Om mätning skriver mejlet att inget mätverktyg syns på sidan, aldrig att mätning saknas. Signaturen byggs från `AVSANDARE_*` i `.env`; telefonnumret visas på egen rad när det är ifyllt.

Kodgrinden kontrollerar tankstreck, kolon, utropstecken, längd, ämnesradens längd, otillåtna länkar (klockslag räknas inte som länkar), tilltal, rytm (korta meningar, högst fyra meningar per stycke), tvärsäkra ord, att huvudpoängen kommer först, att exemplet står på egen rad bara när ett förslag finns, att varje siffra i mejlet finns i fynden och att inget ur `galler_inte` används. Promptarna ligger i `prompts/mejl.md`, `prompts/grind.md` och `prompts/fler-fynd.md`.

Sajter där ingen mejladress hittas markeras `endast_formular` och får inget utkast. Verktyget fyller aldrig i formulär.

## Målgrupp och discover

Målgruppen är mindre organisationer och företag med anställda: föreningar, kliniker, byråer, restauranger, klubbar. Egenföretagare (kundtyp 1) får högst var tionde plats i kön. Fördelningen per kundtyp och förebilderna står i `prompts/kundprofil.md`; förfiltret (`prompts/forfilter.md`) ger pluspoäng för tecken på anställda (kansli, personalsida, namngivna roller, växelnummer, funktionsadresser) och väljer aldrig bort någon på grund av låg likhet med förebilderna. Segment skrivs i sessionen och läses in med `segment --fil`.

Alla träffar från discover sparas i tabellen `soktraffar` med var de hittades. Träffar som inte hann prövas prövas nästa gång innan någon ny sökning görs, i upp till 30 dagar.

## Kvalificering

En sajt hoppas över och markeras med orsak om domänen inte svarar, verkar parkerad eller under uppbyggnad, om kontakt- eller om-sidan visar att organisationen har egen kommunikationsfunktion, om domänen finns på spärrlistan eller redan har fått ett mejl. Hoppade sajter och orsaken syns i `status`.

## Vad som sparas

| Plats | Innehåll |
|---|---|
| `data/granskaren.db` | SQLite-databasen med prospekt, sidor, mätningar, fynd (med `galler_inte`), händelser, mejl, spärrlista, sökträffar och kostnader. |
| `data/pass/<datum>/<domän>/` | Arbetspaket och resultatfiler för passet, med statusfil per steg. |
| `data/sidor/<domän>/` | Renderad HTML, ren text och skärmbilder för varje hämtad sida, samt robots.txt och sitemap.xml. |
| `data/lighthouse/<domän>/` | Fullständiga Lighthouse-rapporter som JSON. |
| `data/underlag/<domän>.json` | Hela underlaget med alla mätvärden. Det är hit verifieringen går för att kontrollera belägg. |
| `data/rapporter/<domän>.md` | Rapporten, och `<domän>-fordjupning.md` efter en fördjupad analys. |
| `data/utkast/<domän>.txt`, `data/skickade/` | Utkastet som fil och en kopia av varje skickat mejl. |
| `data/logg/` | Loggar från utskick. |
| `data/jamforelse/kvot-logg.csv` | Kvotförbrukning per pass. |

## Så kontrollerar du ett fynd för hand

Varje fynd i rapporten har ett belägg med URL, typ och värde.

- `saknat_element`. Värdet är en CSS-selektor. Öppna sidans HTML i `data/sidor/<domän>/` och sök efter elementet. Det ska inte finnas.
- `matvarde`. Värdet är `nyckel=värde`. Nyckeln finns i `data/underlag/<domän>.json` under sidan (`kontroll`, `lighthouse`, `axe`) eller under `sajt`.
- `citat`. Värdet ska finnas ordagrant i sidans text, se `.txt`-filen i `data/sidor/<domän>/`.
- `statuskod`. Statuskoden för URL:en, antingen en hämtad sida eller en kontrollerad länk.

Fynd som inte bekräftades listas i rapporten under "Fynd som inte kunde bekräftas" med orsak.

## Promptar och agenter

Alla promptar ligger i `prompts/` som markdown. Ändra ton och regler där utan att röra koden.

- `prompts/analys.md` den lätta analysen, `prompts/analys-fordjupad.md` den fördjupade.
- `prompts/verifiering.md` faktakontrollen med exempel på bekräftat, delvis och fel.
- `prompts/mejl.md`, `prompts/grind.md`, `prompts/fler-fynd.md`, `prompts/forbjudna-fraser.md` mejlet.
- `prompts/kundprofil.md`, `prompts/forfilter.md`, `prompts/segment.md`, `prompts/discover-webb.md` målgruppen.

Underagenterna definieras i `.claude/agents/` med fullständiga modellnamn och bara verktygen Read och Write. Färdigheten `/dagens` i `.claude/skills/dagens/SKILL.md` är passledarens instruktion. Ändringar i agentdefinitionerna gäller från nästa session.

## Tester

```
npm test
```

Testerna använder sparade HTML-sidor i `tests/fixtures/` och en databas i minnet. Inga tester anropar riktiga sajter eller modellen.

## Kvot och kostnad

Förbrukningen mäts i tokens per sajt och steg (`pass status`) och i andel av prenumerationens session och vecka (`pass kvot`). Snittet styr hur många sajter nästa pass tar. Kostnadsloggen i tabellen `kostnader` och taket `MAX_KOSTNAD_PER_MANAD` gäller bara API-vägen och står stilla i driften; `pass api-kontroll --sedan <rad>` är beviset på att inget API-anrop gjorts.
