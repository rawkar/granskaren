---
name: dagens
description: Kör dagens pass i Granskaren utan API, på Rawaz prenumeration. Verktygets kod hämtar, mäter, kontrollerar och sparar; underagenter med tomt sammanhang gör analys och utkast (claude-opus-5-5) samt verifiering och förfilter (claude-haiku-4-5-20251001). Används när Rawaz skriver /dagens, alltid i en ny session.
---

# Dagens pass utan API

Du är passledare. Du gör inga modellsteg själv utom webbsökningen i discover. Varje modellsteg görs av en underagent med tomt sammanhang som bara får läsa arbetspaketet och skriva sin resultatfil. Verktygets kod gör allt annat och kontrollerar varje svar mot samma zod-scheman och kodkontroller som alltid.

Tre regler för dig som passledare:

1. Du läser aldrig analys-, verifierings- eller utkastfiler och skriver aldrig ut dem. Du kör in-kommandona och läser bara raden som börjar med `UTFALL`, `MODELL` eller `TOKENS`. Mejlen läser Rawaz själv i granskningskön.
2. Du felsöker inte mitt i ett pass. Händer något oväntat (ett kommando kraschar, en agent svarar fel två gånger, en modellavvikelse, ett 429) avbryter du passet, kör `pass status`, och rapporterar kort vad som hände och var passet står. Allt läge finns på disk, passet återupptas i en ny session.
3. Högst två underagenter samtidigt, aldrig fler.

Alla kommandon körs från projektmappen:

```
npx tsx src/cli.ts pass status
```

Driften går bara via sessionen: TILLAT_API=false i .env gör att API-klienten vägrar starta och att ingen nyckel läses in. Sätt aldrig ANTHROPIC_API_KEY i miljön.

## 0. Innan du börjar

1. Argumenten till /dagens är `/dagens <session kvar> <vecka kvar> [antal sajter]`, till exempel `/dagens 100 80 2`. Saknas värdena, be Rawaz läsa av `/usage` och säga hur stor andel som är kvar av femtimmarssessionen och av veckan. Spara dem direkt:

   ```
   npx tsx src/cli.ts pass kvot --fore <session> --vecka <vecka>
   ```

   Kommandot visar snittförbrukningen per sajt från tidigare pass (data/jamforelse/kvot-logg.csv), hur många sajter som ryms i sessionen med marginal och hur många pass veckan räcker till. Finns ett snitt, använd det talet som `--antal` (eller det antal Rawaz angav om det är lägre). Finns inget snitt ännu, välj efter tabellen, hellre färre sajter än ett pass som avbryts mitt i:

   | Kvar av sessionsgränsen | Antal sajter (`--antal`) |
   |---|---|
   | över 70 procent | 8 |
   | 40 till 70 procent | 4 |
   | 20 till 40 procent | 2 |
   | under 20 procent | kör inte, säg när gränsen återställs |

2. Kontrollera `.env`: `TILLAT_API=false` och `SANDLAGE=granska` (alla mejl hamnar i granskningskön). Är något av dem fel, stanna och säg det till Rawaz. Kontrollera också att inget `run` pågår: `data/run.lock` ska peka på en död process eller saknas.
3. Kör `npx tsx src/cli.ts pass api-kontroll` och spara numret på senaste kostnadsrad. Det används efteråt som bevis på att inget API-anrop gjordes.
4. Kör `pass status`. Finns ett pass för i dag med sajter som inte är klara, fortsätt med dem från det steg statusen visar (avsnitt 2). Ett avbrutet pass återupptas så, utan att något görs om.

## 1. Förbered

```
npx tsx src/cli.ts pass forbered --antal <n>
```

Hämtar och mäter sajter med status ny eller kvalificerad och skriver ett arbetspaket per sajt i `data/pass/<datum>/<domän>/`. Egenföretagare (kundtyp 1) ligger sist i kön och får högst var tionde plats. Finns inga sajter kvar, gör discover (avsnitt 3) och förbered igen.

## 2. Per sajt, i den här ordningen

Kör sajterna en i taget och starta högst två underagenter samtidigt. Mappen är `data/pass/<datum>/<domän>` (domänen med ogiltiga tecken ersatta av understreck, så som `pass status` visar den). Varje underagent startas med Agent-verktyget, med subagent_type enligt nedan, `run_in_background: false`, och ett uppdrag som bara anger mappens fullständiga sökväg. Underagenterna har bara verktygen Read och Write.

| Steg | Underagent | Modell | Skriver | Sedan kör du |
|---|---|---|---|---|
| analys | `granskaren-analys` | claude-opus-5-5 | analys.json | `pass analys-in <domän>` |
| verifiering | `granskaren-verifiering` | claude-haiku-4-5-20251001 | verifiering.json | `pass verifiering-in <domän>` |
| utkast | `granskaren-utkast` | claude-opus-5-5 | utkast.json | `pass utkast-in <domän>` |
| grind | `granskaren-grind` (bara när SANDLAGE=auto) | claude-haiku-4-5-20251001 | grind.json | `pass grind-in <domän>` |

