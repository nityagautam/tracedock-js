import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TestCenterReporter from "./reporter.js";
import type { ReporterFullConfig, ReporterTestCase, ReporterTestResult } from "./types.js";

const originalEnvironment = { ...process.env };

describe("TestCenterReporter", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "testcenter-reporter-"));
    process.env.TESTCENTER_URL = "https://testcenter.example";
    process.env.TESTCENTER_TOKEN = "super-secret-token";
    process.env.TESTCENTER_PROJECT = "checkout-web";
    process.env.TESTCENTER_ORG = "acme";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    await rm(directory, { recursive: true, force: true });
  });

  it("publishes JUnit and per-attempt evidence without forwarding API auth to storage", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });

      if (url === "https://testcenter.example/api/v1/runs") {
        return jsonResponse(
          {
            runId: "run-1",
            uploads: [
              {
                artifactId: "artifact-1",
                filename: "junit.xml",
                uploadUrl: "https://storage.example/junit",
                method: "PUT",
                headers: { "content-type": "application/xml" },
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
            ],
            attachmentUrl: "/api/v1/runs/run-1/attachment-upload-urls",
            stepsUrl: "/api/v1/runs/run-1/steps",
            completeUrl: "/api/v1/runs/run-1/complete",
          },
          201,
        );
      }
      if (url.endsWith("/attachment-upload-urls")) {
        return jsonResponse(
          {
            uploads: [
              {
                attachmentId: "attachment-1",
                name: "trace.zip",
                uploadUrl: "https://storage.example/trace",
                method: "PUT",
                headers: { "content-type": "application/zip" },
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
            ],
          },
          201,
        );
      }
      if (url.endsWith("/steps")) {
        return jsonResponse({ runId: "run-1", declared: 1, inserted: 1 }, 201);
      }
      if (url === "https://testcenter.example/api/v1/runs/run-1/complete") {
        return jsonResponse({ runId: "run-1", status: "parsing" });
      }
      if (url.startsWith("https://storage.example/")) return new Response(null, { status: 200 });
      return jsonResponse({ message: "unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const reporter = new TestCenterReporter({
      junitFile: "reports/junit.xml",
      name: "Checkout E2E",
      ci: {
        provider: "unknown",
        buildNumber: "84",
        pipelineName: "Nightly regression",
        jobName: "playwright-chromium",
        jobUrl: "https://ci.example/jobs/12001",
      },
    });
    reporter.onBegin(
      config(
        join(directory, "test-results", ".features-gen"),
        join(directory, "playwright.config.ts"),
      ),
      { allTests: () => [{}, {}] },
    );
    reporter.onTestEnd(testCase(), result());

    await mkdir(join(directory, "reports"), { recursive: true });
    await writeFile(
      join(directory, "reports", "junit.xml"),
      '<testsuites><testsuite><testcase name="pays"/></testsuite></testsuites>',
    );
    await reporter.onExit();

    const create = calls.find(({ url }) => url.endsWith("/api/v1/runs"));
    expect(create?.init.headers).toEqual(
      expect.objectContaining({ authorization: "Bearer super-secret-token" }),
    );
    const createBody = JSON.parse(String(create?.init.body)) as Record<string, unknown>;
    expect(createBody).toEqual(
      expect.objectContaining({ project: "checkout-web", framework: "playwright" }),
    );
    expect(createBody.sourceBundleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(createBody.name).toMatch(/^Checkout E2E-\d{8}T\d{9}Z$/);
    expect(createBody.ci).toEqual({
      provider: "unknown",
      buildNumber: "84",
      pipelineName: "Nightly regression",
      jobName: "playwright-chromium",
      jobUrl: "https://ci.example/jobs/12001",
    });

    const declaration = calls.find(({ url }) => url.endsWith("/attachment-upload-urls"));
    const stepDeclaration = calls.find(({ url }) => url.endsWith("/steps"));
    const stepBody = JSON.parse(String(stepDeclaration?.init.body)) as {
      steps: Array<{ id: string; title: string; category: string }>;
    };
    expect(stepBody.steps).toEqual([
      expect.objectContaining({ title: "Given a saved card", category: "test.step" }),
    ]);
    expect(JSON.parse(String(declaration?.init.body))).toEqual({
      attachments: [
        expect.objectContaining({
          kind: "trace",
          test: "pays with a saved card",
          suite: "specs/checkout.spec.ts",
          attempt: 1,
          stepId: stepBody.steps[0]?.id,
        }),
      ],
    });

    const storageCalls = calls.filter(({ url }) => url.startsWith("https://storage.example/"));
    expect(storageCalls).toHaveLength(2);
    for (const call of storageCalls) {
      expect(new Headers(call.init.headers).has("authorization")).toBe(false);
    }
    expect(calls.at(-1)?.url).toBe("https://testcenter.example/api/v1/runs/run-1/complete");

    const bundleDirectory = join(directory, "reports", "testcenter-bundles");
    const bundles = await readdir(bundleDirectory);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatch(/\.testcenter-run\.zip$/);
    const archive = await readFile(join(bundleDirectory, bundles[0]!));
    const storedText = archive.toString("utf8");
    expect(storedText).toContain("testcenter-bundle.json");
    expect(storedText).toContain(String(createBody.sourceBundleId));
    expect(storedText).toContain("Given a saved card");
    expect(storedText).toContain("zip body");
  });

  it("writes a portable ZIP to a configured directory when live publishing is unavailable", async () => {
    delete process.env.TESTCENTER_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const reporter = new TestCenterReporter({
      junitFile: "reports/junit.xml",
      bundle: { outputDir: "portable-output" },
    });
    reporter.onBegin(config(directory, join(directory, "playwright.config.ts")), {
      allTests: () => [{}],
    });
    await mkdir(join(directory, "reports"), { recursive: true });
    await writeFile(
      join(directory, "reports", "junit.xml"),
      '<testsuites><testsuite><testcase name="offline"/></testsuite></testsuites>',
    );
    await reporter.onExit();

    expect(fetchMock).not.toHaveBeenCalled();
    const bundles = await readdir(join(directory, "portable-output"));
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatch(/\.testcenter-run\.zip$/);
  });

  it("skips as one gate when credentials are incomplete", () => {
    delete process.env.TESTCENTER_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const reporter = new TestCenterReporter({ junitFile: "reports/junit.xml" });
    reporter.onBegin(config(directory), { allTests: () => [] });

    expect(fetchMock).not.toHaveBeenCalled();
    const output = stderr.mock.calls.flat().join("");
    expect(output).toContain("Test Center reporter is not configured");
    expect(output).toContain("Missing configuration: TESTCENTER_TOKEN");
    expect(output).toContain("TESTCENTER_URL=https://testcenter.example.com");
    expect(output).toContain("TESTCENTER_RUN_NAME=checkout-e2e");
    expect(output).toContain("TESTCENTER_CI_JOB_URL=https://ci.example/jobs/12001");
    expect(output).toContain("['@testcenter/playwright', { junitFile }]");
    expect(output).toContain("Setup guide:");
  });

  it("reports missing run and CI context without blocking publication", () => {
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>(() => {
          // This test only verifies the advisory emitted synchronously by onBegin.
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const reporter = new TestCenterReporter({ junitFile: "reports/junit.xml" });
    reporter.onBegin(config(directory), { allTests: () => [] });

    const output = stderr.mock.calls.flat().join("");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(output).toContain("Test Center run context is incomplete; publishing will continue");
    expect(output).toContain("TESTCENTER_RUN_NAME (or reporter name option)");
    expect(output).toContain("TESTCENTER_CI_BUILD_ID or TESTCENTER_CI_BUILD_NUMBER");
    expect(output).toContain("TESTCENTER_CI_JOB_NAME");
    expect(output).toContain("TESTCENTER_CI_JOB_URL or TESTCENTER_CI_PIPELINE_URL");
    expect(output).toMatch(/Run name for this publication: Playwright run-\d{8}T\d{9}Z/);
  });

  it("does not publish during Playwright test discovery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const reporter = new TestCenterReporter({ junitFile: "reports/junit.xml" });

    reporter.onBegin(
      { ...config(directory), argv: ["node", "playwright", "test", "--list"] },
      {
        allTests: () => [{}],
      },
    );
    await reporter.onExit();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recognizes discovery on Playwright versions that do not expose config.argv", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const reporter = new TestCenterReporter({ junitFile: "reports/junit.xml" });
    const originalArguments = process.argv;
    process.argv = ["node", "playwright", "test", "--list"];
    try {
      reporter.onBegin(config(directory), { allTests: () => [{}] });
      await reporter.onExit();
    } finally {
      process.argv = originalArguments;
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts bearer values and signed URLs from failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "Bearer super-secret-token failed at https://storage.example/file?signature=also-secret",
        );
      }),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const reporter = new TestCenterReporter({ junitFile: "reports/junit.xml" });

    reporter.onBegin(config(directory), { allTests: () => [] });
    await reporter.onExit();

    const output = stderr.mock.calls.flat().join(" ");
    expect(output).not.toContain("super-secret-token");
    expect(output).not.toContain("also-secret");
    expect(output).toContain("Bearer [redacted]");
    expect(output).toContain("[redacted URL]");
  });
});

function config(
  rootDir: string,
  configFile = join(rootDir, "playwright.config.ts"),
): ReporterFullConfig {
  return { rootDir, configFile, version: "1.62.1", shard: null };
}

function testCase(): ReporterTestCase {
  return {
    title: "pays with a saved card",
    titlePath: () => [
      "",
      "chromium",
      "specs/checkout.spec.ts",
      "Checkout",
      "pays with a saved card",
    ],
    location: { file: "/repo/specs/checkout.spec.ts" },
  };
}

function result(): ReporterTestResult {
  const trace = {
    name: "trace",
    contentType: "application/zip",
    body: Buffer.from("zip body"),
  };
  return {
    retry: 1,
    attachments: [trace],
    steps: [
      {
        title: "Given a saved card",
        category: "test.step",
        duration: 15,
        startTime: new Date("2026-09-23T10:00:00.000Z"),
        annotations: [],
        attachments: [trace],
        steps: [],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
