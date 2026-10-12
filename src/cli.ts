import fs from "node:fs";
import { Command } from "commander";
import { KostnadstakError, kostnadstak } from "./analyze/klient.js";
import { granskaProspekt } from "./audit.js";
import { konfig } from "./config.js";
import { db } from "./db/index.js";
import { allaProspekt, hamtaProspektViaDoman, kostnadDennaManad, laggTillSparr, loggaHandelse, prospektMedStatus, sattStatus } from "./db/fragor.js";
import { importeraFil } from "./discover/import.js";
import { rapportSokvag } from "./report/rapport.js";
import { review } from "./email/review.js";
import { skapaUtkast } from "./email/utkast.js";
import { skickadeMejl, skickaKoade, skickaTest } from "./email/skicka.js";
import { profileraForebilder } from "./discover/forebilder.js";
import { allaSegment, importeraSegment, SegmentListaSchema, skapaSegment } from "./discover/segment.js";
import { discover } from "./discover/discover.js";
import { utfallPerKundtyp, weekly } from "./report/weekly.js";
import { avbrytPaus, pausad, tillampaPaus } from "./report/vakt.js";
import {
  analysIn,
  apiAnvandningSedan,
  discoverIn,
  discoverKatalog,
  discoverPaket,
  forbered,
  forfilterIn,
  grindIn,
  idag as passIdag,
  passMapp,
  senasteKostnadId,
  statusRader,
  utkastIn,
  utkastPaket,
  verifieringIn,
} from "./pass/pass.js";
import { kvotEfter, kvotFore, kvotSammanfattning, kvotSnitt, lasKvotLogg } from "./pass/kvot.js";
import { kontrolleraModell, MODELL_PER_STEG } from "./pass/modell.js";
import { fordjupaIn, fordjupaPaket } from "./pass/fordjupa.js";
import { sparaTokens, tokenRader, type Tokensteg } from "./pass/pass.js";
import { run } from "./run.js";
import { normaliseraDoman } from "./util/domain.js";
import { logg } from "./util/logg.js";

const program = new Command();
program.name("granskaren").description("Webbgranskning och personlig outreach för RK Kommunikation").version("0.1.0");

program
  .command("import")
  .argument("<fil>", "CSV-fil med kolumnerna url, namn, bransch, ort, kommentar")
  .description("Läser in en lista med sajter")
  .action((fil: string) => {
    konfig();
    const d = db();
    const r = importeraFil(d, fil);
    logg.info(`Tillagda: ${r.tillagda.length}, dubbletter: ${r.dubbletter.length}, ogiltiga: ${r.ogiltiga.length}`);
    for (const x of r.tillagda) console.log(`  + ${x}`);
    for (const x of r.dubbletter) console.log(`  = ${x} (fanns redan)`);
    for (const x of r.ogiltiga) console.log(`  ! ${x} (ogiltig adress)`);
  });

program
  .command("audit")
  .description("Hämtar, mäter, analyserar och verifierar sajter med status ny eller kvalificerad")
  .option("--antal <n>", "högsta antal sajter att granska", "5")
  .option("--doman <doman>", "granska bara den här domänen")
  .option("--igen", "granska om även sajter som redan är granskade eller hoppade", false)
  .option("--utan-modell", "hämta och mät men hoppa över analys med språkmodell", false)
  .option("--utan-lighthouse", "hoppa över Lighthouse (snabbare)", false)
  .action(async (o: { antal: string; doman?: string; igen: boolean; utanModell: boolean; utanLighthouse: boolean }) => {
    konfig();
    const d = db();
    tillampaPaus(d);
    const antal = Math.max(1, Number.parseInt(o.antal, 10) || 5);
    let lista;
    if (o.doman) {
      const dom = normaliseraDoman(o.doman);
      const p = dom ? hamtaProspektViaDoman(d, dom) : undefined;
      if (!p) {
        logg.fel(`Domänen ${o.doman} finns inte i databasen. Importera den först.`);
        process.exitCode = 1;
        return;
      }
      if (!o.igen && !["ny", "kvalificerad"].includes(p.status)) {
        logg.fel(`${p.doman} har status ${p.status}. Använd --igen för att granska om.`);
        process.exitCode = 1;
        return;
      }
      lista = [p];
    } else {
      lista = prospektMedStatus(d, o.igen ? ["ny", "kvalificerad", "granskad", "hoppad"] : ["ny", "kvalificerad"], antal);
    }
    if (lista.length === 0) {
      logg.info("Inga sajter att granska. Importera en lista först.");
      return;
    }
    logg.info(`${lista.length} sajt(er) att granska`);
    const utfall = { granskad: 0, hoppad: 0, fel: 0 };
    for (const p of lista) {
      try {
        const r = await granskaProspekt(d, p, { utanModell: o.utanModell, utanLighthouse: o.utanLighthouse });
        utfall[r]++;
      } catch (e) {
        utfall.fel++;
        const msg = e instanceof Error ? e.message : String(e);
        logg.fel(`${p.doman}: ${msg}`);
        loggaHandelse(d, p.id, "fel", msg);
        if (e instanceof KostnadstakError) break;
      }
    }
    logg.info(`Klart. Granskade: ${utfall.granskad}, hoppade: ${utfall.hoppad}, fel: ${utfall.fel}`);
  });

