import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      if (url === "https://testcenter.example/api/v1/runs/run-1/complete") {
        return jsonResponse({ runId: "run-1", status: "parsing" });
      }
      if (url.startsWith("https://storage.example/")) return new Response(null, { status: 200 });
      return jsonResponse({ message: "unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const reporter = new TestCenterReporter({ junitFile: "reports/junit.xml" });
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
    expect(JSON.parse(String(create?.init.body))).toEqual(
      expect.objectContaining({ project: "checkout-web", framework: "playwright" }),
    );

    const declaration = calls.find(({ url }) => url.endsWith("/attachment-upload-urls"));
    expect(JSON.parse(String(declaration?.init.body))).toEqual({
      attachments: [
        expect.objectContaining({
          kind: "trace",
          test: "pays with a saved card",
          suite: "specs/checkout.spec.ts",
          attempt: 1,
        }),
      ],
    });

    const storageCalls = calls.filter(({ url }) => url.startsWith("https://storage.example/"));
    expect(storageCalls).toHaveLength(2);
    for (const call of storageCalls) {
      expect(new Headers(call.init.headers).has("authorization")).toBe(false);
    }
    expect(calls.at(-1)?.url).toBe("https://testcenter.example/api/v1/runs/run-1/complete");
  });

  it("skips as one gate when credentials are incomplete", () => {
    delete process.env.TESTCENTER_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const reporter = new TestCenterReporter({ junitFile: "reports/junit.xml" });
    reporter.onBegin(config(directory), { allTests: () => [] });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("missing TESTCENTER_TOKEN"));
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
  return {
    retry: 1,
    attachments: [{ name: "trace", contentType: "application/zip", body: Buffer.from("zip body") }],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
