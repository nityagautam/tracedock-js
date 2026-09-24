import { randomUUID } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { prepareAttachments, safeErrorMessage } from "./attachments.js";
import { PortableRunBundle, resolveBundleMode, type BundleMode } from "./bundle.js";
import {
  HttpError,
  Semaphore,
  TestCenterClient,
  type ArtifactUpload,
  type CreateRunResponse,
} from "./client.js";
import { detectMetadata, resolveCiContext } from "./metadata.js";
import { prepareTestPriorities, priorityTagsEnabled } from "./priorities.js";
import { formatRunName } from "./run-name.js";
import { prepareSteps } from "./steps.js";
import type {
  ReporterFullConfig,
  ReporterSuite,
  ReporterTestCase,
  ReporterTestResult,
  TestCenterCiOptions,
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

interface PublishSettings {
  baseUrl: string;
  token: string;
  project: string;
  organization?: string;
}

interface ResolvedPaths {
  junitPath: string;
  bundleMode: BundleMode;
  bundleOutputDirectory: string;
}

const CONFIGURATION_GUIDE =
  "https://github.com/nityagautam/TestCenter/tree/v1/src/packages/reporter-playwright#configure";

export default class TestCenterReporter {
  private readonly options: TestCenterReporterOptions;
  private readonly uploads: Semaphore;
  private runPromise: Promise<ActiveRun | null> | undefined;
  private readonly pending = new Set<Promise<void>>();
  private rootDir = process.cwd();
  private junitPath: string | undefined;
  private bundle: PortableRunBundle | undefined;
  private publishFailed = false;

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
    const paths = this.resolvePaths(config);
    if (typeof paths === "string") {
      this.configurationWarning(paths);
      return;
    }
    this.junitPath = paths.junitPath;
    const allTests = suite.allTests();
    const testPriorities = priorityTagsEnabled(
      this.options.priority?.fromTags,
      process.env.TESTCENTER_PRIORITY_FROM_TAGS,
    )
      ? prepareTestPriorities(allTests, this.rootDir, (message) => this.warn(message))
      : [];

    const detected = detectMetadata(process.env);
    const startedAt = new Date();
    const branch = this.options.branch ?? process.env.TESTCENTER_BRANCH ?? detected.branch;
    const commitSha =
      this.options.commitSha ?? process.env.TESTCENTER_COMMIT_SHA ?? detected.commitSha;
    const pullRequest =
      this.options.pullRequest ??
      positiveInteger(process.env.TESTCENTER_PULL_REQUEST) ??
      detected.pullRequest;
    const ci = resolveCiContext(this.options.ci, process.env, detected.ci);
    const shard = config.shard
      ? {
          groupId: first(process.env.TESTCENTER_SHARD_GROUP, ci?.buildId, randomUUID()) as string,
          index: config.shard.current - 1,
          total: config.shard.total,
        }
      : undefined;

    const configuredRunName = first(this.options.name, process.env.TESTCENTER_RUN_NAME);
    const baseRunName = configuredRunName ?? defaultRunName(ci?.buildNumber);
    const runName = formatRunName(
      baseRunName,
      startedAt,
      first(this.options.namePattern, process.env.TESTCENTER_RUN_NAME_PATTERN),
    );
    const missingContext = missingRunContext(configuredRunName, ci);
    if (missingContext.length > 0) this.runContextWarning(missingContext, runName);
    const bundleId = randomUUID();
    const publishSettings = this.resolvePublishSettings();
    const projectHint =
      typeof publishSettings === "string"
        ? first(this.options.project, process.env.TESTCENTER_PROJECT)
        : publishSettings.project;
    if (paths.bundleMode !== "off") {
      this.bundle = new PortableRunBundle({
        bundleId,
        mode: paths.bundleMode,
        outputDirectory: paths.bundleOutputDirectory,
        projectHint,
        playwrightVersion: config.version,
        run: removeUndefined({
          name: runName,
          framework: "playwright" as const,
          environment: first(this.options.environment, process.env.TESTCENTER_ENVIRONMENT),
          branch,
          commitSha,
          pullRequest,
          startedAt: startedAt.toISOString(),
          ci,
          shard,
          tags: normalizeTags({
            ...this.options.tags,
            "playwright-version": config.version,
            "test-count": String(allTests.length),
          }),
        }),
        testPriorities,
      });
    }
    if (typeof publishSettings === "string") {
      this.publishFailed = true;
      this.configurationWarning(publishSettings);
      return;
    }

    const client = new TestCenterClient(publishSettings.baseUrl, publishSettings.token);
    const artifactName = basename(paths.junitPath);
    const body = {
      project: publishSettings.project,
      name: runName,
      framework: "playwright",
      environment: first(this.options.environment, process.env.TESTCENTER_ENVIRONMENT),
      branch,
      commitSha,
      pullRequest,
      startedAt: startedAt.toISOString(),
      ci,
      shard,
      tags: normalizeTags({
        ...this.options.tags,
        "playwright-version": config.version,
        "test-count": String(allTests.length),
      }),
      sourceBundleId: bundleId,
      artifacts: [{ filename: artifactName, contentType: "application/xml", format: "junit-xml" }],
    };

    this.runPromise = client
      .createRun(removeUndefined(body), bundleId)
      .then(async (response) => {
        const reportUpload = response.uploads[0];
        if (!reportUpload) throw new Error("run creation returned no JUnit upload URL");
        if (testPriorities.length > 0) {
          try {
            await client.declareTestPriorities(response, testPriorities);
          } catch (error) {
            this.publishFailed = true;
            this.warn(`Could not publish testcase priorities: ${safeErrorMessage(error)}`);
          }
        }
        return {
          client,
          response,
          reportUpload,
          junitPath: paths.junitPath,
          organization: publishSettings.organization,
          baseUrl: publishSettings.baseUrl,
        };
      })
      .catch((error: unknown) => {
        this.publishFailed = true;
        this.warn(`Could not create the run: ${safeErrorMessage(error)}`);
        return null;
      });
  }

  onTestEnd(test: ReporterTestCase, result: ReporterTestResult): void {
    if (
      (!this.runPromise && !this.bundle) ||
      (result.attachments.length === 0 && !result.steps?.length)
    )
      return;
    const task = this.captureAndPublishTestDetails(test, result).catch((error: unknown) => {
      this.publishFailed = true;
      this.warn(`Could not capture test details for "${test.title}": ${safeErrorMessage(error)}`);
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  /**
   * Playwright invokes this after every reporter's onEnd has completed. That ordering is what
   * makes it safe to consume the built-in JUnit reporter's file, including any later enrichment.
   */
  async onExit(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    const run = this.runPromise ? await this.runPromise : null;
    const junitPath = this.junitPath;
    if (!junitPath) return;

    if (run) {
      try {
        const metadata = await stat(junitPath);
        if (!metadata.isFile() || metadata.size === 0) {
          throw new Error(`JUnit report is missing or empty: ${junitPath}`);
        }
        const report = await readFile(junitPath);

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
          this.publishFailed = true;
          this.warn(`${completed.missingAttachments.length} evidence upload(s) are missing.`);
        }
        const runUrl = browserRunUrl(run);
        this.output(runUrl ? `Published run: ${runUrl}` : `Published run ${run.response.runId}.`);
        if (runUrl) await this.writeGithubSummary(runUrl);
      } catch (error) {
        this.publishFailed = true;
        this.warn(`Could not publish the JUnit report: ${safeErrorMessage(error)}`);
      }
    } else {
      this.publishFailed = true;
    }

    if (this.bundle) {
      const retain = this.bundle.mode === "always" || this.publishFailed;
      try {
        if (retain) {
          const outputPath = await this.bundle.finalize(junitPath);
          this.output(`Portable run bundle: ${outputPath}`);
          this.output("Upload this ZIP from the Test Center project Upload page.");
        } else {
          await this.bundle.discard();
        }
      } catch (error) {
        this.warn(`Could not create the portable run bundle: ${safeErrorMessage(error)}`);
      }
    }
  }

  private async captureAndPublishTestDetails(
    test: ReporterTestCase,
    result: ReporterTestResult,
  ): Promise<void> {
    const steps = prepareSteps(test, result, this.rootDir, (message) => this.warn(message));
    const attachments = await prepareAttachments(
      test,
      result,
      this.rootDir,
      (message) => this.warn(message),
      steps.stepIdForAttachment,
    );
    if (this.bundle) {
      try {
        await this.bundle.addAttempt({
          ...(steps.batch?.suite ? { suite: steps.batch.suite } : {}),
          test: test.title.slice(0, 1_000),
          attempt: result.retry,
          steps: steps.batch,
          attachments,
        });
      } catch (error) {
        this.warn(
          `Could not stage offline details for "${test.title}": ${safeErrorMessage(error)}`,
        );
      }
    }

    const run = this.runPromise ? await this.runPromise : null;
    if (!run) return;
    if (steps.batch) {
      try {
        await run.client.declareSteps(run.response, steps.batch);
      } catch (error) {
        this.publishFailed = true;
        this.warn(`Could not record steps for "${test.title}": ${safeErrorMessage(error)}`);
      }
    }
    if (attachments.length === 0) return;

    try {
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
    } catch (error) {
      this.publishFailed = true;
      this.warn(`Could not publish evidence for "${test.title}": ${safeErrorMessage(error)}`);
    }
  }

  private resolvePublishSettings(): PublishSettings | string {
    const baseUrl = first(this.options.url, process.env.TESTCENTER_URL);
    const token = first(process.env.TESTCENTER_TOKEN);
    const project = first(this.options.project, process.env.TESTCENTER_PROJECT);
    const missing = [
      !baseUrl ? "TESTCENTER_URL" : undefined,
      !token ? "TESTCENTER_TOKEN" : undefined,
      !project ? "TESTCENTER_PROJECT (or reporter project option)" : undefined,
    ].filter((value): value is string => value !== undefined);
    if (missing.length > 0) return `missing ${missing.join(", ")}`;
    if (!baseUrl || !token || !project) {
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
      organization: first(this.options.organization, process.env.TESTCENTER_ORG),
    };
  }

  private resolvePaths(config: ReporterFullConfig): ResolvedPaths | string {
    const junitFile = first(this.options.junitFile);
    if (!junitFile) return "missing reporter junitFile option";
    const configDirectory = config.configFile ? dirname(resolve(config.configFile)) : process.cwd();
    const junitPath = resolve(configDirectory, junitFile);
    const requestedMode = first(this.options.bundle?.mode, process.env.TESTCENTER_BUNDLE_MODE);
    if (requestedMode && !["always", "on-failure", "off"].includes(requestedMode)) {
      this.warn(`Unknown bundle mode "${requestedMode}"; using "always".`);
    }
    const bundleOutput = first(
      this.options.bundle?.outputDir,
      process.env.TESTCENTER_BUNDLE_OUTPUT_DIR,
    );
    return {
      junitPath,
      bundleMode: resolveBundleMode(requestedMode),
      bundleOutputDirectory: bundleOutput
        ? resolve(configDirectory, bundleOutput)
        : join(dirname(junitPath), "testcenter-bundles"),
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
      "Configure run and CI context (recommended):",
      "  TESTCENTER_RUN_NAME=checkout-e2e",
      "  TESTCENTER_CI_PROVIDER=github",
      "  TESTCENTER_CI_BUILD_NUMBER=84",
      "  TESTCENTER_CI_PIPELINE_NAME='Nightly regression'",
      "  TESTCENTER_CI_JOB_NAME=playwright-chromium",
      "  TESTCENTER_CI_JOB_URL=https://ci.example/jobs/12001",
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

  /** Missing labels should be discoverable without making observability break the test command. */
  private runContextWarning(missing: readonly string[], runName: string): void {
    const lines = [
      "Test Center run context is incomplete; publishing will continue.",
      `Missing configuration: ${missing.join(", ")}.`,
      `Run name for this publication: ${runName}.`,
      "Set reporter options (name, ci) or the corresponding TESTCENTER_RUN_NAME and TESTCENTER_CI_* environment variables.",
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

function missingRunContext(
  configuredRunName: string | undefined,
  ci: TestCenterCiOptions | undefined,
): string[] {
  return [
    !configuredRunName ? "TESTCENTER_RUN_NAME (or reporter name option)" : undefined,
    !ci?.provider ? "TESTCENTER_CI_PROVIDER" : undefined,
    !ci?.buildId && !ci?.buildNumber
      ? "TESTCENTER_CI_BUILD_ID or TESTCENTER_CI_BUILD_NUMBER"
      : undefined,
    !ci?.pipelineName ? "TESTCENTER_CI_PIPELINE_NAME (or TESTCENTER_CI_BUILD_NAME)" : undefined,
    !ci?.jobName ? "TESTCENTER_CI_JOB_NAME" : undefined,
    !ci?.jobUrl && !ci?.pipelineUrl
      ? "TESTCENTER_CI_JOB_URL or TESTCENTER_CI_PIPELINE_URL"
      : undefined,
  ].filter((value): value is string => value !== undefined);
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
