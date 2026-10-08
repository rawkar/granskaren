import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { beraknaKostnad } from "../src/analyze/klient.js";

const usage = (extra: Partial<Anthropic.Usage> & Record<string, unknown>): Anthropic.Usage =>
  ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...extra }) as Anthropic.Usage;

describe("kostnadsberäkning", () => {
  it("räknar in, ut, cache-läsning och cache-skrivning på fem minuter", () => {
    const k = beraknaKostnad("claude-opus-5-5", usage({ input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }));
    // 4 + 2 + 0,20 + 5
    expect(k).toBeCloseTo(11.2, 6);
  });

  it("prissätter cache-skrivning på en timme till två gånger inpriset", () => {
    const k = beraknaKostnad(
      "claude-opus-5-5",
      usage({ cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } }),
    );
    expect(k).toBeCloseTo(8, 6);
  });

  it("lägger på sökavgiften", () => {
    const k = beraknaKostnad("claude-sonnet-5-5", usage({ input_tokens: 1_000_000, server_tool_use: { web_search_requests: 4 } }));
    expect(k).toBeCloseTo(2.04, 6);
  });

  it("ger null för okänd modell", () => {
    expect(beraknaKostnad("okand-modell", usage({ input_tokens: 10 }))).toBeNull();
  });
});
