/** Normaliserar en adress till en ren domän: små bokstäver, utan www, protokoll, sökväg och port. */
export function normaliseraDoman(input: string): string | null {
  let s = (input ?? "").trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  let host = url.hostname;
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) {
    // Internationaliserade domännamn: URL-klassen ger redan punycode, så här hamnar bara skräp.
    return null;
  }
  return host;
}

/** Bygger en start-URL från en domän. */
export function startUrl(doman: string): string {
  return `https://${doman}/`;
}

/** Returnerar true om två URL:er hör till samma sajt (med eller utan www). */
export function sammaSajt(a: string, b: string): boolean {
  const da = normaliseraDoman(a);
  const db = normaliseraDoman(b);
  return !!da && da === db;
}
