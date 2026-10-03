import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { StepBatch } from "./steps.js";

const require = createRequire(import.meta.url);
const exec = promisify(execFile);

it.each([
  { mode: "full", moduleType: "module" },
  { mode: "full", moduleType: "commonjs" },
  { mode: "summary_only", moduleType: "module" },
])(
  "runs a real non-BDD API suite with $moduleType and respects $mode publication",
  async ({ mode, moduleType }) => {
    const directory = await mkdtemp(
      join(tmpdir(), "traceoptix-api-integration-"),
    );
    const calls: Array<{ path: string; body: Buffer; auth?: string }> = [];
    let origin = "";
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const path = request.url!;
      calls.push({ path, body, auth: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      const send = (value: unknown) => response.end(JSON.stringify(value));
      if (path.startsWith("/items")) {
        response.setHeader("set-cookie", "session=response-cookie-secret");
        return send({ id: 42, token: "response-body-secret" });
      }
      if (path.endsWith("publish-capabilities"))
        return send({
          schemaVersion: 1,
          project: "api-tests",
          collectionMode: mode,
          policyRevision: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
          summarySchemaVersion: 1,
          summary: {
            limit: 500,
            used: 0,
            remaining: 500,
            periodEnd: "2099-01-01T00:00:00.000Z",
          },
          summaryUrl: "/api/v1/runs/summary",
        });
      const upload = (name: string) => ({
        artifactId: name,
        filename: name,
        uploadUrl: `${origin}/upload/${name}`,
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      if (path === "/api/v1/runs")
        return send({
          runId: "api-run",
          uploads: [upload("junit.xml")],
          attachmentUrl: "/attachments",
          stepsUrl: "/steps",
          testPrioritiesUrl: "/priorities",
          completeUrl: "/complete",
        });
      if (path === "/attachments") {
        const declarations = JSON.parse(body.toString()).attachments as Array<{
          name: string;
        }>;
        return send({
          uploads: declarations.map((a, i) => ({
            ...upload(a.name),
            attachmentId: a.name,
            index: i,
          })),
        });
      }
      if (path === "/api/v1/runs/summary")
        return send({
          runId: "summary-run",
          status: "complete",
          dataMode: "summary_only",
        });
      if (path === "/complete")
        return send({ runId: "api-run", missingAttachments: [] });
      return send({ declared: 1, inserted: 1 });
    });
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No fixture server address");
      origin = `http://127.0.0.1:${address.port}`;
      const entry = resolve("dist/test.cjs");
      const reporter = resolve("dist/index.js");
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ type: moduleType }),
      );
      await writeFile(
        join(directory, "api.spec.ts"),
        `
      import { test, expect } from ${JSON.stringify(entry)};
      test('ordinary API test', async ({ request }) => {
        await test.step('Create item', async () => {
          const response = await request.post('/items?token=query-secret', {
            headers: { authorization: 'Bearer request-secret' },
            data: { name: "Bob's item", password: 'request-body-secret' }
          });
          expect(response.status()).toBe(200);
          expect((await response.json()).id).toBe(42);
        });
      });
      test('retry API test', async ({ request }, info) => {
        await request.get('/items');
        expect(info.retry).toBe(1);
      });
    `,
      );
      await writeFile(
        join(directory, "playwright.config.ts"),
        `
      export default {
        testDir: '.', workers: 1, retries: 1,
        reporter: [
          ['junit', { outputFile: ${JSON.stringify(join(directory, "junit.xml"))} }],
          [${JSON.stringify(reporter)}, { junitFile: ${JSON.stringify(join(directory, "junit.xml"))}, project: 'api-tests',
            url: ${JSON.stringify(origin)}, bundle: { mode: 'off' } }]
        ],
        use: { baseURL: ${JSON.stringify(origin)}, trace: 'off' }
      };
    `,
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("TRACEOPTIX_") && key !== "NODE_OPTIONS",
        ),
      );
      const { stdout, stderr } = await exec(
        process.execPath,
        [
          require.resolve("@playwright/test/cli"),
          "test",
          "--config",
          join(directory, "playwright.config.ts"),
        ],
        {
          cwd: directory,
          timeout: 30_000,
          env: {
            ...env,
            TRACEOPTIX_TOKEN: "publisher-secret",
            FORCE_COLOR: "0",
          },
        },
      ).catch((error: { stdout?: string; stderr?: string }) => {
        throw new Error(
          `Playwright fixture failed:\n${error.stdout}\n${error.stderr}`,
        );
      });
      expect(stderr).not.toContain("Could not publish");
      const apiCall = calls.find((c) => c.path.startsWith("/items?"))!;
      expect(apiCall.auth).toBe("Bearer request-secret");
      expect(apiCall.body.toString()).toContain("request-body-secret");
      if (mode === "summary_only") {
        expect(stdout).toContain("Published Summary-only run");
        expect(
          calls.some(
            (c) =>
              c.path.startsWith("/upload/") ||
              c.path === "/steps" ||
              c.path === "/attachments",
          ),
        ).toBe(false);
        const summary = JSON.parse(
          calls.find((c) => c.path === "/api/v1/runs/summary")!.body.toString(),
        );
        expect(summary).toMatchObject({ total: 2, passed: 2, flaky: 1 });
      } else {
        expect(calls.some((c) => c.path === "/complete")).toBe(true);
        const batches = calls
          .filter((c) => c.path === "/steps")
          .map((c) => JSON.parse(c.body.toString()) as StepBatch);
        const ordinary = batches.find((b) => b.test === "ordinary API test")!;
        expect(ordinary.steps.some((s) => s.title === "Create item")).toBe(
          true,
        );
        expect(ordinary.steps.some((s) => s.category === "expect")).toBe(true);
        const apiStep = ordinary.steps.find((s) => s.title === "API POST")!;
        const inlineCurl = apiStep.annotations?.find(
          (annotation) => annotation.type === "curl",
        )?.description;
        expect(inlineCurl).toContain("curl --request 'POST'");
        expect(inlineCurl).toContain("[REDACTED]");
        expect(inlineCurl).not.toContain("request-secret");
        expect(inlineCurl).not.toContain("request-body-secret");
        expect(apiStep.parentId).toBe(
          ordinary.steps.find((s) => s.title === "Create item")?.id,
        );
        const attachments = calls
          .filter((c) => c.path === "/attachments")
          .flatMap((c) => JSON.parse(c.body.toString()).attachments);
        expect(
          attachments.some(
            (a) => a.name.endsWith(".curl.txt") && a.stepId === apiStep.id,
          ),
        ).toBe(true);
        expect(
          batches
            .filter((b) => b.test === "retry API test")
            .map((b) => b.attempt),
        ).toEqual([0, 1]);
        const uploaded = calls.filter((c) => c.path.startsWith("/upload/api-"));
        expect(uploaded.length).toBe(6);
        expect(uploaded.every((c) => !c.auth)).toBe(true);
        expect(
          uploaded.some(
            (c) =>
              c.path.endsWith(".curl.txt") &&
              c.body.toString().trim() === inlineCurl,
          ),
        ).toBe(true);
        const evidence = uploaded.map((c) => c.body.toString()).join("\n");
        for (const secret of [
          "response-cookie-secret",
          "response-body-secret",
          "request-secret",
          "request-body-secret",
          "query-secret",
          "publisher-secret",
        ])
          expect(evidence).not.toContain(secret);
        expect(evidence).toContain("curl --request 'POST'");
      }
    } finally {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
  45_000,
);
