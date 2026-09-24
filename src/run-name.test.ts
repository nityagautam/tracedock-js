import { describe, expect, it } from "vitest";
import { formatRunName } from "./run-name.js";

describe("run names", () => {
  const startedAt = new Date("2026-09-24T10:42:31.456Z");

  it("appends a compact UTC timestamp by default", () => {
    expect(formatRunName("Checkout E2E", startedAt)).toBe("Checkout E2E-20260924T104231456Z");
  });

  it("supports an explicit name pattern", () => {
    expect(formatRunName("Checkout E2E", startedAt, "{timestamp}--{name}")).toBe(
      "20260924T104231456Z--Checkout E2E",
    );
  });
});
