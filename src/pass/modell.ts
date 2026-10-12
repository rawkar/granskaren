/**
 * Modellkontroll för passet: varje underagent ska köras på exakt den modell som står i dess agentdefinition.
 * Aliaset "haiku" gav Haiku 5.5 i stället för Haiku 4.5 den 12 oktober 2026, så /dagens läser efter den första
 * agenten i varje steg vilken modell som faktiskt kördes, ur agentens transkript, och avbryter passet vid avvikelse.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Den modell varje steg ska köras på. Fullständiga namn, aldrig alias. Samma som i .claude/agents. */
export const MODELL_PER_STEG: Record<string, string> = {
  analys: "claude-opus-5-5",
  utkast: "claude-opus-5-5",
  verifiering: "claude-haiku-4-5-20251001",
  grind: "claude-haiku-4-5-20251001",
  forfilter: "claude-haiku-4-5-20251001",
};

/** Läser modellnamnet ur agentdefinitionen, så att kontrollen alltid följer filen. */
export function modellIDefinition(agentFil: string): string | null {
  if (!fs.existsSync(agentFil)) return null;
  const m = fs.readFileSync(agentFil, "utf8").match(/^model:\s*(\S+)/m);
  return m ? m[1] : null;
}

/** Katalogen där Claude Code sparar transkripten. */
export function projektKatalog(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects");
}

/** Letar upp transkriptet för en underagent (agent-<id>.jsonl) under alla projekt och sessioner. Nyaste först. */
export function hittaAgentTranskript(agentId: string, rot = projektKatalog()): string | null {
  if (!fs.existsSync(rot)) return null;
  const traffar: { fil: string; tid: number }[] = [];
  for (const projekt of fs.readdirSync(rot, { withFileTypes: true })) {
    if (!projekt.isDirectory()) continue;
    const pMapp = path.join(rot, projekt.name);
    for (const session of fs.readdirSync(pMapp, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const fil = path.join(pMapp, session.name, "subagents", `agent-${agentId}.jsonl`);
      if (fs.existsSync(fil)) traffar.push({ fil, tid: fs.statSync(fil).mtimeMs });
    }
  }
  traffar.sort((a, b) => b.tid - a.tid);
  return traffar[0]?.fil ?? null;
}

/** Modellerna som förekommer i ett agenttranskript (assistentsvar). Tom lista om inget svar hittas. */
export function modellerITranskript(fil: string): string[] {
  const ut = new Set<string>();
  for (const rad of fs.readFileSync(fil, "utf8").split("\n")) {
    if (!rad.trim()) continue;
    try {
      const j = JSON.parse(rad) as { type?: string; message?: { model?: string } };
      if (j.type === "assistant" && j.message?.model && !j.message.model.startsWith("<")) ut.add(j.message.model);
    } catch {
      // ofullständig rad
    }
  }
  return [...ut];
}

export interface Modellkontroll {
  ok: boolean;
  steg: string;
  forvantad: string;
  faktiska: string[];
  meddelande: string;
}

/** Jämför den modell som kördes med den som förväntas för steget. Prefixjämförelse så att datumsuffix inte fäller. */
export function kontrolleraModell(steg: string, agentId: string, forvantad = MODELL_PER_STEG[steg]): Modellkontroll {
  if (!forvantad) return { ok: false, steg, forvantad: "", faktiska: [], meddelande: `okänt steg ${steg}` };
  const fil = hittaAgentTranskript(agentId);
  if (!fil) return { ok: false, steg, forvantad, faktiska: [], meddelande: `hittar inget transkript för agenten ${agentId}` };
  const faktiska = modellerITranskript(fil);
  if (!faktiska.length) return { ok: false, steg, forvantad, faktiska, meddelande: `transkriptet ${fil} innehåller inget modellsvar` };
  const fel = faktiska.filter((m) => !(m.startsWith(forvantad) || forvantad.startsWith(m)));
  if (fel.length) {
    return { ok: false, steg, forvantad, faktiska, meddelande: `AVBRYT PASSET: steget ${steg} kördes på ${fel.join(", ")}, förväntat ${forvantad}. Kontrollera .claude/agents och starta en ny session.` };
  }
  return { ok: true, steg, forvantad, faktiska, meddelande: `steget ${steg} kördes på ${faktiska.join(", ")} som förväntat` };
}
