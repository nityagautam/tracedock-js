import { describe, expect, it, vi } from "vitest";
import { classifyAttachment, junitSuiteName, prepareAttachments } from "./attachments.js";
import type { ReporterTestCase } from "./types.js";

const testCase: ReporterTestCase = {
  title: "declines an expired card",
  titlePath: () => [
    "",
    "chromium",
    "specs/checkout.spec.ts",
    "Checkout",
    "declines an expired card",
  ],
  location: { file: "/repo/specs/checkout.spec.ts" },
};

describe("Playwright attachment preparation", () => {
  it.each([
    ["screenshot", { name: "page", contentType: "image/png", path: "/tmp/page.png" }],
    ["diff", { name: "checkout-diff", contentType: "image/png", path: "/tmp/diff.png" }],
    ["video", { name: "video", contentType: "video/webm", path: "/tmp/video.webm" }],
    ["trace", { name: "trace", contentType: "application/zip", path: "/tmp/trace.zip" }],
    ["har", { name: "network", contentType: "application/json", path: "/tmp/network.har" }],
    ["report", { name: "report", contentType: "text/html", path: "/tmp/index.html" }],
    ["log", { name: "api trace", contentType: "text/markdown", path: "/tmp/api-trace.md" }],
  ] as const)("classifies %s evidence", (expected, attachment) => {
    expect(classifyAttachment(attachment).kind).toBe(expected);
  });

  it("uses the same file-suite identity as Playwright JUnit", () => {
    expect(junitSuiteName(testCase, "/repo")).toBe("specs/checkout.spec.ts");
  });

  it("binds evidence to the exact retry and disambiguates duplicate names", async () => {
    const warn = vi.fn();
    const prepared = await prepareAttachments(
      testCase,
      {
        retry: 1,
        attachments: [
          { name: "screenshot", contentType: "image/png", body: Buffer.from("first") },
          { name: "screenshot", contentType: "image/png", body: Buffer.from("second") },
          { name: "api trace", contentType: "text/markdown", body: Buffer.from("trace") },
        ],
      },
      "/repo",
      warn,
    );

    expect(prepared.map(({ declaration }) => declaration)).toEqual([
      expect.objectContaining({
        name: "screenshot.png",
        kind: "screenshot",
        suite: "specs/checkout.spec.ts",
        test: "declines an expired card",
        attempt: 1,
      }),
      expect.objectContaining({ name: "screenshot-2.png", kind: "screenshot", attempt: 1 }),
      expect.objectContaining({ name: "api trace.txt", kind: "log", contentType: "text/plain" }),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});
