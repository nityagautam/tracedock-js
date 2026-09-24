import { describe, expect, it, vi } from "vitest";
import { prepareSteps } from "./steps.js";
import type {
  ReporterAttachment,
  ReporterTestCase,
  ReporterTestResult,
  ReporterTestStep,
} from "./types.js";

const test: ReporterTestCase = {
  title: "checks out",
  tags: [],
  titlePath: () => ["", "chromium", "specs/checkout.spec.ts", "Checkout", "checks out"],
  location: { file: "/repo/specs/checkout.spec.ts" },
};

describe("Playwright step preparation", () => {
  it("records every category, hierarchy, failure, and originating attachment", () => {
    const screenshot: ReporterAttachment = {
      name: "confirmation",
      contentType: "image/png",
      path: "/repo/results/confirmation.png",
    };
    const child = step("Then the order is confirmed", "test.step", {
      error: { message: "expected confirmation", stack: "at checkout.ts:42" },
      attachments: [screenshot],
    });
    const result: ReporterTestResult = {
      retry: 1,
      attachments: [screenshot],
      steps: [
        step("Before Hooks", "hook"),
        step("When the buyer pays", "test.step", { steps: [child] }),
        step("expect(receipt).toBeVisible()", "expect"),
        step("page.click", "pw:api"),
      ],
    };

    const prepared = prepareSteps(test, result, "/repo", vi.fn());

    expect(
      prepared.batch?.steps.map(({ title, category, parentId }) => ({
        title,
        category,
        parentId: parentId ? "child" : null,
      })),
    ).toEqual([
      { title: "Before Hooks", category: "hook", parentId: null },
      { title: "When the buyer pays", category: "test.step", parentId: null },
      { title: "Then the order is confirmed", category: "test.step", parentId: "child" },
      { title: "expect(receipt).toBeVisible()", category: "expect", parentId: null },
      { title: "page.click", category: "pw:api", parentId: null },
    ]);
    const failed = prepared.batch?.steps[2];
    expect(failed).toEqual(
      expect.objectContaining({
        status: "failed",
        error: { message: "expected confirmation", stack: "at checkout.ts:42" },
      }),
    );
    expect(prepared.stepIdForAttachment(screenshot)).toBe(failed?.id);
  });
});

function step(
  title: string,
  category: string,
  overrides: Partial<ReporterTestStep> = {},
): ReporterTestStep {
  return {
    title,
    category,
    duration: 12,
    startTime: new Date("2026-09-23T10:00:00.000Z"),
    annotations: [],
    attachments: [],
    steps: [],
    ...overrides,
  };
}
