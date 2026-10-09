---
name: dagens
description: Kör dagens pass i Granskaren utan API, på Rawaz prenumeration. Verktygets kod hämtar, mäter, kontrollerar och skickar; underagenter med tomt sammanhang gör analys och utkast (Opus) samt verifiering och grind (Haiku 4.5). Använd när Rawaz skriver /dagens.
---

# Dagens pass utan API

Du är passledare. Du gör inga modellsteg själv utom webbsökningen i discover. Varje modellsteg görs av en underagent med tomt sammanhang som bara får läsa arbetspaketet och skriva sin resultatfil. Verktygets kod gör allt annat och kontrollerar varje svar mot samma zod-scheman, kodkontroller och grind som API-vägen.

Alla kommandon körs från projektmappen med `MODELLVAG=session` i miljön, till exempel:

```
MODELLVAG=session npx tsx src/cli.ts pass status
```

Med MODELLVAG=session läses ANTHROPIC_API_KEY aldrig in och API-klienten vägrar starta. Sätt aldrig nyckeln i miljön under passet.

## 0. Innan du börjar

1. Sessionsgränsen. Be Rawaz läsa av `/usage` (eller claude.ai/settings/usage) och säga hur stor andel av sessionsgränsen som är kvar, om han inte redan angav den som argument (`/dagens 60` betyder 60 procent kvar). Välj antalet sajter efter det, hellre färre sajter än ett pass som avbryts mitt i:

   | Kvar av sessionsgränsen | Antal sajter (`--antal`) |
   |---|---|
   | över 70 procent | 8 |
   | 40 till 70 procent | 4 |
   | 20 till 40 procent | 2 |
   | under 20 procent | kör inte, säg när gränsen återställs |

   Mätningen den 9 oktober 2026: ett pass på fem sajter drog 1,3 miljoner tokens i cache-skrivning och 4,6 miljoner i cache-läsning hos underagenterna, alltså ungefär 1,2 miljoner tokens per sajt. Passledarens egna anrop kostar därutöver lika mycket som dess sammanhang är stort gånger antalet anrop, så kör passet i en ny session med litet sammanhang, aldrig i en session som redan har arbetat länge. Se data/jamforelse/2026-10-09-kvot.md.
2. Säg till Rawaz att läsa av claude.ai/settings/usage nu, så att kvoten kan jämföras efter passet.
3. Kontrollera `.env`: `RUN_PAUSAD=true` (så att den schemalagda API-körningen inte går samma dag) och `SANDLAGE=granska` (så att alla mejl hamnar i granskningskön). Är något av dem fel, stanna och säg det till Rawaz. Kontrollera också att inget `run` pågår: `data/run.lock` ska peka på en död process eller saknas.
4. Kör `MODELLVAG=session npx tsx src/cli.ts pass api-kontroll` och spara numret på senaste kostnadsrad. Det används efteråt som bevis på att inget API-anrop gjordes.
5. Kör `pass status`. Finns ett pass för i dag med sajter som inte är klara, fortsätt med dem från det steg statusen visar (avsnitt 2). Ett avbrutet pass återupptas så, utan att något görs om.

## 1. Förbered

```
MODELLVAG=session npx tsx src/cli.ts pass forbered --antal 8
```

Hämtar och mäter sajter med status ny eller kvalificerad och skriver ett arbetspaket per sajt i `data/pass/<datum>/<domän>/`. Finns inga sajter kvar, gör discover (avsnitt 3) och förbered igen.

## 2. Per sajt, i den här ordningen

Kör sajterna en i taget och starta högst två underagenter samtidigt. Fem Opus-agenter på en gång slog i sessionsgränsen den 9 oktober 2026 och alla fem avbröts. Mappen är `data/pass/<datum>/<domän>` (domänen med ogiltiga tecken ersatta av understreck, så som `pass status` visar den). Varje underagent startas med Agent-verktyget, med subagent_type enligt nedan, och ett uppdrag som bara anger mappens fullständiga sökväg. Underagenterna har bara verktygen Read och Write.

| Steg | Underagent | Skriver | Sedan kör du |
|---|---|---|---|
| analys | `granskaren-analys` (Opus) | analys.json | `pass analys-in <domän>` |
| verifiering | `granskaren-verifiering` (Haiku 4.5) | verifiering.json | `pass verifiering-in <domän>` |
| utkast | `granskaren-utkast` (Opus) | utkast.json | `pass utkast-in <domän>` |
| grind | `granskaren-grind` (Haiku 4.5) | grind.json | `pass grind-in <domän>` |

Verifieringen går efter analysen och utkastet efter verifieringen, eftersom mejlet bara får bygga på bekräftade fynd. Kodkontrollerna körs av `analys-in` före verifieringen och av `utkast-in` före grindens modell.

Varje in-kommando skriver en rad som börjar med `UTFALL`:

- `UTFALL ok <domän> nasta=<steg>`: gå till det steget. `nasta=verifiering` betyder att verifieringspaketet är skrivet; `nasta=utkast` att utkastpaketet är skrivet; `nasta=grind` att grindpaketet är skrivet; `nasta=klar`, `stoppad` eller `granskningsko` att sajten är färdig. Om `analys-in` säger `nasta=utkast` behövde inget fynd modellens verifiering.
- `UTFALL nytt_forsok <domän>` (avslutningskod 2): starta samma underagent igen på samma mapp. Den läser felfilen (`analys-fel.txt`, `verifiering-fel.txt`, `utkast-fel.txt` eller `grind-fel.txt`) och gör ett nytt försök. Högst två försök per steg sköts av koden: efter det andra misslyckade försöket går sajten till granskningskön eller stoppas, och kommandot säger det.
- `UTFALL avbrutet <domän>` (avslutningskod 3): sajten är lagd i granskningskön. Gå vidare till nästa sajt.

Kontrollera inte underagenternas svar själv och rätta dem inte. Koden gör kontrollen. Läs inte arbetspaketens innehåll in i ditt eget sammanhang mer än nödvändigt.

## 3. Discover, bara när kön är tom

Discover görs i sessionen med din egen webbsökning, inte av en underagent.

1. Välj ett oanvänt segment: `MODELLVAG=session npx tsx src/cli.ts segment --lista`. Finns inget oanvänt, be Rawaz köra `segment` via API vid ett annat tillfälle (segmentframtagning ingår inte i passet).
2. `MODELLVAG=session npx tsx src/cli.ts pass discover-paket --segment <id> --antal 10 --sokningar 8`. Läs discover-system.md och discover-uppgift.md i mappen som skrivs ut. Följ dem: bara organisationernas egna sajter, inga kända domäner.
3. Sök med WebSearch på svenska, alltid med orten i frågan, och gör flera smala sökningar hellre än en bred: yrkesordet med orten, med grannkommuner, med ord som "hemsida", "kontakt", "boka", "medlem", "portfolio", samt yrkesvarianter. Högst så många sökningar som paketet anger. En domän får bara tas med om den står i ett sökresultat eller på en sida du har hämtat. Gissa aldrig en adress utifrån ett namn.
4. Katalogvägen: sök också efter medlemslistor, register och förteckningar för segmentet (yrkesförbund, kör- och föreningsregister, kommunens föreningsregister, branschorganisationer). För varje sådan sida, kör `pass discover-katalog --segment <id> --url <adress> --varfor "medlem i ..."`. Koden hämtar sidan och lägger de webbplatser den länkar till i traffar.json med hittad_via satt till katalogen.
5. Skriv sökträffarna som en JSON-lista `[{"namn": ..., "url": ..., "varfor": ..., "hittad_via": ...}]` till `traffar.json` i mappen (lägg till i listan om katalogvägen redan har skrivit dit). `hittad_via` är sökresultatets adress när resultatet pekar på sajten själv, annars den sida där du såg länken.
6. `pass discover-in --segment <id>`. Koden avvisar domäner som inte kommer från ett sökresultat eller en hämtad sida, sparar resten i soktraffar, hämtar varje kandidat och kör förfiltrets kodregler. Kandidater som klarar koden får filer i undermappen `forfilter/`.
7. Starta `granskaren-forfilter` (Haiku 4.5) på mappen `forfilter/`. Kör sedan `pass forfilter-in --segment <id>`. Godkända blir prospekt med status ny.
8. Kör `pass forbered` igen för de nya prospekten och fortsätt med avsnitt 2.

## 4. Skicka

```
MODELLVAG=session npx tsx src/cli.ts send
```

Samma utskick som i dag: köade mejl inom sändfönstret och dagens tak, med slumpad paus mellan mejlen. Mejl i granskningskön skickas inte förrän Rawaz godkänt dem med `review`. Med `SANDLAGE=granska` hamnar alla mejl i granskningskön, så `send` har då inget att skicka förrän Rawaz har gått igenom kön.

## 5. Efter passet

1. `pass status` och sammanfatta: per sajt antal fynd, bekräftade, utfall i grinden och antal försök.
2. `MODELLVAG=session npx tsx src/cli.ts pass api-kontroll --sedan <numret från steg 0>`. Det ska stå 0 API-anrop. Visa raden för Rawaz.
3. Säg till Rawaz att läsa av claude.ai/settings/usage igen och notera hur mycket passet drog.

## Om sessionsgränsen slår till

En underagent som avbryts med "session limit" (429) har inte skrivit sin resultatfil. Starta då inga fler underagenter. Lämna arbetspaketen som de är, kör `pass status`, och säg till Rawaz vilket klockslag gränsen återställs (står i felet). Efter återställningen fortsätter passet med samma kommandon från det steg statusen visar; paketen behöver inte skrivas om.

## Om sessionen stängs mitt i

Allt läge finns på disk och i databasen: arbetspaketen med statusfiler, fynd och verifiering i databasen, mejl i kön med status koad. Starta en ny session, skriv /dagens igen och börja på steg 0. `pass status` visar var varje sajt står och passet fortsätter därifrån. Ett steg som avbröts innan dess in-kommando kördes görs om från det steget. Utskicket kan inte dubbleras: varje mejl byter status till skickad när det går, `send` tar bara mejl med status koad, och databasen tillåter bara ett förstamejl per domän.