program
  .command("draft")
  .description("Skriver mejlutkast för granskade sajter")
  .option("--antal <n>", "högsta antal utkast", "5")
  .option("--doman <doman>", "bara den här domänen")
  .option("--test-till <adress>", "skicka utkastet till den här adressen i stället för organisationens (testläge)")
  .action(async (o: { antal: string; doman?: string; testTill?: string }) => {
    konfig();
    const d = db();
    tillampaPaus(d);
    let lista;
    if (o.doman) {
      const dom = normaliseraDoman(o.doman);
      const p = dom ? hamtaProspektViaDoman(d, dom) : undefined;
      if (!p) {
        logg.fel(`Domänen ${o.doman} finns inte i databasen.`);
        process.exitCode = 1;
        return;
      }
      if (!["granskad", "utkast", "i_granskning"].includes(p.status)) {
        logg.fel(`${p.doman} har status ${p.status}. Granska den först med audit.`);
        process.exitCode = 1;
        return;
      }
      lista = [p];
    } else {
      lista = prospektMedStatus(d, "granskad", Math.max(1, Number.parseInt(o.antal, 10) || 5));
    }
    if (lista.length === 0) {
      logg.info("Inga granskade sajter utan utkast.");
      return;
    }
    let skapade = 0;
    for (const p of lista) {
      try {
        const u = await skapaUtkast(d, p, { testTill: o.testTill });
        if (u) skapade++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logg.fel(`${p.doman}: ${msg}`);
        loggaHandelse(d, p.id, "fel", msg);
        if (e instanceof KostnadstakError) break;
      }
    }
    logg.info(`Klart. ${skapade} utkast skapade. Gå igenom dem med: granskaren review`);
  });

program
  .command("review")
  .description("Går igenom granskningskön, ett utkast i taget")
  .action(async () => {
    konfig();
    await review(db());
  });

program
  .command("forebilder")
  .description("Profilerar förebilderna i prompts/kundprofil.md och lägger dem på spärrlistan som befintliga kunder")
  .option("--igen", "profilera om även redan profilerade", false)
  .action(async (o: { igen: boolean }) => {
    konfig();
    const r = await profileraForebilder(db(), { igen: o.igen });
    logg.info(`Klart. Profilerade: ${r.profilerade}, hoppade: ${r.hoppade}, fel: ${r.fel}`);
  });

program
  .command("segment")
  .description("Tar fram kombinationer av yrke eller bransch och ort per kundtyp enligt fördelningen")
  .option("--antal <n>", "antal nya segment (bara via API)", "12")
  .option("--lista", "visa befintliga segment i stället för att skapa nya", false)
  .option("--fil <sokvag>", "läs in segment från en JSON-lista [{kundtyp, yrke, ort, sokfras, motivering}] skriven i sessionen")
  .action(async (o: { antal: string; lista: boolean; fil?: string }) => {
    konfig();
    const d = db();
    if (o.lista) {
      for (const s of allaSegment(d)) console.log(`${String(s.id).padStart(3)}  kundtyp ${s.kundtyp}  ${s.yrke} i ${s.ort}  "${s.sokfras}"  ${s.anvand ? `använt, ${s.traffar} träffar` : "oanvänt"}`);
      return;
    }
    if (o.fil) {
      const nya = importeraSegment(d, SegmentListaSchema.parse(JSON.parse(fs.readFileSync(o.fil, "utf8"))));
      for (const s of nya) console.log(`${String(s.id).padStart(3)}  kundtyp ${s.kundtyp}  ${s.yrke} i ${s.ort}  "${s.sokfras}"`);
      logg.info(`Klart. ${nya.length} nya segment inlästa.`);
      return;
    }
    const nya = await skapaSegment(d, Math.max(1, Number.parseInt(o.antal, 10) || 12));
    logg.info(`Klart. ${nya.length} nya segment. Kör granskaren discover för att söka.`);
  });

