import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { withTraceOptixDefaults } from "@traceoptix/playwright";
import type { TraceOptixTestOptions } from "@traceoptix/playwright/test";

/** Each example writes its own reports and bundles, even when both are run together. */
export function exampleConfig(directory: string, name: string) {
  const junitFile = resolve(directory, "test-results/junit.xml");
  return withTraceOptixDefaults(
    defineConfig<TraceOptixTestOptions>({
      fullyParallel: false,
      workers: 1,
      retries: 0,
      timeout: 30_000,
      expect: { timeout: 5_000 },
      outputDir: resolve(directory, "test-results/artifacts"),
      reporter: [
        ["list"],
        [
          "html",
          {
            outputFolder: resolve(directory, "playwright-report"),
            open: "never",
          },
        ],
        ["junit", { outputFile: junitFile, includeRetries: true }],
        [
          createRequire(import.meta.url).resolve("@traceoptix/playwright"),
          {
            junitFile,
            name: process.env.TRACEOPTIX_RUN_NAME
              ? `${process.env.TRACEOPTIX_RUN_NAME} - ${name === "wikipedia-bdd" ? "BDD" : "Plain Playwright"}`
              : name,
            tags: { example: name },
            bundle: {
              mode: "always",
              outputDir: resolve(directory, "test-results/traceoptix-bundles"),
            },
          },
        ],
      ],
      use: {
        baseURL: "https://en.wikipedia.org",
        userAgent:
          "TraceOptixPlaywrightExamples/1.0 (Wikipedia read-only test examples)",
        screenshot: "on",
        video: "on",
        traceoptixApi: { maxBodyBytes: 64 * 1024, maxRequests: 20 },
      },
    }),
  );
}
