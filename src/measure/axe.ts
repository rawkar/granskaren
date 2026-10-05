import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "playwright";
import { USER_AGENT } from "../config.js";

export interface AxeSammanfattning {
  url: string;
  axe_version: string;
  critical_antal: number;
  serious_antal: number;
  moderate_antal: number;
  minor_antal: number;
  regler_brutna: string[];
  brister: {
    id: string;
    allvar: string;
    beskrivning: string;
    hjalp: string;
    antal_element: number;
    exempel: string[];
  }[];
  fel: string | null;
}

/** Kör axe-core på en sida i mobilt läge. */
export async function korAxe(url: string): Promise<AxeSammanfattning> {
  const tom: AxeSammanfattning = {
    url, axe_version: "", critical_antal: 0, serious_antal: 0, moderate_antal: 0, minor_antal: 0,
    regler_brutna: [], brister: [], fel: null,
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 390, height: 844 }, isMobile: true, locale: "sv-SE" });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    const rakna = (impact: string) => res.violations.filter((v) => v.impact === impact).length;
    return {
      url,
      axe_version: res.testEngine.version,
      critical_antal: rakna("critical"),
      serious_antal: rakna("serious"),
      moderate_antal: rakna("moderate"),
      minor_antal: rakna("minor"),
      regler_brutna: res.violations.map((v) => v.id),
      brister: res.violations
        .sort((a, b) => ordning(a.impact) - ordning(b.impact))
        .map((v) => ({
          id: v.id,
          allvar: v.impact ?? "okänd",
          beskrivning: v.description,
          hjalp: v.help,
          antal_element: v.nodes.length,
          exempel: v.nodes.slice(0, 3).map((n) => n.html.slice(0, 200)),
        })),
      fel: null,
    };
  } catch (e) {
    tom.fel = e instanceof Error ? e.message : String(e);
    return tom;
  } finally {
    await browser.close();
  }
}

function ordning(impact: string | null | undefined): number {
  return { critical: 0, serious: 1, moderate: 2, minor: 3 }[impact ?? "minor"] ?? 4;
}
