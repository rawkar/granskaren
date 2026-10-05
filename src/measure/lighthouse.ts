import fs from "node:fs";
import path from "node:path";
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";
import { chromium } from "playwright";

/** Sammanfattning av Lighthouse-körningen med mobilprofil. Nycklarna används som belägg. */
export interface LighthouseSammanfattning {
  url: string;
  lighthouse_version: string;
  poang_prestanda: number | null;
  poang_seo: number | null;
  poang_tillganglighet: number | null;
  poang_basta_praxis: number | null;
  lcp_ms: number | null;
  cls: number | null;
  fcp_ms: number | null;
  tbt_ms: number | null;
  speed_index_ms: number | null;
  sidvikt_kb: number | null;
  bilder_kb: number | null;
  bildbesparing_kb: number | null;
  bildbesparing_exempel: string[];
  klickytor_for_tata: boolean | null;
  textstorlek_for_liten: boolean | null;
  viewport_ok: boolean | null;
  dokumenttitel_ok: boolean | null;
  metabeskrivning_ok: boolean | null;
  lanktext_ok: boolean | null;
  indexerbar: boolean | null;
  kontrast_ok: boolean | null;
  http_status_ok: boolean | null;
  misslyckade_revisioner: { id: string; titel: string; varde: string | null }[];
  fel: string | null;
}

export async function korLighthouse(url: string, sparaTill?: string): Promise<LighthouseSammanfattning> {
  const tom: LighthouseSammanfattning = {
    url, lighthouse_version: "", poang_prestanda: null, poang_seo: null, poang_tillganglighet: null, poang_basta_praxis: null,
    lcp_ms: null, cls: null, fcp_ms: null, tbt_ms: null, speed_index_ms: null, sidvikt_kb: null, bilder_kb: null,
    bildbesparing_kb: null, bildbesparing_exempel: [], klickytor_for_tata: null, textstorlek_for_liten: null, viewport_ok: null,
    dokumenttitel_ok: null, metabeskrivning_ok: null, lanktext_ok: null, indexerbar: null, kontrast_ok: null, http_status_ok: null,
    misslyckade_revisioner: [], fel: null,
  };

  let chrome: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    chrome = await launch({
      chromePath: chromium.executablePath(),
      chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--lang=sv-SE"],
    });
    const resultat = await lighthouse(url, {
      port: chrome.port,
      output: "json",
      logLevel: "error",
      onlyCategories: ["performance", "seo", "accessibility", "best-practices"],
      locale: "sv",
    });
    if (!resultat) {
      tom.fel = "Lighthouse gav inget resultat";
      return tom;
    }
    const lhr = resultat.lhr;
    if (sparaTill) {
      fs.mkdirSync(path.dirname(sparaTill), { recursive: true });
      fs.writeFileSync(sparaTill, typeof resultat.report === "string" ? resultat.report : JSON.stringify(lhr), "utf8");
    }
    const a = lhr.audits;
    const num = (id: string): number | null => {
      const v = a[id]?.numericValue;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const ok = (id: string): boolean | null => {
      const s = a[id]?.score;
      return typeof s === "number" ? s >= 0.9 : null;
    };
    const kat = (id: string): number | null => {
      const s = lhr.categories[id]?.score;
      return typeof s === "number" ? Math.round(s * 100) : null;
    };

    const bildItems = ((a["uses-optimized-images"]?.details as { items?: Record<string, unknown>[] } | undefined)?.items ?? [])
      .concat((a["uses-responsive-images"]?.details as { items?: Record<string, unknown>[] } | undefined)?.items ?? [])
      .concat((a["modern-image-formats"]?.details as { items?: Record<string, unknown>[] } | undefined)?.items ?? []);
    const bildbesparing = bildItems.reduce((s, i) => s + (typeof i.wastedBytes === "number" ? i.wastedBytes : 0), 0);
    const bildExempel = [...new Set(bildItems.map((i) => String(i.url ?? "")).filter(Boolean))].slice(0, 5);

    const bytesItems = (a["total-byte-weight"]?.details as { items?: Record<string, unknown>[] } | undefined)?.items ?? [];
    const bilderBytes = bytesItems
      .filter((i) => /\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i.test(String(i.url ?? "")))
      .reduce((s, i) => s + (typeof i.totalBytes === "number" ? i.totalBytes : 0), 0);

    const misslyckade = Object.values(a)
      .filter((x) => typeof x.score === "number" && x.score < 0.5 && x.scoreDisplayMode !== "informative" && x.scoreDisplayMode !== "notApplicable")
      .map((x) => ({ id: x.id, titel: x.title, varde: x.displayValue ?? null }))
      .slice(0, 40);

    return {
      url,
      lighthouse_version: lhr.lighthouseVersion,
      poang_prestanda: kat("performance"),
      poang_seo: kat("seo"),
      poang_tillganglighet: kat("accessibility"),
      poang_basta_praxis: kat("best-practices"),
      lcp_ms: avr(num("largest-contentful-paint")),
      cls: num("cumulative-layout-shift") !== null ? Math.round(num("cumulative-layout-shift")! * 1000) / 1000 : null,
      fcp_ms: avr(num("first-contentful-paint")),
      tbt_ms: avr(num("total-blocking-time")),
      speed_index_ms: avr(num("speed-index")),
      sidvikt_kb: num("total-byte-weight") !== null ? Math.round(num("total-byte-weight")! / 1024) : null,
      bilder_kb: Math.round(bilderBytes / 1024),
      bildbesparing_kb: Math.round(bildbesparing / 1024),
      bildbesparing_exempel: bildExempel,
      klickytor_for_tata: ok("tap-targets") === null ? null : !ok("tap-targets"),
      textstorlek_for_liten: ok("font-size") === null ? null : !ok("font-size"),
      viewport_ok: ok("viewport"),
      dokumenttitel_ok: ok("document-title"),
      metabeskrivning_ok: ok("meta-description"),
      lanktext_ok: ok("link-text"),
      indexerbar: ok("is-crawlable"),
      kontrast_ok: ok("color-contrast"),
      http_status_ok: ok("http-status-code"),
      misslyckade_revisioner: misslyckade,
      fel: null,
    };
  } catch (e) {
    tom.fel = e instanceof Error ? e.message : String(e);
    return tom;
  } finally {
    try {
      chrome?.kill();
    } catch {
      // redan nere
    }
  }
}

function avr(v: number | null): number | null {
  return v === null ? null : Math.round(v);
}
