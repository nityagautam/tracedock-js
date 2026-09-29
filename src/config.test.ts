import { describe, expect, it } from "vitest";
import { withTraceOptixDefaults } from "./config.js";

describe("withTraceOptixDefaults", () => {
  it("defaults trace and video when use is absent", () => {
    const configured = withTraceOptixDefaults({ reporter: [["line"]] });

    expect(configured.use).toEqual({
      trace: "retain-on-failure",
      video: "retain-on-failure",
    });
  });

  it("preserves explicit evidence policies and unrelated use settings", () => {
    const configured = withTraceOptixDefaults({
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
    const configured = withTraceOptixDefaults(input);

    expect(configured).not.toBe(input);
    expect(configured.use).not.toBe(use);
    expect(configured.use.video).toBe("retain-on-failure");
    expect(input).toEqual({ retries: 2, use: { screenshot: "only-on-failure", trace: "on" } });
  });
});