Verifieringen går efter analysen och utkastet efter verifieringen, eftersom mejlet bara får bygga på bekräftade fynd. Kodkontrollerna körs av `analys-in` före verifieringen och av `utkast-in` före sparandet. I läget granska avslutar `utkast-in` sajten direkt när kodkontrollerna godkänner utkastet (`nasta=klar`), eftersom Rawaz läser varje mejl; modellgrinden körs bara i läget auto.

Efter varje underagent gör du två saker med Agent-verktygets svar:

1. **Modellkontroll efter den första agenten i varje steg.** Svaret innehåller agentens id. Kör `npx tsx src/cli.ts pass modellkontroll --steg <steg> --agent <id>`. Står det `MODELL avvikelse` avbryter du passet omedelbart: starta inga fler agenter, kör `pass status`, och rapportera raden till Rawaz ordagrant. Agentdefinitionerna anger fullständiga modellnamn, så en avvikelse betyder att sessionen inte följer dem och måste startas om.
2. **Tokens.** Svaret innehåller `subagent_tokens`. Kör `npx tsx src/cli.ts pass tokens <domän> --steg <steg> --antal <tal>`. Det ger tokens per sajt och steg i rapporten efter passet.

Läs in-kommandots utfallsrad:

- `UTFALL ok <domän> nasta=<steg>`: gå till det steget. `nasta=verifiering` betyder att verifieringspaketet är skrivet; `nasta=utkast` att utkastpaketet är skrivet; `nasta=grind` att grindpaketet är skrivet (bara i läget auto); `nasta=klar`, `stoppad` eller `granskningsko` att sajten är färdig. Om `analys-in` säger `nasta=utkast` behövde inget fynd modellens verifiering.
- `UTFALL nytt_forsok <domän>` (avslutningskod 2): starta samma underagent igen på samma mapp. Den läser felfilen (`analys-fel.txt`, `verifiering-fel.txt`, `utkast-fel.txt` eller `grind-fel.txt`) och gör ett nytt försök. Högst två försök per steg sköts av koden: efter det andra misslyckade försöket går sajten till granskningskön eller stoppas, och kommandot säger det.
- `UTFALL avbrutet <domän>` (avslutningskod 3): sajten är färdig med ett hinder (till exempel färre än två bekräftade fynd eller sajten bedömd som välskött). Gå vidare till nästa sajt.

### Sajterna från den 12 oktober 2026

lovisualisera.se, inredningsdesigneruppsala.se, torshallagk.se och ifkeskilstuna.com analyserades den 12 oktober med den gamla verifieringen. De behöver inte analyseras om. I nästa pass körs för var och en `npx tsx src/cli.ts pass analys-in <domän> --datum 2026-10-12`: kommandot tolkar den sparade analysen med det nya schemat, kör kodkontrollerna och skriver nya verifieringspaket med den nya verifieringsprompten. Kör sedan verifieringsagenten på `data/pass/2026-10-12/<domän>` och fortsätt med `--datum 2026-10-12` på alla in-kommandon för de fyra sajterna, tills de är klara. Gör det före dagens nya sajter.

## 3. Discover, när kön är tom

Discover görs i sessionen: du söker själv med WebSearch, koden hämtar och kontrollerar kandidaterna, och en underagent förfiltrerar dem.

1. Välj ett oanvänt segment: `npx tsx src/cli.ts segment --lista`. Nio av tio platser går till kundtyp 2 och 3; välj kundtyp 1 bara om ett pass redan har nio sajter av kundtyp 2 och 3. Finns inget oanvänt segment skriver du nya segment i sessionen som en JSON-lista `[{kundtyp, yrke, ort, sokfras, motivering}]` enligt kundprofilen och läser in dem med `npx tsx src/cli.ts segment --fil <sökväg>`.
2. `npx tsx src/cli.ts pass discover-paket --segment <id> --antal 10 --sokningar 8`. Läs discover-system.md och discover-uppgift.md i mappen som skrivs ut. Följ dem: bara organisationernas egna sajter, inga kända domäner.
3. Sök med WebSearch på svenska, alltid med orten i frågan, och gör flera smala sökningar hellre än en bred: yrkesordet med orten, med grannkommuner, med ord som "hemsida", "kontakt", "boka", "medlem", "kansli", samt yrkesvarianter. Högst så många sökningar som paketet anger. En domän får bara tas med om den står i ett sökresultat eller på en sida du har hämtat. Gissa aldrig en adress utifrån ett namn.
4. Katalogvägen: sök också efter medlemslistor, register och förteckningar för segmentet (branschorganisationer, föreningsregister, kommunens föreningsregister, stiftelseregister). För varje sådan sida, kör `pass discover-katalog --segment <id> --url <adress> --varfor "medlem i ..."`. Koden hämtar sidan och lägger de webbplatser den länkar till i traffar.json med hittad_via satt till katalogen.
5. Skriv sökträffarna som en JSON-lista `[{"namn": ..., "url": ..., "varfor": ..., "hittad_via": ...}]` till `traffar.json` i mappen (lägg till i listan om katalogvägen redan har skrivit dit). `hittad_via` är sökresultatets adress när resultatet pekar på sajten själv, annars den sida där du såg länken.
6. `pass discover-in --segment <id>`. Koden avvisar domäner som inte kommer från ett sökresultat eller en hämtad sida, sparar resten i soktraffar, hämtar varje kandidat och kör förfiltrets kodregler. Kandidater som klarar koden får filer i undermappen `forfilter/`.
7. Starta `granskaren-forfilter` (claude-haiku-4-5-20251001) på mappen `forfilter/`. Gör modellkontrollen (`--steg forfilter`). Kör sedan `pass forfilter-in --segment <id>`. Godkända blir prospekt med status ny. Tecken på anställda (kansli, personalsida, namngivna roller, växelnummer, funktionsadresser) är pluspoäng; likhet med förebilderna väljer inte bort någon.
8. Kör `pass forbered` igen för de nya prospekten och fortsätt med avsnitt 2.