program
  .command("discover")
  .description("Hittar nya sajter via webbsökning och förebildernas länkar, förfiltrerar och lägger in godkända som prospekt")
  .option("--antal <n>", "önskat antal godkända prospekt", "10")
  .option("--kalla <kallor>", "källor i ordning, kommaseparerat: webb, lankar", "webb,lankar")
  .option("--kundtyp <n>", "bara den här kundtypen")
  .option("--segment <id>", "använd ett visst segment")
  .action(async (o: { antal: string; kalla: string; kundtyp?: string; segment?: string }) => {
    konfig();
    const r = await discover(db(), {
      antal: Math.max(1, Number.parseInt(o.antal, 10) || 10),
      kallor: o.kalla.split(",").map((s) => s.trim()).filter(Boolean),
      kundtyp: o.kundtyp ? Number.parseInt(o.kundtyp, 10) : undefined,
      segmentId: o.segment ? Number.parseInt(o.segment, 10) : undefined,
    });
    logg.info(`Nya prospekt: ${r.godkanda}. Granska dem med: granskaren audit`);
  });

program
  .command("weekly")
  .description("Veckorapport per kundtyp och förslag på ny fördelning utifrån svar")
  .option("--justera", "spara den föreslagna fördelningen", false)
  .action((o: { justera: boolean }) => {
    konfig();
    for (const rad of weekly(db(), { justera: o.justera })) console.log(rad);
  });

