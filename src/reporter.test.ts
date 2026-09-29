import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PORTABLE_BUNDLE_EVIDENCE_FILES,
  MAX_PORTABLE_BUNDLE_MANIFEST_BYTES,
} from "./bundle.js";
import TraceOptixReporter from "./reporter.js";
import type { ReporterFullConfig, ReporterTestCase, ReporterTestResult } from "./types.js";

const originalEnvironment = { ...process.env };

describe("TraceOptixReporter", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "traceoptix-reporter-"));
    process.env.TRACEOPTIX_URL = "https://traceoptix.example";
    process.env.TRACEOPTIX_TOKEN = "super-secret-token";
    process.env.TRACEOPTIX_PROJECT = "checkout-web";
    process.env.TRACEOPTIX_ORG = "acme";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    await rm(directory, { recursive: true, force: true });
  });

  it("matches the server's large-bundle compatibility envelope", () => {
    expect(MAX_PORTABLE_BUNDLE_MANIFEST_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_PORTABLE_BUNDLE_EVIDENCE_FILES).toBe(10_000);
  });

  it("publishes JUnit and per-attempt evidence without forwarding API auth to storage", async () => {
    process.env.TRACEOPTIX_RUN_TAGS = "suite=regression,team=payments,owner=environment";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.endsWith("/api/v1/projects/checkout-web/publish-capabilities")) {
        return jsonResponse({
          schemaVersion: 1,
          project: "checkout-web",
          collectionMode: "full",
          policyRevision: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
          summarySchemaVersion: 1,
          summary: null,
          summaryUrl: "/api/v1/runs/summary",
        });
      }

      if (url === "https://traceoptix.example/api/v1/runs") {
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
            testPrioritiesUrl: "/api/v1/runs/run-1/test-priorities",
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
      if (url.endsWith("/test-priorities")) {
        return jsonResponse({ runId: "run-1", declared: 1, inserted: 1 }, 201);
      }
      if (url === "https://traceoptix.example/api/v1/runs/run-1/complete") {
        return jsonResponse({ runId: "run-1", status: "parsing" });
      }
      if (url.startsWith("https://storage.example/")) return new Response(null, { status: 200 });
      return jsonResponse({ message: "unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const reporter = new TraceOptixReporter({
      junitFile: "reports/junit.xml",
      name: "Checkout E2E",
      ci: {
        provider: "unknown",
        buildNumber: "84",
        pipelineName: "Nightly regression",
        jobName: "playwright-chromium",
        jobUrl: "https://ci.example/jobs/12001",
      },
      tags: { owner: "configuration" },
    });
    reporter.onBegin(
      config(
        join(directory, "test-results", ".features-gen"),
        join(directory, "playwright.config.ts"),
      ),
      { allTests: () => [testCase(["@p0"]), testCase([], "uses a gift card")] },
    );
    reporter.onTestEnd(testCase(), result());

    await mkdir(join(directory, "reports"), { recursive: true });
    await writeFile(
      join(directory, "reports", "junit.xml"),
      '<testsuites><testsuite><testcase name="pays"/><testcase name="gift card"/></testsuite></testsuites>',
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
    expect(createBody.tags).toEqual({
      suite: "regression",
      team: "payments",
      owner: "configuration",
      "playwright-version": "1.62.1",
      "test-count": "2",
    });

    const declaration = calls.find(({ url }) => url.endsWith("/attachment-upload-urls"));
    const stepDeclaration = calls.find(({ url }) => url.endsWith("/steps"));
    const priorityDeclaration = calls.find(({ url }) => url.endsWith("/test-priorities"));
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
    expect(JSON.parse(String(priorityDeclaration?.init.body))).toEqual({
      tests: [
        {
          suite: "specs/checkout.spec.ts",
          test: "pays with a saved card",
          priority: "P0",
        },
        {
          suite: "specs/checkout.spec.ts",
          test: "uses a gift card",
          priority: null,
        },
      ],
    });

    const storageCalls = calls.filter(({ url }) => url.startsWith("https://storage.example/"));
    expect(storageCalls).toHaveLength(2);
    for (const call of storageCalls) {
      expect(new Headers(call.init.headers).has("authorization")).toBe(false);
    }
    expect(calls.at(-1)?.url).toBe("https://traceoptix.example/api/v1/runs/run-1/complete");

    const bundleDirectory = join(directory, "reports", "traceoptix-bundles");
    const bundles = await readdir(bundleDirectory);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatch(/\.traceoptix-run\.zip$/);
    const archive = await readFile(join(bundleDirectory, bundles[0]!));
    const storedText = archive.toString("utf8");
    expect(storedText).toContain("manifest.json");
    expect(storedText).toContain('"schemaVersion":2');
    expect(storedText).toContain('"testCaseCount":2');
    expect(storedText).not.toContain('"schemaVersion": 2');
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(packageJson.version).toBe("1.0.0");
    expect(storedText).toContain(`"version":"${packageJson.version}"`);
    expect(storedText).toContain(String(createBody.sourceBundleId));
    expect(storedText).toContain("Given a saved card");
    expect(storedText).toContain('"priority":"P0"');
    expect(storedText).toContain('"suite":"regression"');
    expect(storedText).toContain("zip body");
  });

  it("writes a portable ZIP to a configured directory when live publishing is unavailable", async () => {
    delete process.env.TRACEOPTIX_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const reporter = new TraceOptixReporter({
      junitFile: "reports/junit.xml",
      bundle: { outputDir: "portable-output" },
    });
    reporter.onBegin(config(directory, join(directory, "playwright.config.ts")), {
      allTests: () => [testCase()],
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
    expect(bundles[0]).toMatch(/\.traceoptix-run\.zip$/);
    const warnings = stderr.mock.calls.flat().join("");
    expect(warnings).toContain("TraceOptix results were not published");
    expect(warnings).toContain(
      `Portable run bundle retained at: ${join(directory, "portable-output", bundles[0]!)}`,
    );
  });

  it("retains full offline details when a configured URL overrides Azure and capability negotiation fails", async () => {
    process.env.CI = "true";
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed at https://localhost:3000?token=secret");
    });
    vi.stubGlobal("fetch", fetchMock);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const reporter = new TraceOptixReporter({
      junitFile: "reports/junit.xml",
      url: "https://localhost:3000",
      bundle: { outputDir: "fallback-bundles" },
    });
    reporter.onBegin(config(directory), { allTests: () => [testCase()] });
    reporter.onTestEnd(testCase(), result());
    await mkdir(join(directory, "reports"), { recursive: true });
    await writeFile(
      join(directory, "reports", "junit.xml"),
      '<testsuites><testsuite><testcase name="offline"/></testsuite></testsuites>',
    );
    await reporter.onExit();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://localhost:3000/api/v1/projects/checkout-web/publish-capabilities",
      expect.objectContaining({ method: "GET" }),
    );
    const warnings = stderr.mock.calls.flat().join("");
    expect(warnings).toContain("Conflicting TraceOptix URLs were detected at startup");
    expect(warnings).toContain("Selected playwright.config.ts url: https://localhost:3000");
    expect(warnings).toContain("Ignored TRACEOPTIX_URL: https://traceoptix.example");
    expect(warnings).toContain("Inside CI, loopback points to the build agent");
    expect(warnings).toContain("Could not resolve the project publishing mode");
    expect(warnings).toContain("TraceOptix results were not published");
    expect(warnings).toContain("Portable run bundle retained at:");
    expect(warnings).not.toContain("secret");

    const bundleDirectory = join(directory, "fallback-bundles");
    const bundles = await readdir(bundleDirectory);
    expect(bundles).toHaveLength(1);
    const archive = await readFile(join(bundleDirectory, bundles[0]!));
    expect(archive.toString("utf8")).toContain("Given a saved card");
    expect(stdout.mock.calls.flat().join("")).toContain(`output directory: ${bundleDirectory}`);
  });

  it("publishes only aggregate counts when the project is Summary-only", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/publish-capabilities")) {
          return jsonResponse({
            schemaVersion: 1,
            project: "checkout-web",
            collectionMode: "summary_only",
            policyRevision: 3,
            expiresAt: "2099-01-01T00:00:00.000Z",
            summarySchemaVersion: 1,
            summary: {
              limit: 500,
              used: 4,
              remaining: 496,
              periodEnd: "2026-10-01T00:00:00.000Z",
            },
            summaryUrl: "/api/v1/runs/summary",
          });
        }
        if (url.endsWith("/api/v1/runs/summary")) {
          return jsonResponse(
            { runId: "summary-1", status: "complete", dataMode: "summary_only" },
            201,
          );
        }
        return jsonResponse({ message: "unexpected request" }, 500);
      }),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const reporter = new TraceOptixReporter({ junitFile: "reports/junit.xml" });
    reporter.onBegin(config(directory), { allTests: () => [testCase()] });
    reporter.onTestEnd(testCase(), {
      retry: 0,
      status: "failed",
      duration: 20,
      attachments: [
        { name: "failure", contentType: "text/plain", body: Buffer.from("failure secret") },
      ],
      steps: [],
    });
    reporter.onTestEnd(testCase(), {
      retry: 1,
      status: "passed",
      duration: 25,
      attachments: [{ name: "trace", contentType: "application/zip", body: Buffer.from("secret") }],
      steps: [],
    });
    await reporter.onExit();

    expect(calls).toHaveLength(2);
    expect(calls.some(({ url }) => url.endsWith("/api/v1/runs"))).toBe(false);
    expect(calls.some(({ url }) => url.startsWith("https://storage.example"))).toBe(false);
    const body = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      project: "checkout-web",
      policyRevision: 3,
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      errored: 0,
      blocked: 0,
      flaky: 1,
    });
    expect(String(calls[1]?.init.body)).not.toContain("secret");
    expect(stdout.mock.calls.flat().join(" ")).toContain("Published Summary-only run");
    await expect(readdir(join(directory, "reports", "traceoptix-bundles"))).rejects.toThrow();
  });

  it("skips as one gate when credentials are incomplete", () => {
    delete process.env.TRACEOPTIX_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const reporter = new TraceOptixReporter({ junitFile: "reports/junit.xml" });
    reporter.onBegin(config(directory), { allTests: () => [] });

    expect(fetchMock).not.toHaveBeenCalled();
    const output = stderr.mock.calls.flat().join("");
    expect(output).toContain("TraceOptix reporter is not configured");
    expect(output).toContain("Missing configuration: TRACEOPTIX_TOKEN");
    expect(output).toContain("TRACEOPTIX_URL=https://traceoptix.example.com");
    expect(output).toContain("TRACEOPTIX_RUN_NAME=checkout-e2e");
    expect(output).toContain("TRACEOPTIX_CI_JOB_URL=https://ci.example/jobs/12001");
    expect(output).toContain("withTraceOptixDefaults");
    expect(output).toContain("['@traceoptix/playwright', { junitFile }]");
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

    const reporter = new TraceOptixReporter({ junitFile: "reports/junit.xml" });
    reporter.onBegin(config(directory), { allTests: () => [] });

    const output = stderr.mock.calls.flat().join("");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(output).toContain("TraceOptix run context is incomplete; publishing will continue");
    expect(output).toContain("TRACEOPTIX_RUN_NAME (or reporter name option)");
    expect(output).toContain("TRACEOPTIX_CI_BUILD_ID or TRACEOPTIX_CI_BUILD_NUMBER");
    expect(output).toContain("TRACEOPTIX_CI_JOB_NAME");
    expect(output).toContain("TRACEOPTIX_CI_JOB_URL or TRACEOPTIX_CI_PIPELINE_URL");
    expect(output).toMatch(/Run name for this publication: Playwright run-\d{8}T\d{9}Z/);
  });

  it("does not publish during Playwright test discovery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const reporter = new TraceOptixReporter({ junitFile: "reports/junit.xml" });

    reporter.onBegin(
      { ...config(directory), argv: ["node", "playwright", "test", "--list"] },
      {
        allTests: () => [testCase()],
      },
    );
    await reporter.onExit();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recognizes discovery on Playwright versions that do not expose config.argv", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const reporter = new TraceOptixReporter({ junitFile: "reports/junit.xml" });
    const originalArguments = process.argv;
    process.argv = ["node", "playwright", "test", "--list"];
    try {
      reporter.onBegin(config(directory), { allTests: () => [testCase()] });
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
    const reporter = new TraceOptixReporter({ junitFile: "reports/junit.xml" });

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

function testCase(tags: string[] = [], title = "pays with a saved card"): ReporterTestCase {
  return {
    title,
    tags,
    titlePath: () => ["", "chromium", "specs/checkout.spec.ts", "Checkout", title],
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
