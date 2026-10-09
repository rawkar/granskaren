import { describe, expect, it } from "vitest";
import { rymsSajter } from "../src/pass/kvot.js";

describe("kvotmätningen", () => {
  it("räknar antal sajter som ryms med en femtedels marginal", () => {
    expect(rymsSajter(100, 10)).toBe(8);
    expect(rymsSajter(45, 10)).toBe(3);
    expect(rymsSajter(100, 0)).toBe(0);
    expect(rymsSajter(10, 12)).toBe(0);
  });
});
