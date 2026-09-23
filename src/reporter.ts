import { randomUUID } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { prepareAttachments, safeErrorMessage } from "./attachments.js";
import {
  HttpError,
  Semaphore,
  TestCenterClient,
  type ArtifactUpload,
  type CreateRunResponse,
} from "./client.js";
import { detectMetadata } from "./metadata.js";
import { prepareSteps } from "./steps.js";
import type {
  ReporterFullConfig,
  ReporterSuite,
  ReporterTestCase,
  ReporterTestResult,
  TestCenterReporterOptions,
} from "./types.js";

interface ActiveRun {
  client: TestCenterClient;
  response: CreateRunResponse;
  reportUpload: ArtifactUpload;
  junitPath: string;
  organization?: string;
  baseUrl: string;
}

interface ResolvedSettings {
  baseUrl: string;
  token: string;
  project: string;
  junitPath: string;
  organization?: string;
}

const CONFIGURATION_GUIDE =
  "https://github.com/nityagautam/TestCenter/tree/v1/src/packages/reporter-playwright#configure";

export default class TestCenterReporter {
  private readonly options: TestCenterReporterOptions;
  private readonly uploads: Semaphore;
  private runPromise: Promise<ActiveRun | null> | undefined;
  private readonly pending = new Set<Promise<void>>();
  private rootDir = process.cwd();

  constructor(options: TestCenterReporterOptions = { junitFile: "" }) {
    this.options = options;
    const requested = Math.floor(options.uploadConcurrency ?? 3);
    this.uploads = new Semaphore(
      Number.isFinite(requested) ? Math.max(1, Math.min(16, requested)) : 3,
    );
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: ReporterFullConfig, suite: ReporterSuite): void {
    // `playwright test --list` initializes reporters but executes nothing. It must remain a
    // read-only discovery command rather than leaving an empty pending run behind.
    if (config.argv?.includes("--list") || process.argv.includes("--list")) return;
    this.rootDir = config.rootDir;
    const settings = this.resolveSettings(config);
    if (typeof settings === "string") {
      this.configurationWarning(settings);
      return;
    }

    const detected = detectMetadata(process.env);
    const branch = this.options.branch ?? process.env.TESTCENTER_BRANCH ?? detected.branch;
    const commitSha =
      this.options.commitSha ?? process.env.TESTCENTER_COMMIT_SHA ?? detected.commitSha;
    const pullRequest =
      this.options.pullRequest ??
      positiveInteger(process.env.TESTCENTER_PULL_REQUEST) ??
      detected.pullRequest;
    const shard = config.shard
      ? {
          groupId: first(
            process.env.TESTCENTER_SHARD_GROUP,
            detected.ci?.buildId,
            randomUUID(),
          ) as string,
          index: config.shard.current - 1,
          total: config.shard.total,
        }
      : undefined;

    const client = new TestCenterClient(settings.baseUrl, settings.token);
    const artifactName = basename(settings.junitPath);
    const body = {
      project: settings.project,
      name: first(
        this.options.name,
        process.env.TESTCENTER_RUN_NAME,
        defaultRunName(detected.ci?.buildNumber),
      ),
      framework: "playwright",
      environment: first(this.options.environment, process.env.TESTCENTER_ENVIRONMENT),
      branch,
      commitSha,
      pullRequest,
      startedAt: new Date().toISOString(),
      ci: detected.ci,
      shard,
      tags: normalizeTags({
        ...this.options.tags,
        "playwright-version": config.version,
        "test-count": String(suite.allTests().length),
      }),
      artifacts: [{ filename: artifactName, contentType: "application/xml", format: "junit-xml" }],
    };

    this.runPromise = client
      .createRun(removeUndefined(body), randomUUID())
      .then((response) => {
        const reportUpload = response.uploads[0];
        if (!reportUpload) throw new Error("run creation returned no JUnit upload URL");
        return {
          client,
          response,
          reportUpload,
          junitPath: settings.junitPath,
          organization: settings.organization,
          baseUrl: settings.baseUrl,
        };
      })
      .catch((error: unknown) => {
        this.warn(`Could not create the run: ${safeErrorMessage(error)}`);
        return null;
      });
  }

