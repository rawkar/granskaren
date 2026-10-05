import { USER_AGENT } from "../config.js";
import { internaLankar } from "../crawl/sidurval.js";
import { paus } from "../util/logg.js";

export interface LankKontroll {
  url: string;
  status: number | null;
  fran: string;
}

/**
 * Kontrollerar interna länkar från de hämtade sidorna med lätta HEAD-anrop.
 * Begränsat antal och paus mellan anrop så att vi inte belastar sajten.
 */
export async function kontrolleraLankar(
  sidor: { url: string; html: string }[],
  max = 40,
  pausMs = 400,
): Promise<{ resultat: LankKontroll[]; antal: number }> {
  const kandidater = new Map<string, string>();
  const hamtade = new Set(sidor.map((s) => normalisera(s.url)));
  for (const s of sidor) {
    for (const l of internaLankar(s.html, s.url)) {
      const n = normalisera(l.url);
      if (hamtade.has(n) || kandidater.has(n)) continue;
      kandidater.set(n, s.url);
      if (kandidater.size >= max) break;
    }
    if (kandidater.size >= max) break;
  }

  const resultat: LankKontroll[] = [];
  for (const [url, fran] of kandidater) {
    resultat.push({ url, status: await status(url), fran });
    await paus(pausMs);
  }
  return { resultat, antal: resultat.length };
}

async function status(url: string): Promise<number | null> {
  const headers = { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.5" };
  try {
    let r = await fetch(url, { method: "HEAD", headers, redirect: "follow", signal: AbortSignal.timeout(12000) });
    if (r.status === 405 || r.status === 403 || r.status === 501) {
      r = await fetch(url, { method: "GET", headers, redirect: "follow", signal: AbortSignal.timeout(15000) });
    }
    return r.status;
  } catch {
    return null;
  }
}

function normalisera(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}
