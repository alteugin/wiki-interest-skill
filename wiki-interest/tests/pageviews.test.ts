import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lastCompleteMonths, periodsBetween } from "../scripts/pageviews.ts";

describe("periodsBetween", () => {
  it("lists months across a year boundary", () => {
    assert.deepEqual(periodsBetween("2024-11", "2025-02", "monthly"), ["2024-11", "2024-12", "2025-01", "2025-02"]);
  });

  it("lists every day, including leap days", () => {
    const days = periodsBetween("2024-02", "2024-02", "daily");
    assert.equal(days.length, 29);
    assert.equal(days.at(-1), "2024-02-29");
  });

  it("rejects malformed months", () => {
    assert.throws(() => periodsBetween("2024-1", "2024-02", "monthly"), /YYYY-MM/);
  });
});

describe("lastCompleteMonths", () => {
  it("excludes the current, incomplete month", () => {
    assert.deepEqual(lastCompleteMonths(24, new Date("2026-09-24T12:00:00Z")), { from: "2024-09", to: "2026-08" });
  });

  it("handles January rolling back into the previous year", () => {
    assert.deepEqual(lastCompleteMonths(1, new Date("2026-01-15T00:00:00Z")), { from: "2025-12", to: "2025-12" });
  });
});
