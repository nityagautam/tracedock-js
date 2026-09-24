import { describe, expect, it, vi } from "vitest";
import { prepareTestPriorities, priorityTagsEnabled } from "./priorities.js";
import type { ReporterTestCase } from "./types.js";

function test(title: string, tags: string[], file = "specs/checkout.spec.ts"): ReporterTestCase {
  return {
    title,
    tags,
    titlePath: () => ["", "chromium", file, title],
    location: { file: `/repo/${file}` },
  };
}

describe("prepareTestPriorities", () => {
  it("maps exact case-insensitive tags and declares untagged tests as unset", () => {
    const declarations = prepareTestPriorities(
      [test("payment", ["@P0", "@smoke"]), test("profile", ["@p10", "smoke-p1"])],
      "/repo",
      vi.fn(),
    );

    expect(declarations).toEqual([
      { suite: "specs/checkout.spec.ts", test: "payment", priority: "P0" },
      { suite: "specs/checkout.spec.ts", test: "profile", priority: null },
    ]);
  });

  it("warns and uses the first of multiple priority tags", () => {
    const warn = vi.fn();
    expect(prepareTestPriorities([test("payment", ["@p0", "@p2"])], "/repo", warn)).toEqual([
      { suite: "specs/checkout.spec.ts", test: "payment", priority: "P0" },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("first priority tag; ignored @p2"));
  });
});

describe("priorityTagsEnabled", () => {
  it("defaults on and lets explicit configuration win", () => {
    expect(priorityTagsEnabled(undefined, undefined)).toBe(true);
    expect(priorityTagsEnabled(undefined, "false")).toBe(false);
    expect(priorityTagsEnabled(true, "false")).toBe(true);
    expect(priorityTagsEnabled(false, "true")).toBe(false);
  });
});