## 4. Utskick

Inget skickas i passet. Med `SANDLAGE=granska` hamnar alla mejl i granskningskön. När passet är klart ber Rawaz om mejlen, och då går det så här:

1. `npx tsx src/cli.ts review --lista` skriver ut varje mejl i sin helhet med id, mottagare och ämnesrad. Visa dem för Rawaz som de är och fråga för vart och ett om det ska godkännas, ändras eller kastas. Det här är det enda tillfället då du läser mejltext.
2. `npx tsx src/cli.ts review --godkann <id...> --orsak "godkänt av Rawaz <datum>"` köar de godkända. `review --kasta <id...> --orsak "<varför>"` kastar. Ett mejl som ska ändras skrivs om i databasen enligt Rawaz anvisning och visas igen innan det godkänns.
3. `npx tsx src/cli.ts send` skickar de köade mejlen med slumpad paus (PAUS_MIN_MINUTER till PAUS_MAX_MINUTER) inom sändfönstret, högst MAX_MEJL_PER_DAG per dag. Kör det i bakgrunden med loggen till `data/logg/send-<datum>.log` och rapportera när det är klart. Utskicket startas bara när Rawaz säger det.

`SAND_PAUSAD=true` stänger kön helt; då ligger köade mejl kvar tills Rawaz sätter false.

## 5. Efter passet

1. `pass status` och visa raderna: per sajt steg, försök och utfall, samt tokenstabellen (antal sajter, antal mejl, tokens per sajt uppdelat på analys, verifiering och utkast).
2. `npx tsx src/cli.ts pass api-kontroll --sedan <numret från steg 0>`. Det ska stå 0 API-anrop. Visa raden för Rawaz.
3. Be Rawaz läsa av `/usage` igen, båda värdena, och kör `npx tsx src/cli.ts pass kvot --efter <session> --vecka <vecka> --kommentar "<plan, antal agenter samtidigt>"`. Kommandot loggar förbrukningen per sajt för sessionen och veckan i data/jamforelse/kvot-logg.csv och visar snitten över alla pass, hur många sajter som ryms i en session och hur många pass veckan räcker till. Visa raden för Rawaz. Snittet styr antalet sajter i nästa pass (steg 0).

## Mätpass på två sajter

Första passet på en ny plan eller efter en större ändring körs som mätpass: `/dagens <session kvar> <vecka kvar> 2` i en ny session utan annat arbete. Allt annat är som vanligt. Efter passet ger `pass kvot --efter` förbrukningen per sajt, och det talet används för att sätta antalet sajter i kommande pass.

## Om sessionsgränsen slår till

En underagent som avbryts med "session limit" (429) har inte skrivit sin resultatfil. Starta då inga fler underagenter. Lämna arbetspaketen som de är, kör `pass status`, och säg till Rawaz vilket klockslag gränsen återställs (står i felet). Efter återställningen fortsätter passet med samma kommandon från det steg statusen visar; paketen behöver inte skrivas om.

## Om sessionen stängs mitt i

Allt läge finns på disk och i databasen: arbetspaketen med statusfiler, fynd och verifiering i databasen, mejl i granskningskön. Starta en ny session, skriv /dagens igen och börja på steg 0. `pass status` visar var varje sajt står och passet fortsätter därifrån. Ett steg som avbröts innan dess in-kommando kördes görs om från det steget. Utskicket kan inte dubbleras: databasen tillåter bara ett förstamejl per domän.

## Fördjupad analys på begäran

När en organisation har svarat kan Rawaz be om den fullständiga analysen: `npx tsx src/cli.ts fordjupa <domän>` skriver ett arbetspaket i `data/fordjupning/<domän>/`, du startar `granskaren-analys` på den mappen, och `npx tsx src/cli.ts fordjupa-in <domän>` skriver rapporten `data/rapporter/<domän>-fordjupning.md`. Det ingår inte i ett vanligt pass.
