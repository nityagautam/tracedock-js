import { describe, expect, it } from "vitest";
import { withTraceDockDefaults } from "./config.js";

describe("withTraceDockDefaults", () => {
  it("defaults trace and video when use is absent", () => {
    const configured = withTraceDockDefaults({ reporter: [["line"]] });

    expect(configured.use).toEqual({
      trace: "retain-on-failure",
      video: "retain-on-failure",
    });
  });

  it("preserves explicit evidence policies and unrelated use settings", () => {
    const configured = withTraceDockDefaults({
      use: {
        baseURL: "https://example.test",
        screenshot: "only-on-failure",
        trace: "off",
        video: "on-first-retry",
      },
    });

    expect(configured.use).toEqual({
      baseURL: "https://example.test",
      screenshot: "only-on-failure",
      trace: "off",
      video: "on-first-retry",
    });
  });

  it("defaults one missing policy without mutating the input", () => {
    const use = { screenshot: "only-on-failure", trace: "on" };
    const input = { retries: 2, use };
    const configured = withTraceDockDefaults(input);

    expect(configured).not.toBe(input);
    expect(configured.use).not.toBe(use);
    expect(configured.use.video).toBe("retain-on-failure");
    expect(input).toEqual({ retries: 2, use: { screenshot: "only-on-failure", trace: "on" } });
  });
});
