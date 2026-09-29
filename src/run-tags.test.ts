import { describe, expect, it, vi } from "vitest";
import { resolveRunTags } from "./run-tags.js";

describe("resolveRunTags", () => {
  it("reads list syntax while options win and system tags remain reserved", () => {
    expect(
      resolveRunTags(
        "suite=regression,team:payments,owner=environment,playwright-version=spoofed",
        { owner: "configuration", "Release Train": "nightly" },
        { "playwright-version": "1.62.1", "test-count": "42" },
        vi.fn(),
      ),
    ).toEqual({
      suite: "regression",
      team: "payments",
      owner: "configuration",
      "release-train": "nightly",
      "playwright-version": "1.62.1",
      "test-count": "42",
    });
  });

  it("reads JSON when values need commas or colons", () => {
    expect(
      resolveRunTags(
        '{"suite":"smoke,critical","target":"https://example.test","attempt":2}',
        undefined,
        {},
        vi.fn(),
      ),
    ).toEqual({ suite: "smoke,critical", target: "https://example.test", attempt: "2" });
  });

  it("warns and skips malformed environment entries", () => {
    const warn = vi.fn();
    expect(resolveRunTags("suite=regression,broken", undefined, {}, warn)).toEqual({
      suite: "regression",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"broken"'));
  });
});