  onTestEnd(test: ReporterTestCase, result: ReporterTestResult): void {
    if (!this.runPromise || (result.attachments.length === 0 && !result.steps?.length)) return;
    const task = this.uploadTestDetails(this.runPromise, test, result).catch((error: unknown) => {
      this.warn(`Could not publish test details for "${test.title}": ${safeErrorMessage(error)}`);
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  /**
   * Playwright invokes this after every reporter's onEnd has completed. That ordering is what
   * makes it safe to consume the built-in JUnit reporter's file, including any later enrichment.
   */
  async onExit(): Promise<void> {
    if (!this.runPromise) return;
    const run = await this.runPromise;
    await Promise.allSettled([...this.pending]);
    if (!run) return;

    try {
      const metadata = await stat(run.junitPath);
      if (!metadata.isFile() || metadata.size === 0) {
        throw new Error(`JUnit report is missing or empty: ${run.junitPath}`);
      }
      const report = await readFile(run.junitPath);

      let upload = run.reportUpload;
      if (run.client.isNearExpiry(upload)) {
        upload = await run.client.refreshArtifact(run.response.runId, upload.artifactId);
      }
      try {
        await run.client.put(upload, report);
      } catch (error) {
        if (!(error instanceof HttpError) || ![401, 403].includes(error.status)) throw error;
        upload = await run.client.refreshArtifact(run.response.runId, upload.artifactId);
        await run.client.put(upload, report);
      }

      const completed = await run.client.complete(run.response);
      if (completed.missingAttachments && completed.missingAttachments.length > 0) {
        this.warn(`${completed.missingAttachments.length} evidence upload(s) are missing.`);
      }
      const runUrl = browserRunUrl(run);
      this.output(runUrl ? `Published run: ${runUrl}` : `Published run ${run.response.runId}.`);
      if (runUrl) await this.writeGithubSummary(runUrl);
    } catch (error) {
      this.warn(`Could not publish the JUnit report: ${safeErrorMessage(error)}`);
    }
  }

  private async uploadTestDetails(
    runPromise: Promise<ActiveRun | null>,
    test: ReporterTestCase,
    result: ReporterTestResult,
  ): Promise<void> {
    const run = await runPromise;
    if (!run) return;
    const steps = prepareSteps(test, result, this.rootDir, (message) => this.warn(message));
    let stepsDeclared = false;
    if (steps.batch) {
      try {
        await run.client.declareSteps(run.response, steps.batch);
        stepsDeclared = true;
      } catch (error) {
        this.warn(`Could not record steps for "${test.title}": ${safeErrorMessage(error)}`);
      }
    }

    const attachments = await prepareAttachments(
      test,
      result,
      this.rootDir,
      (message) => this.warn(message),
      stepsDeclared ? steps.stepIdForAttachment : undefined,
    );
    if (attachments.length === 0) return;

    const declared = await run.client.declareAttachments(
      run.response,
      attachments.map((attachment) => attachment.declaration),
    );
    if (declared.uploads.length !== attachments.length) {
      throw new Error(
        `Test Center returned ${declared.uploads.length} of ${attachments.length} evidence upload URLs`,
      );
    }

    await Promise.all(
      declared.uploads.map((upload, index) => {
        const attachment = attachments[index];
        if (!attachment) throw new Error("evidence upload order did not match its declaration");
        return this.uploads.use(() => run.client.put(upload, attachment.body));
      }),
    );
  }

  private resolveSettings(config: ReporterFullConfig): ResolvedSettings | string {
    const baseUrl = first(this.options.url, process.env.TESTCENTER_URL);
    const token = first(process.env.TESTCENTER_TOKEN);
    const project = first(this.options.project, process.env.TESTCENTER_PROJECT);
    const junitFile = first(this.options.junitFile);
    const missing = [
      !baseUrl ? "TESTCENTER_URL" : undefined,
      !token ? "TESTCENTER_TOKEN" : undefined,
      !project ? "TESTCENTER_PROJECT (or reporter project option)" : undefined,
      !junitFile ? "reporter junitFile option" : undefined,
    ].filter((value): value is string => value !== undefined);
    if (missing.length > 0) return `missing ${missing.join(", ")}`;
    if (!baseUrl || !token || !project || !junitFile) {
      return "required publishing settings did not resolve";
    }

    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "TESTCENTER_URL must use http or https";
      }
    } catch {
      return "TESTCENTER_URL is not a valid URL";
    }

    return {
      baseUrl,
      token,
      project,
      // Playwright's rootDir is the test directory, not the directory containing its config.
      // Built-in reporter output paths are config-relative, so resolve the consumer path the same
      // way or generated test directories (for example playwright-bdd) silently add a prefix.
      junitPath: resolve(
        config.configFile ? dirname(resolve(config.configFile)) : process.cwd(),
        junitFile,
      ),
      organization: first(this.options.organization, process.env.TESTCENTER_ORG),
    };
  }

  private warn(message: string): void {
    process.stderr.write(`[testcenter] Warning: ${safeErrorMessage(message)}\n`);
  }

  /**
   * A disabled integration must explain how to enable itself. A bare "missing token" warning is
   * technically correct but leaves the person running the suite to reverse-engineer both the
   * environment and the paired JUnit reporter before they can act on it.
   *
   * This remains warning-only: local contributors commonly do not publish, and observability
   * configuration must never turn a passing test suite red.
   */
  private configurationWarning(reason: string): void {
    const lines = [
      "Test Center reporter is not configured; this run will not be published.",
      `Missing configuration: ${reason.replace(/^missing\s+/, "")}.`,
      "Configure the environment:",
      "  TESTCENTER_URL=https://testcenter.example.com",
      "  TESTCENTER_TOKEN=tc_...",
      "  TESTCENTER_PROJECT=checkout-web",
      "Configure playwright.config.ts with the JUnit and Test Center reporters:",
      "  const junitFile = 'test-results/junit.xml';",
      "  reporter: [",
      "    ['junit', { outputFile: junitFile, includeRetries: true }],",
      "    ['@testcenter/playwright', { junitFile }],",
      "  ]",
      `Setup guide: ${CONFIGURATION_GUIDE}`,
    ];
    process.stderr.write(`${lines.map((line) => `[testcenter] ${line}`).join("\n")}\n`);
  }

  private output(message: string): void {
    process.stdout.write(`[testcenter] ${message}\n`);
  }

  private async writeGithubSummary(runUrl: string): Promise<void> {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary) return;
    try {
      await appendFile(summary, `\n[Test Center run](${runUrl})\n`, "utf8");
    } catch (error) {
      this.warn(`Could not update the GitHub job summary: ${safeErrorMessage(error)}`);
    }
  }
}

function browserRunUrl(run: ActiveRun): string | undefined {
  if (!run.organization) return undefined;
  const path = `/o/${encodeURIComponent(run.organization)}/runs/${encodeURIComponent(run.response.runId)}`;
  return new URL(path, `${run.baseUrl}/`).toString();
}

function defaultRunName(buildNumber: string | undefined): string {
  return buildNumber ? `Playwright build ${buildNumber}` : "Playwright run";
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "")?.trim();
}

function normalizeTags(input: Record<string, string | undefined>): Record<string, string> {
  const entries = Object.entries(input)
    .map(([rawKey, rawValue]) => {
      const key = rawKey.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
      const value = rawValue?.trim().slice(0, 200);
      return key && value && /^[a-z0-9][a-z0-9_-]*$/.test(key) ? ([key, value] as const) : null;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null)
    .slice(0, 50);
  return Object.fromEntries(entries);
}

function removeUndefined<Value extends object>(input: Value): Value {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Value;
}