program
  .command("send")
  .description("Skickar köade mejl inom tidsfönster och dagligt tak. Vid TORRKORNING=true skrivs filer i data/torrkorning/")
  .option("--max <n>", "högsta antal att skicka i den här körningen")
  .option("--test-till <adress>", "skicka ett utkast som test till den här adressen, utan att röra kön eller torrkörningen")
  .option("--doman <doman>", "vilket utkast som ska testskickas (annars det senaste i kön)")
  .action(async (o: { max?: string; testTill?: string; doman?: string }) => {
    konfig();
    const d = db();
    if (o.testTill) {
      let rad: { id: number } | undefined;
      if (o.doman) {
        const dom = normaliseraDoman(o.doman);
        const p = dom ? hamtaProspektViaDoman(d, dom) : undefined;
        if (!p) {
          logg.fel(`Domänen ${o.doman} finns inte i databasen.`);
          process.exitCode = 1;
          return;
        }
        rad = d.prepare("SELECT id FROM mejl WHERE prospekt_id = ? AND typ = 'forsta' ORDER BY id DESC LIMIT 1").get(p.id) as { id: number } | undefined;
      } else {
        rad = d.prepare("SELECT id FROM mejl WHERE status IN ('koad', 'i_granskning', 'utkast') ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
      }
      if (!rad) {
        logg.fel("Inget utkast att testskicka. Kör draft först.");
        process.exitCode = 1;
        return;
      }
      await skickaTest(d, rad.id, o.testTill);
      return;
    }
    const r = await skickaKoade(d, { max: o.max ? Number.parseInt(o.max, 10) : undefined });
    logg.info(`Klart. Skickade: ${r.skickade}, torrkörda: ${r.torrkorda}, stoppade: ${r.stoppade}`);
  });

program
  .command("run")
  .description("Helautomatisk dag: letar prospekt, granskar, skriver utkast och skickar med slumpade pauser tills taket eller fönstret är nått")
  .option("--en-gang", "kör ett varv och avsluta", false)
  .option("--utan-discover", "leta inte nya prospekt", false)
  .action(async (o: { enGang: boolean; utanDiscover: boolean }) => {
    konfig();
    await run(db(), { enGang: o.enGang, utanDiscover: o.utanDiscover });
  });

// ---------- pass: dagens körning i etapper utan API ----------

const pass = program
  .command("pass")
  .description("Dagens körning i etapper utan API: verktyget hämtar, mäter, kontrollerar och skickar, underagenter i en Claude-session gör modellstegen. Kör med MODELLVAG=session i miljön.");

function passStart(): { d: ReturnType<typeof db>; datum: string } {
  const k = konfig();
  if (k.TILLAT_API || process.env.ANTHROPIC_API_KEY) logg.varning("TILLAT_API är true eller API-nyckeln finns i miljön. Passet ska köras utan API: sätt TILLAT_API=false i .env.");
  return { d: db(), datum: "" };
}

function skrivInUtfall(doman: string, u: import("./pass/pass.js").InUtfall): void {
  if (u.ok) {
    console.log(`UTFALL ok ${doman} nasta=${u.nasta}  ${u.meddelande}`);
    return;
  }
  console.log(`UTFALL ${u.nyttForsok ? "nytt_forsok" : "avbrutet"} ${doman}  ${u.fel}`);
  process.exitCode = u.nyttForsok ? 2 : 3;
}

pass
  .command("forbered")
  .description("Etapp a: hämtning, mätning och arbetspaket per sajt i data/pass/<datum>/<domän>/")
  .option("--datum <d>", "passets datum, YYYY-MM-DD", passIdag())
  .option("--sajter <lista>", "bara dessa domäner, kommaseparerat (annars sajter med status ny eller kvalificerad)")
  .option("--antal <n>", "högsta antal sajter", "8")
  .option("--befintligt-underlag", "använd sparat underlag i stället för att hämta om sajterna", false)
  .option("--utan-lighthouse", "hoppa över Lighthouse", false)
  .action(async (o: { datum: string; sajter?: string; antal: string; befintligtUnderlag: boolean; utanLighthouse: boolean }) => {
    const { d } = passStart();
    const lista = await forbered(d, {
      datum: o.datum,
      sajter: o.sajter ? o.sajter.split(",").map((s) => normaliseraDoman(s.trim()) ?? s.trim()).filter(Boolean) : undefined,
      antal: Math.max(1, Number.parseInt(o.antal, 10) || 8),
      befintligtUnderlag: o.befintligtUnderlag,
      utanLighthouse: o.utanLighthouse,
    });
    for (const rad of statusRader(o.datum)) console.log(rad);
    console.log(`Arbetspaket: ${lista.filter((s) => s.steg === "forberedd").length} förberedda, ${lista.filter((s) => s.steg === "hoppad").length} hoppade. Mapp: ${passMapp(o.datum)}`);
  });

pass
  .command("analys-in <doman>")
  .description("Läser analys.json från underagenten, sparar fynd, kör kodkontrollerna och skriver verifieringspaket")
  .option("--datum <d>", "passets datum", passIdag())
  .action((doman: string, o: { datum: string }) => {
    const { d } = passStart();
    skrivInUtfall(doman, analysIn(d, o.datum, normaliseraDoman(doman) ?? doman));
  });

pass
  .command("verifiering-in <doman>")
  .description("Läser verifiering.json, slår ihop med kodkontrollen, avslutar granskningen och skriver utkastpaket")
  .option("--datum <d>", "passets datum", passIdag())
  .action((doman: string, o: { datum: string }) => {
    const { d } = passStart();
    skrivInUtfall(doman, verifieringIn(d, o.datum, normaliseraDoman(doman) ?? doman));
  });

pass
  .command("utkast-paket <doman>")
  .description("Skriver ett utkastpaket för ett redan granskat prospekt utan ny analys, till exempel efter en regeländring i mejlprompten")
  .option("--igen", "även om prospektet redan har ett köat eller skickat mejl", false)
  .option("--datum <d>", "passets datum", passIdag())
  .action((doman: string, o: { igen: boolean; datum: string }) => {
    const { d } = passStart();
    skrivInUtfall(doman, utkastPaket(d, o.datum, normaliseraDoman(doman) ?? doman, o.igen));
  });

pass
  .command("utkast-in <doman>")
  .description("Läser utkast.json, kör grindens kodkontroller och skriver grindpaket, eller begär nytt utkast")
  .option("--datum <d>", "passets datum", passIdag())
  .action((doman: string, o: { datum: string }) => {
    const { d } = passStart();
    skrivInUtfall(doman, utkastIn(d, o.datum, normaliseraDoman(doman) ?? doman));
  });

pass
  .command("grind-in <doman>")
  .description("Läser grind.json, avgör utfallet och sparar mejlet i kön, granskningskön eller som stoppat")
  .option("--datum <d>", "passets datum", passIdag())
  .action((doman: string, o: { datum: string }) => {
    const { d } = passStart();
    skrivInUtfall(doman, grindIn(d, o.datum, normaliseraDoman(doman) ?? doman));
  });

pass
  .command("status")
  .description("Visar var varje sajt i passet står, och tokens per sajt och steg")
  .option("--datum <d>", "passets datum", passIdag())
  .action((o: { datum: string }) => {
    konfig();
    for (const rad of statusRader(o.datum)) console.log(rad);
    for (const rad of tokenRader(o.datum)) console.log(rad);
  });

pass
  .command("tokens <doman>")
  .description("Antecknar hur många tokens en underagent drog för ett steg (talet subagent_tokens i Agent-verktygets svar)")
  .requiredOption("--steg <steg>", "analys, verifiering, utkast eller grind")
  .requiredOption("--antal <n>", "antal tokens")
  .option("--datum <d>", "passets datum", passIdag())
  .action((doman: string, o: { steg: string; antal: string; datum: string }) => {
    konfig();
    const t = sparaTokens(o.datum, normaliseraDoman(doman) ?? doman, o.steg as Tokensteg, Number.parseInt(o.antal, 10) || 0);
    console.log(`TOKENS ${doman} ${Object.entries(t).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  });

pass
  .command("discover-paket")
  .description("Skriver uppgiften till webbsökningen för ett segment. Sessionen söker och sparar träffarna i traffar.json i samma mapp")
  .requiredOption("--segment <id>", "segmentets id")
  .option("--antal <n>", "önskat antal träffar", "10")
  .option("--sokningar <n>", "högsta antal sökningar i sessionen", "8")
  .option("--datum <d>", "passets datum", passIdag())
  .action((o: { segment: string; antal: string; sokningar: string; datum: string }) => {
    const { d } = passStart();
    const r = discoverPaket(d, o.datum, Number.parseInt(o.segment, 10), Math.max(1, Number.parseInt(o.antal, 10) || 10), Math.max(1, Number.parseInt(o.sokningar, 10) || 8));
    console.log(
      `Uppgift i ${r.mapp}: discover-system.md och discover-uppgift.md. Högst ${r.maxSok} sökningar, ${r.antal} träffar. Skriv träffarna som JSON-lista [{namn, url, varfor, hittad_via}] i traffar.json i mappen. hittad_via är sökresultatets adress eller sidan där domänen hittades. Gissa aldrig en adress.`,
    );
  });

pass
  .command("discover-katalog")
  .description("Katalogvägen: hämtar en medlemslista eller ett register och lägger de webbplatser den länkar till i traffar.json")
  .requiredOption("--segment <id>", "segmentets id")
  .requiredOption("--url <adress>", "katalogsidans adress")
  .option("--varfor <text>", "motivering som sätts på träffarna")
  .option("--datum <d>", "passets datum", passIdag())
  .action(async (o: { segment: string; url: string; varfor?: string; datum: string }) => {
    const { d } = passStart();
    const r = await discoverKatalog(d, o.datum, Number.parseInt(o.segment, 10), o.url, o.varfor);
    console.log(`${r.lankar} externa länkar, ${r.nya} nya träffar tillagda i ${r.fil}`);
  });

pass
  .command("discover-in")
  .description("Läser träffarna, avvisar domäner som inte kommer från ett sökresultat eller en hämtad sida, sparar i soktraffar, hämtar kandidaterna, kör förfiltrets kodregler och skriver förfilterpaket")
  .requiredOption("--segment <id>", "segmentets id")
  .option("--fil <sokvag>", "fil med träffarna (annars traffar.json i segmentets mapp)")
  .option("--datum <d>", "passets datum", passIdag())
  .action(async (o: { segment: string; fil?: string; datum: string }) => {
    const { d } = passStart();
    const r = await discoverIn(d, o.datum, Number.parseInt(o.segment, 10), o.fil);
    console.log(`Träffar: ${r.traffar}, avvisade: ${r.avvisade.length}, bortvalda av kod: ${r.bortvaldaAvKod}, till förfilter: ${r.tillForfilter.length}${r.tillForfilter.length ? ` (${r.tillForfilter.join(", ")})` : ""}`);
  });

pass
  .command("forfilter-in")
  .description("Läser underagentens förfiltersvar och lägger godkända kandidater som prospekt")
  .requiredOption("--segment <id>", "segmentets id")
  .option("--datum <d>", "passets datum", passIdag())
  .action((o: { segment: string; datum: string }) => {
    const { d } = passStart();
    const r = forfilterIn(d, o.datum, Number.parseInt(o.segment, 10));
    console.log(`Godkända: ${r.godkanda.length}${r.godkanda.length ? ` (${r.godkanda.join("; ")})` : ""}. Bortvalda: ${r.bortvalda.length}. Utan giltigt svar: ${r.saknas.length}${r.saknas.length ? ` (${r.saknas.join("; ")})` : ""}`);
  });

pass
  .command("api-kontroll")
  .description("Visar senaste raden i kostnadsloggen, och med --sedan hur många API-anrop som loggats efter den")
  .option("--sedan <id>", "kostnadsrad att räkna från")
  .action((o: { sedan?: string }) => {
    const k = konfig();
    const d = db();
    const nyckel = process.env.ANTHROPIC_API_KEY ? "INLÄST" : "inte inläst";
    if (o.sedan) {
      const r = apiAnvandningSedan(d, Number.parseInt(o.sedan, 10));
      console.log(`TILLAT_API=${k.TILLAT_API}, MODELLVAG=${k.MODELLVAG}, ANTHROPIC_API_KEY ${nyckel}. API-anrop loggade efter rad ${o.sedan}: ${r.anrop} (${r.usd.toFixed(4)} USD).`);
      return;
    }
    console.log(`TILLAT_API=${k.TILLAT_API}, MODELLVAG=${k.MODELLVAG}, ANTHROPIC_API_KEY ${nyckel}. Senaste kostnadsrad: ${senasteKostnadId(d)}.`);
  });

pass
  .command("modellkontroll")
  .description("Läser ur underagentens transkript vilken modell som faktiskt kördes och jämför med den som steget kräver. Avviker den ska passet avbrytas")
  .requiredOption("--steg <steg>", `ett av ${Object.keys(MODELL_PER_STEG).join(", ")}`)
  .requiredOption("--agent <id>", "agentens id från Agent-verktygets svar")
  .action((o: { steg: string; agent: string }) => {
    const r = kontrolleraModell(o.steg, o.agent);
    console.log(`MODELL ${r.ok ? "ok" : "avvikelse"} ${r.steg}  ${r.meddelande}`);
    if (!r.ok) process.exitCode = 3;
  });

pass
  .command("kvot")
  .description("Kvotmätning: --fore <session> --vecka <vecka> sparar andel kvar av femtimmarssessionen och veckan när passet börjar, --efter <session> --vecka <vecka> loggar förbrukningen per sajt för båda i data/jamforelse/kvot-logg.csv och visar snitten")
  .option("--fore <andel>", "andel kvar av sessionen före passet, i procent")
  .option("--efter <andel>", "andel kvar av sessionen efter passet, i procent")
  .option("--vecka <andel>", "andel kvar av veckan vid samma avläsning, i procent")
  .option("--kommentar <text>", "anteckning på raden, till exempel plan eller antal agenter", "")
  .option("--datum <d>", "passets datum", passIdag())
  .action((o: { fore?: string; efter?: string; vecka?: string; kommentar: string; datum: string }) => {
    konfig();
    if (o.fore !== undefined || o.efter !== undefined) {
      if (o.vecka === undefined) throw new Error("Ange också --vecka <andel kvar av veckan>, båda värdena står i /usage.");
      const avlasning = { session: Number(o.fore ?? o.efter), vecka: Number(o.vecka) };
      if (o.fore !== undefined) {
        const fil = kvotFore(o.datum, avlasning);
        console.log(`Sparat före passet: ${avlasning.session} procent kvar av sessionen, ${avlasning.vecka} av veckan (${fil}).`);
        console.log(kvotSammanfattning(kvotSnitt(), avlasning));
        return;
      }
      const r = kvotEfter(o.datum, avlasning, o.kommentar);
      console.log(
        `Passet ${r.rad.datum}: ${r.rad.sajter} sajter (${r.rad.klara} klara). Sessionen ${r.rad.fore.session} -> ${r.rad.efter.session} procent kvar, förbrukning ${r.rad.forbrukning.session} procentenheter, ${r.rad.per_sajt.session} per sajt. Veckan ${r.rad.fore.vecka} -> ${r.rad.efter.vecka} procent kvar, förbrukning ${r.rad.forbrukning.vecka} procentenheter, ${r.rad.per_sajt.vecka} per sajt. Loggat i ${r.fil}.`,
      );
      console.log(kvotSammanfattning(r.snitt, avlasning));
      return;
    }
    const alla = lasKvotLogg();
    if (!alla.length) console.log("Ingen kvotlogg ännu.");
    for (const r of alla) {
      console.log(`${r.datum}: ${r.sajter} sajter, session ${r.fore.session} -> ${r.efter.session} (${r.per_sajt.session} per sajt), vecka ${r.fore.vecka} -> ${r.efter.vecka} (${r.per_sajt.vecka} per sajt)${r.kommentar ? ` (${r.kommentar})` : ""}`);
    }
    if (alla.length) console.log(kvotSammanfattning(kvotSnitt(alla), { session: 100, vecka: 100 }));
  });

program
  .command("fordjupa <doman>")
  .description("Skriver arbetspaketet för den fördjupade analysen (huvudinsikt, åtgärdslista, rapport) för en sajt som har svarat. Körs bara på begäran. En underagent granskaren-analys skriver analys.json i mappen, sedan: granskaren fordjupa-in <domän>")
  .action((doman: string) => {
    konfig();
    const r = fordjupaPaket(db(), normaliseraDoman(doman) ?? doman);
    console.log(`Arbetspaket för fördjupad analys i ${r.mapp}${r.skarmbild ? ` (skärmbild ${r.skarmbild})` : ""}. Starta granskaren-analys på mappen och kör sedan: granskaren fordjupa-in ${doman}`);
  });

program
  .command("fordjupa-in <doman>")
  .description("Läser analys.json från den fördjupade analysen, kontrollerar beläggen med kod och skriver data/rapporter/<domän>-fordjupning.md")
  .action((doman: string) => {
    konfig();
    const r = fordjupaIn(db(), normaliseraDoman(doman) ?? doman);
    if (!r.ok) {
      console.log(`UTFALL nytt_forsok ${doman}  ${r.fel}`);
      process.exitCode = 2;
      return;
    }
    console.log(`UTFALL ok ${doman}  ${r.fynd} fynd, ${r.bekraftade} med kodbekräftade belägg. Rapport: ${r.rapport}`);
  });

program
  .command("paus")
  .description("Visar om kvalitetsvakten har pausat ändringarna, och tar bort pausen med --av")
  .option("--av", "ta bort pausen så att inställningarna i .env gäller igen", false)
  .action((o: { av: boolean }) => {
    konfig();
    const d = db();
    const p = pausad(d);
    if (o.av) {
      logg.info(avbrytPaus(d) ? "Pausen är borttagen. Inställningarna i .env gäller från nästa körning." : "Ingen paus att ta bort.");
      return;
    }
    if (!p) {
      logg.info("Ingen paus. Inställningarna i .env gäller.");
      return;
    }
    logg.info(`Ändringarna är pausade sedan ${p.datum}: ${p.skal.join("; ")}. Ta bort pausen med: granskaren paus --av`);
  });

program
  .command("skickade")
  .description("Visar mejl som faktiskt har skickats i skarpt läge")
  .option("--doman <doman>", "visa hela mejlet till den här domänen")
  .action((o: { doman?: string }) => {
    konfig();
    const d = db();
    if (o.doman) {
      const dom = normaliseraDoman(o.doman) ?? o.doman;
      const lista = skickadeMejl(d, dom);
      if (lista.length === 0) {
        logg.info(`Inget skarpt skickat mejl till ${dom}.`);
        return;
      }
      for (const m of lista) {
        console.log(`Skickat: ${m.skickad}\nTill: ${m.mottagare}\nMessage-ID: ${m.message_id}\nÄmne: ${m.amne}\n\n${m.text}`);
      }
      return;
    }
    const lista = skickadeMejl(d);
    if (lista.length === 0) {
      logg.info("Inga skarpt skickade mejl ännu. Testmejl och torrkörningar räknas inte.");
      return;
    }
    console.log(`${"Skickat".padEnd(20)} ${"Domän".padEnd(26)} ${"Till".padEnd(34)} Ämne`);
    for (const m of lista) console.log(`${(m.skickad ?? "").padEnd(20)} ${m.doman.padEnd(26)} ${(m.mottagare ?? "").padEnd(34)} ${m.amne}`);
    console.log(`\nKopior finns i data/skickade/. Hela texten: granskaren skickade --doman <domän>`);
  });

program
  .command("report")
  .argument("<doman>", "domän")
  .description("Skriver ut rapporten för en sajt")
  .action((doman: string) => {
    const dom = normaliseraDoman(doman) ?? doman;
    const fil = rapportSokvag(dom);
    if (!fs.existsSync(fil)) {
      logg.fel(`Ingen rapport för ${dom}. Kör granskaren audit --doman ${dom} först.`);
      process.exitCode = 1;
      return;
    }
    console.log(fs.readFileSync(fil, "utf8"));
    console.error(`\nRapporten finns i ${fil}`);
  });

program
  .command("block")
  .argument("<varde>", "domän eller mejladress")
  .option("--orsak <text>", "orsak", "manuellt tillagd")
  .description("Lägger till på spärrlistan")
  .action((varde: string, o: { orsak: string }) => {
    const d = db();
    const v = varde.includes("@") ? varde.toLowerCase().trim() : (normaliseraDoman(varde) ?? varde.toLowerCase().trim());
    const ny = laggTillSparr(d, v, o.orsak);
    const p = v.includes("@") ? undefined : hamtaProspektViaDoman(d, v);
    if (p) {
      sattStatus(d, p.id, "sparrad");
      loggaHandelse(d, p.id, "sparrad", o.orsak);
    }
    logg.info(ny ? `${v} tillagd på spärrlistan.` : `${v} fanns redan på spärrlistan.`);
  });

program
  .command("status")
  .description("Visar läget och mätpunkterna")
  .action(() => {
    const k = konfig();
    const d = db();
    const alla = allaProspekt(d);
    const per = new Map<string, number>();
    for (const p of alla) per.set(p.status, (per.get(p.status) ?? 0) + 1);
    const granskade = alla.filter((p) => p.granskad).length;
    const kost = d.prepare("SELECT COALESCE(SUM(kostnad_usd),0) AS s, COALESCE(SUM(tokens_in),0) AS i, COALESCE(SUM(tokens_ut),0) AS u FROM kostnader").get() as { s: number; i: number; u: number };
    const skickade = (d.prepare("SELECT COUNT(*) AS n FROM mejl WHERE typ='forsta' AND status='skickad'").get() as { n: number }).n;
    const svar = per.get("svar") ?? 0;
    const studs = per.get("studs") ?? 0;
    const sparr = (d.prepare("SELECT COUNT(*) AS n FROM sparrlista").get() as { n: number }).n;

    console.log(`Läge: ${k.SANDLAGE}, torrkörning: ${k.TORRKORNING ? "på" : "AV"}, modell: ${k.MODEL_ANALYS} / ${k.MODEL_SNABB}`);
    console.log("");
    console.log("Prospekt per status");
    for (const s of ["ny", "kvalificerad", "hoppad", "granskad", "utkast", "i_granskning", "koad", "skickad", "svar", "studs", "sparrad"]) {
      console.log(`  ${s.padEnd(14)} ${per.get(s) ?? 0}`);
    }
    console.log("");
    console.log("Mätpunkter");
    console.log(`  Granskade sajter        ${granskade}`);
    console.log(`  Skickade mejl           ${skickade}`);
    console.log(`  Svarsfrekvens           ${skickade ? `${Math.round((svar / skickade) * 100)} %` : "-"}`);
    console.log(`  Andel studsar           ${skickade ? `${Math.round((studs / skickade) * 100)} %` : "-"}`);
    console.log(`  Spärrlista              ${sparr}`);
    console.log(`  API-kostnad totalt      ${kost.s.toFixed(2)} USD (${kost.i} tokens in, ${kost.u} ut)`);
    console.log(`  Kostnad per granskad    ${granskade ? `${(kost.s / granskade).toFixed(3)} USD` : "-"}`);
    const tak = kostnadstak(d);
    console.log(`  Denna månad             ${tak ? `${tak.forbrukat.toFixed(2)} av ${tak.tak.toFixed(2)} USD${tak.natt ? " (TAKET ÄR NÅTT)" : ""}` : `${kostnadDennaManad(d).toFixed(2)} USD, inget tak satt`}`);
    const perTyp = utfallPerKundtyp(d);
    if (perTyp.some((r) => r.prospekt > 0)) {
      console.log("");
      console.log("Per kundtyp");
      console.log(`  ${"Kundtyp".padEnd(36)} ${"prosp".padStart(6)} ${"gransk".padStart(7)} ${"skick".padStart(6)} ${"svar".padStart(5)} ${"pos".padStart(4)}`);
      for (const r of perTyp) {
        console.log(`  ${`${r.kundtyp || "-"}. ${r.namn}`.padEnd(36)} ${String(r.prospekt).padStart(6)} ${String(r.granskade).padStart(7)} ${String(r.skickade).padStart(6)} ${String(r.svar).padStart(5)} ${String(r.positiva).padStart(4)}`);
      }
    }
    const hoppade = alla.filter((p) => p.status === "hoppad");
    if (hoppade.length) {
      console.log("");
      console.log("Hoppade sajter");
      for (const p of hoppade) console.log(`  ${p.doman}: ${p.orsak_hoppad}`);
    }
  });

program.parseAsync(process.argv).catch((e) => {
  logg.fel(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
