import { describe, expect, it } from "vitest";
import { testDb } from "../src/db/index.js";
import { hamtaProspekt, laggTillProspekt } from "../src/db/fragor.js";
import { godkann, granskningsko, kasta } from "../src/email/review.js";

function medMejl(status = "i_granskning") {
  const d = testDb();
  const { id } = laggTillProspekt(d, { doman: "exempel.se" });
  d.prepare("UPDATE prospekt SET status = 'i_granskning' WHERE id = ?").run(id);
  const mejlId = Number(
    d.prepare("INSERT INTO mejl (prospekt_id, typ, amne, text, anvanda_fynd, sakerhet, status, mottagare) VALUES (?, 'forsta', 'Ämne', 'Hej', '[]', 0.9, ?, 'info@exempel.se')").run(id, status).lastInsertRowid,
  );
  return { d, prospektId: id, mejlId };
}

describe("granskningskön utan frågor", () => {
  it("listar mejl i granskningskön med domän", () => {
    const { d, mejlId } = medMejl();
    const ko = granskningsko(d);
    expect(ko.map((m) => [m.id, m.doman, m.mottagare])).toEqual([[mejlId, "exempel.se", "info@exempel.se"]]);
  });

  it("godkänner: mejlet och prospektet blir köade och händelsen loggas med noten", () => {
    const { d, prospektId, mejlId } = medMejl();
    const r = godkann(d, [mejlId, 999], "godkänt av Rawaz");
    expect(r).toEqual({ koade: [mejlId], hoppade: [999] });
    expect((d.prepare("SELECT status FROM mejl WHERE id = ?").get(mejlId) as { status: string }).status).toBe("koad");
    expect(hamtaProspekt(d, prospektId)?.status).toBe("koad");
    const h = d.prepare("SELECT typ, detaljer FROM handelser WHERE prospekt_id = ? ORDER BY id DESC LIMIT 1").get(prospektId) as { typ: string; detaljer: string };
    expect(h.typ).toBe("godkant_i_review");
    expect(h.detaljer).toMatch(/Rawaz/);
    expect(granskningsko(d)).toHaveLength(0);
  });

  it("kastar: mejlet blir kastat och prospektet är kvar som granskat", () => {
    const { d, prospektId, mejlId } = medMejl();
    expect(kasta(d, [mejlId], "samma organisation")).toEqual({ kastade: [mejlId], hoppade: [] });
    expect((d.prepare("SELECT status FROM mejl WHERE id = ?").get(mejlId) as { status: string }).status).toBe("kastad");
    expect(hamtaProspekt(d, prospektId)?.status).toBe("granskad");
  });

  it("rör inte mejl som redan är köade eller skickade", () => {
    const { d, mejlId } = medMejl("koad");
    expect(godkann(d, [mejlId])).toEqual({ koade: [], hoppade: [mejlId] });
    expect(kasta(d, [mejlId])).toEqual({ kastade: [], hoppade: [mejlId] });
    expect((d.prepare("SELECT status FROM mejl WHERE id = ?").get(mejlId) as { status: string }).status).toBe("koad");
  });
});
