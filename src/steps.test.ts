import { describe, expect, it, vi } from "vitest";
import { addCurlAnnotations, prepareSteps } from "./steps.js";
import type { PreparedAttachment } from "./attachments.js";
import type {
  ReporterAttachment,
  ReporterTestCase,
  ReporterTestResult,
  ReporterTestStep,
} from "./types.js";

const test: ReporterTestCase = {
  title: "checks out",
  tags: [],
  titlePath: () => [
    "",
    "chromium",
    "specs/checkout.spec.ts",
    "Checkout",
    "checks out",
  ],
  location: { file: "/repo/specs/checkout.spec.ts" },
};

describe("Playwright step preparation", () => {
  it("keeps automatic teardown media at test level and explicit step media on its step", () => {
    const screenshot = { name: "screenshot", contentType: "image/png", path: "/results/failure.png" };
    const video = { name: "video", contentType: "video/webm", path: "/results/video.webm" };
    const explicit = { name: "screenshot", contentType: "image/png", path: "/results/explicit.png" };
    const prepared = prepareSteps(test, {
      retry: 0,
      attachments: [screenshot, video, explicit],
      steps: [
        step("Inspect page", "test.step", { attachments: [explicit] }),
        step("After Hooks", "hook", {
          attachments: [screenshot],
          steps: [step('Fixture "context"', "fixture", { attachments: [video] })],
        }),
      ],
    }, "/repo", vi.fn());
    expect(prepared.stepIdForAttachment(screenshot)).toBeUndefined();
    expect(prepared.stepIdForAttachment({ ...video })).toBeUndefined();
    expect(prepared.stepIdForAttachment(explicit)).toBe(prepared.batch!.steps[0]!.id);
    expect(prepared.batch!.steps).toHaveLength(3);
  });
  it("adds bounded inline cURL without changing downloads, other annotations or unrelated steps", () => {
    const prepared = prepareSteps(
      test,
      {
        retry: 0,
        attachments: [],
        steps: [
          step("API POST", "test.step", {
            annotations: [{ type: "note", description: "Keep me" }],
          }),
          step("API GET", "test.step"),
        ],
      },
      "/repo",
      vi.fn(),
    );
    const api = prepared.batch!.steps[0]!;
    const fullCurl = `curl --data-raw '${"x".repeat(3000)}'`;
    const attachment: PreparedAttachment = {
      declaration: {
        kind: "log",
        name: "api-1.curl.txt",
        contentType: "text/plain",
        bytes: Buffer.byteLength(fullCurl),
        test: test.title,
        attempt: 0,
        stepId: api.id,
      },
      body: Buffer.from(fullCurl),
    };
    addCurlAnnotations(prepared.batch, [attachment]);
    addCurlAnnotations(prepared.batch, [attachment]);
    expect(api.annotations).toHaveLength(2);
    expect(api.annotations?.[0]).toEqual({
      type: "note",
      description: "Keep me",
    });
    expect(api.annotations?.[1]?.description).toHaveLength(2000);
    expect(api.annotations?.[1]?.description).toContain(
      "Preview truncated; download",
    );
    expect(attachment.body.toString()).toBe(fullCurl);
    expect(prepared.batch!.steps[1]!.annotations).toBeUndefined();
    api.annotations = Array.from({ length: 100 }, () => ({ type: "note" }));
    addCurlAnnotations(prepared.batch, [attachment]);
    expect(api.annotations).toHaveLength(100);
  });
  it("captures ordinary non-BDD steps on versions without step annotations", () => {
    const prepared = prepareSteps(
      test,
      {
        retry: 0,
        attachments: [],
        steps: [
          step("Create customer", "test.step", {
            annotations: undefined,
            steps: [
              step("apiRequestContext.post", "pw:api", {
                annotations: undefined,
              }),
              step("expect.toBe", "expect", { annotations: undefined }),
            ],
          }),
        ],
      },
      "/repo",
      vi.fn(),
    );
    expect(prepared.batch?.steps.map((s) => [s.title, s.status])).toEqual([
      ["Create customer", "passed"],
      ["apiRequestContext.post", "passed"],
      ["expect.toBe", "passed"],
    ]);
    expect(prepared.batch?.steps[1]?.parentId).toBe(
      prepared.batch?.steps[0]?.id,
    );
  });
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
      {
        title: "Then the order is confirmed",
        category: "test.step",
        parentId: "child",
      },
      {
        title: "expect(receipt).toBeVisible()",
        category: "expect",
        parentId: null,
      },
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

it("retains failed subtrees and evidence, inserts skipped declared steps before teardown, and isolates retries", () => {
  const attachment: ReporterAttachment = {
    name: "error",
    contentType: "text/plain",
    body: Buffer.from("details"),
  };
  const first = step("Given ready", "test.step", {
    location: { file: test.location.file, line: 9 },
  });
  const failed = step("When pay", "test.step", {
    location: { file: test.location.file, line: 10 },
    error: { message: "declined" },
    steps: [step("request", "pw:api", { attachments: [attachment] })],
  });
  const plan = [
    { line: 9, title: "Given ready", background: false },
    { line: 10, title: "When pay", background: false },
    { line: 11, title: "Then receipt", background: false },
    { line: 12, title: "And email", background: false },
  ];
  const observed = [
    step("Before Hooks", "hook"),
    first,
    failed,
    step("After Hooks", "hook"),
  ];
  const result = {
    retry: 0,
    status: "failed" as const,
    attachments: [attachment],
    steps: observed,
  };
  const prepared = prepareSteps(test, result, "/repo", vi.fn(), plan);
  const steps = prepared.batch!.steps;
  expect(steps.map((s) => [s.title, s.status])).toEqual([
    ["Before Hooks", "passed"],
    ["Given ready", "passed"],
    ["When pay", "failed"],
    ["request", "passed"],
    ["Then receipt", "skipped"],
    ["And email", "skipped"],
    ["After Hooks", "passed"],
  ]);
  expect(prepared.stepIdForAttachment(attachment)).toBe(steps[3]!.id);
  expect(steps[3]!.parentId).toBe(steps[2]!.id);
  expect(steps[4]).not.toHaveProperty("startedAt");
  expect(steps[4]).not.toHaveProperty("error");
  expect(steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(result.steps).toHaveLength(4);
  const retry = prepareSteps(
    test,
    {
      retry: 1,
      status: "passed",
      attachments: [],
      steps: plan.map((p) =>
        step(p.title, "test.step", {
          location: { file: test.location.file, line: p.line },
        }),
      ),
    },
    "/repo",
    vi.fn(),
    plan,
  );
  expect(retry.batch?.steps.every((s) => s.status === "passed")).toBe(true);
});

it("handles duplicate titles by location and marks unexecuted background steps skipped", () => {
  const plan = [
    { line: 3, title: "Given same", background: true },
    { line: 4, title: "Given same", background: true },
    { line: 9, title: "Then same", background: false },
  ];
  const result: ReporterTestResult = {
    retry: 0,
    status: "failed",
    attachments: [],
    steps: [
      step("Before Hooks", "hook", {
        error: { message: "setup failed" },
        steps: [
          step("Given same", "test.step", {
            location: { file: test.location.file, line: 3 },
            error: { message: "setup failed" },
          }),
        ],
      }),
      step("After Hooks", "hook"),
    ],
  };
  const prepared = prepareSteps(test, result, "/repo", vi.fn(), plan).batch!
    .steps;
  expect(prepared.map((s) => [s.title, s.status])).toEqual([
    ["Before Hooks", "failed"],
    ["Given same", "failed"],
    ["Given same", "skipped"],
    ["Then same", "skipped"],
    ["After Hooks", "passed"],
  ]);
  expect(prepared[2]!.parentId).toBe(prepared[0]!.id);
  const skipped = prepareSteps(
    test,
    { retry: 0, status: "skipped", attachments: [], steps: [] },
    "/repo",
    vi.fn(),
    plan,
  );
  expect(skipped.batch?.steps).toHaveLength(3);
  expect(skipped.batch?.steps.every((s) => s.status === "skipped")).toBe(true);
});
