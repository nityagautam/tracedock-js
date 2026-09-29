import { randomUUID } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { prepareAttachments, safeErrorMessage } from "./attachments.js";
import { PortableRunBundle, resolveBundleMode, type BundleMode } from "./bundle.js";
import {
  HttpError,
  Semaphore,
  TraceDockClient,
  type ArtifactUpload,
  type CreateRunResponse,
  type PublishCapabilitiesResponse,
} from "./client.js";
import { detectMetadata, resolveCiContext } from "./metadata.js";
import { prepareTestPriorities, priorityTagsEnabled } from "./priorities.js";
import { formatRunName } from "./run-name.js";
import { resolveRunTags } from "./run-tags.js";
import { prepareSteps } from "./steps.js";
import type {
  ReporterFullConfig,
  ReporterSuite,
  ReporterTestCase,
  ReporterTestResult,
  TraceDockCiOptions,
  TraceDockReporterOptions,
} from "./types.js";

interface ActiveRun {
  client: TraceDockClient;
  response: CreateRunResponse;
  reportUpload: ArtifactUpload;
  junitPath: string;
  organization?: string;
  baseUrl: string;
}

interface PublishSettings {
  baseUrl: string;
  baseUrlSource: "playwright.config.ts url option" | "TRACEDOCK_URL";
  token: string;
  project: string;
  organization?: string;
}

interface ResolvedPaths {
  junitPath: string;
  bundleMode: BundleMode;
  bundleOutputDirectory: string;
}

type PublishMode = "full" | "summary_only";

interface SummaryPublication {
  client: TraceDockClient;
  summaryUrl: string;
  bundleId: string;
  baseUrl: string;
  organization?: string;
  startedAt: Date;
  body: Record<string, unknown>;
  outcomes: Map<string, { status: "passed" | "failed" | "skipped" | "errored"; flaky: boolean }>;
}

const CONFIGURATION_GUIDE =
  "https://github.com/nityagautam/TraceDock/tree/v1/src/packages/playwright-reporter-plugin#configure";

export default class TraceDockReporter {
  private readonly options: TraceDockReporterOptions;
  private readonly uploads: Semaphore;
  private runPromise: Promise<ActiveRun | null> | undefined;
  private modePromise: Promise<PublishMode | null> | undefined;
  private readonly pending = new Set<Promise<void>>();
  private rootDir = process.cwd();
  private junitPath: string | undefined;
  private bundle: PortableRunBundle | undefined;
  private publishFailed = false;
  private publicationSucceeded = false;
  private reportingAttempted = false;
  private publishTarget: { baseUrl: string; source: PublishSettings["baseUrlSource"] } | undefined;
  private bundlePlan: { mode: BundleMode; outputDirectory: string } | undefined;
  private bundleSuppressedReason: string | undefined;
  private summary: SummaryPublication | undefined;

  constructor(options: TraceDockReporterOptions = { junitFile: "" }) {
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
    this.reportingAttempted = true;
    this.rootDir = config.rootDir;
    const paths = this.resolvePaths(config);
    if (typeof paths === "string") {
      this.configurationWarning(paths);
      return;
    }
    this.junitPath = paths.junitPath;
    this.bundlePlan = {
      mode: paths.bundleMode,
      outputDirectory: paths.bundleOutputDirectory,
    };
    const allTests = suite.allTests();
    const testPriorities = priorityTagsEnabled(
      this.options.priority?.fromTags,
      reporterEnv("PRIORITY_FROM_TAGS"),
    )
      ? prepareTestPriorities(allTests, this.rootDir, (message) => this.warn(message))
      : [];

    const detected = detectMetadata(process.env);
    const startedAt = new Date();
    const branch = this.options.branch ?? reporterEnv("BRANCH") ?? detected.branch;
    const commitSha = this.options.commitSha ?? reporterEnv("COMMIT_SHA") ?? detected.commitSha;
    const pullRequest =
      this.options.pullRequest ??
      positiveInteger(reporterEnv("PULL_REQUEST")) ??
      detected.pullRequest;
    const ci = resolveCiContext(this.options.ci, process.env, detected.ci);
    const shard = config.shard
      ? {
          groupId: first(reporterEnv("SHARD_GROUP"), ci?.buildId, randomUUID()) as string,
          index: config.shard.current - 1,
          total: config.shard.total,
        }
      : undefined;

    const configuredRunName = first(this.options.name, reporterEnv("RUN_NAME"));
    const baseRunName = configuredRunName ?? defaultRunName(ci?.buildNumber);
    const runName = formatRunName(
      baseRunName,
      startedAt,
      first(this.options.namePattern, reporterEnv("RUN_NAME_PATTERN")),
    );
    const missingContext = missingRunContext(configuredRunName, ci);
    if (missingContext.length > 0) this.runContextWarning(missingContext, runName);
    const runTags = resolveRunTags(
      reporterEnv("RUN_TAGS"),
      this.options.tags,
      {
        "playwright-version": config.version,
        "test-count": String(allTests.length),
      },
      (message) => this.warn(message),
    );
    const bundleId = randomUUID();
    const configuredBaseUrl = first(this.options.url, reporterEnv("URL"));
    if (configuredBaseUrl) {
      this.publishTarget = {
        baseUrl: configuredBaseUrl,
        source: first(this.options.url) ? "playwright.config.ts url option" : "TRACEDOCK_URL",
      };
    }
    const publishSettings = this.resolvePublishSettings();
    const projectHint =
      typeof publishSettings === "string"
        ? first(this.options.project, reporterEnv("PROJECT"))
        : publishSettings.project;
    const createPortableBundle = () => {
      if (paths.bundleMode === "off" || this.bundle) return;
      this.bundle = new PortableRunBundle({
        bundleId,
        mode: paths.bundleMode,
        outputDirectory: paths.bundleOutputDirectory,
        projectHint,
        playwrightVersion: config.version,
        testCaseCount: allTests.length,
        run: removeUndefined({
          name: runName,
          framework: "playwright" as const,
          environment: first(this.options.environment, reporterEnv("ENVIRONMENT")),
          branch,
          commitSha,
          pullRequest,
          startedAt: startedAt.toISOString(),
          ci,
          shard,
          tags: runTags,
        }),
        testPriorities,
      });
    };
    if (typeof publishSettings === "string") {
      createPortableBundle();
      this.publishFailed = true;
      this.configurationWarning(publishSettings);
      return;
    }

    this.publishTarget = {
      baseUrl: publishSettings.baseUrl,
      source: publishSettings.baseUrlSource,
    };
    this.reportPublishingPlan(publishSettings, paths);

    const client = new TraceDockClient(publishSettings.baseUrl, publishSettings.token);
    const commonBody = {
      project: publishSettings.project,
      name: runName,
      framework: "playwright",
      environment: first(this.options.environment, reporterEnv("ENVIRONMENT")),
      branch,
      commitSha,
      pullRequest,
      startedAt: startedAt.toISOString(),
      ci,
      shard,
      tags: runTags,
      sourceBundleId: bundleId,
    };

    this.modePromise = client
      .getPublishCapabilities(
        publishSettings.project,
        boundedInteger(this.options.capabilityTimeoutMs, 500, 30_000, 5_000),
      )
      .then(async (capability: PublishCapabilitiesResponse) => {
        if (capability.collectionMode === "summary_only") {
          if (!capability.summary || capability.summary.remaining <= 0) {
            throw new Error("Summary-only publishing is unavailable or its allowance is exhausted");
          }
          this.summary = {
            client,
            summaryUrl: capability.summaryUrl,
            bundleId,
            baseUrl: publishSettings.baseUrl,
            organization: publishSettings.organization,
            startedAt,
            body: removeUndefined({
              ...commonBody,
              frameworkVersion: config.version,
              policyRevision: capability.policyRevision,
            }),
            outcomes: new Map(),
          };
          this.bundleSuppressedReason =
            "the server selected Summary-only mode, which does not collect detailed bundle data";
          this.output(
            `Summary-only mode: publishing aggregate counts without test details or evidence (${capability.summary.remaining} runs remaining).`,
          );
          return "summary_only" as const;
        }

        createPortableBundle();
        const artifactName = basename(paths.junitPath);
        this.runPromise = client
          .createRun(
            removeUndefined({
              ...commonBody,
              collectionMode: "full" as const,
              policyRevision: capability.policyRevision,
              artifacts: [
                { filename: artifactName, contentType: "application/xml", format: "junit-xml" },
              ],
            }),
            bundleId,
          )
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
        await this.runPromise;
        return "full" as const;
      })
      .catch((error: unknown) => {
        // Unknown policy must never cause the reporter to leak details to an older or failing
        // server. The Playwright command remains warning-only, as publishing always has been.
        this.publishFailed = true;
        this.warn(`Could not resolve the project publishing mode: ${safeErrorMessage(error)}`);
        // Capability failure must still enter the ordinary full-detail capture path. No data is
        // sent to an unknown server policy, but steps and evidence remain available in the ZIP.
        createPortableBundle();
        return "full" as const;
      });
  }

  onTestEnd(test: ReporterTestCase, result: ReporterTestResult): void {
    if (!this.modePromise && !this.bundle) return;
    const task = (async () => {
      const mode = this.modePromise ? await this.modePromise : "full";
      if (mode === "summary_only") {
        this.recordSummaryOutcome(test, result);
        return;
      }
      if (mode === "full" && (result.attachments.length > 0 || result.steps?.length)) {
        await this.captureAndPublishTestDetails(test, result);
      }
    })().catch((error: unknown) => {
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
    const mode = this.modePromise ? await this.modePromise : this.bundle ? "full" : null;
    if (mode === "summary_only") {
      await this.publishSummary();
      this.reportFinalPublicationStatus();
      return;
    }
    const run = this.runPromise ? await this.runPromise : null;
    const junitPath = this.junitPath;
    if (!junitPath) {
      this.reportFinalPublicationStatus();
      return;
    }

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
        this.publicationSucceeded = true;
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

    let bundleOutputPath: string | undefined;
    let bundleError: string | undefined;
    if (this.bundle) {
      const retain = this.bundle.mode === "always" || this.publishFailed;
      try {
        if (retain) {
          const outputPath = await this.bundle.finalize(junitPath);
          bundleOutputPath = outputPath;
          this.output(`Portable run bundle: ${outputPath}`);
          this.output("Upload this ZIP from the TraceDock project Upload page.");
        } else {
          await this.bundle.discard();
        }
      } catch (error) {
        bundleError = safeErrorMessage(error);
        this.warn(`Could not create the portable run bundle: ${bundleError}`);
      }
    }
    this.reportFinalPublicationStatus(bundleOutputPath, bundleError);
  }

  private recordSummaryOutcome(test: ReporterTestCase, result: ReporterTestResult): void {
    if (!this.summary) return;
    const key = test.id ?? `${test.location.file}\0${test.titlePath().join("\0")}`;
    const previous = this.summary.outcomes.get(key);
    let status: "passed" | "failed" | "skipped" | "errored";
    switch (result.status) {
      case "passed":
      case "failed":
      case "skipped":
        status = result.status;
        break;
      case "timedOut":
      case "interrupted":
        status = "errored";
        break;
      default:
        throw new Error(`unsupported Playwright result status: ${String(result.status)}`);
    }
    this.summary.outcomes.set(key, {
      status,
      flaky:
        status === "passed" &&
        (result.retry > 0 || (previous !== undefined && previous.status !== "passed")),
    });
  }

  private async publishSummary(): Promise<void> {
    const summary = this.summary;
    if (!summary) return;
    const finishedAt = new Date();
    const counts = {
      passed: 0,
      failed: 0,
      skipped: 0,
      errored: 0,
      blocked: 0,
      flaky: 0,
    };
    for (const outcome of summary.outcomes.values()) {
      counts[outcome.status] += 1;
      if (outcome.flaky) counts.flaky += 1;
    }
    const total = counts.passed + counts.failed + counts.skipped + counts.errored + counts.blocked;
    try {
      const response = await summary.client.createSummaryRun(
        summary.summaryUrl,
        {
          ...summary.body,
          finishedAt: finishedAt.toISOString(),
          durationMs: Math.max(0, finishedAt.getTime() - summary.startedAt.getTime()),
          total,
          ...counts,
        },
        summary.bundleId,
      );
      this.publicationSucceeded = true;
      const runUrl = browserRunUrlFor(summary.baseUrl, summary.organization, response.runId);
      this.output(
        runUrl
          ? `Published Summary-only run: ${runUrl}`
          : `Published Summary-only run ${response.runId}.`,
      );
      if (runUrl) await this.writeGithubSummary(runUrl);
    } catch (error) {
      this.publishFailed = true;
      this.warn(`Could not publish the aggregate run summary: ${safeErrorMessage(error)}`);
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
          `TraceDock returned ${declared.uploads.length} of ${attachments.length} evidence upload URLs`,
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
    const optionUrl = first(this.options.url);
    const environmentUrl = reporterEnv("URL");
    const baseUrl = first(optionUrl, environmentUrl);
    const token = first(reporterEnv("TOKEN"));
    const project = first(this.options.project, reporterEnv("PROJECT"));
    const missing = [
      !baseUrl ? "TRACEDOCK_URL" : undefined,
      !token ? "TRACEDOCK_TOKEN" : undefined,
      !project ? "TRACEDOCK_PROJECT (or reporter project option)" : undefined,
    ].filter((value): value is string => value !== undefined);
    if (missing.length > 0) return `missing ${missing.join(", ")}`;
    if (!baseUrl || !token || !project) {
      return "required publishing settings did not resolve";
    }

    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "TRACEDOCK_URL must use http or https";
      }
    } catch {
      return "TRACEDOCK_URL is not a valid URL";
    }

    return {
      baseUrl,
      baseUrlSource: optionUrl ? "playwright.config.ts url option" : "TRACEDOCK_URL",
      token,
      project,
      organization: first(this.options.organization, reporterEnv("ORG")),
    };
  }

  private resolvePaths(config: ReporterFullConfig): ResolvedPaths | string {
    const junitFile = first(this.options.junitFile);
    if (!junitFile) return "missing reporter junitFile option";
    const configDirectory = config.configFile ? dirname(resolve(config.configFile)) : process.cwd();
    const junitPath = resolve(configDirectory, junitFile);
    const requestedMode = first(this.options.bundle?.mode, reporterEnv("BUNDLE_MODE"));
    if (requestedMode && !["always", "on-failure", "off"].includes(requestedMode)) {
      this.warn(`Unknown bundle mode "${requestedMode}"; using "always".`);
    }
    const bundleOutput = first(this.options.bundle?.outputDir, reporterEnv("BUNDLE_OUTPUT_DIR"));
    return {
      junitPath,
      bundleMode: resolveBundleMode(requestedMode),
      bundleOutputDirectory: bundleOutput
        ? resolve(configDirectory, bundleOutput)
        : join(dirname(junitPath), "tracedock-bundles"),
    };
  }

  private warn(message: string): void {
    process.stderr.write(`[tracedock] Warning: ${safeErrorMessage(message)}\n`);
  }

  private reportPublishingPlan(settings: PublishSettings, paths: ResolvedPaths): void {
    const selectedUrl = publicBaseUrl(settings.baseUrl);
    this.output(`Publishing target: ${selectedUrl} (${settings.baseUrlSource}).`);
    this.output(bundlePlanMessage(paths.bundleMode, paths.bundleOutputDirectory));

    const optionUrl = first(this.options.url);
    const environmentUrl = reporterEnv("URL");
    if (
      optionUrl &&
      environmentUrl &&
      normalizedBaseUrl(optionUrl) !== normalizedBaseUrl(environmentUrl)
    ) {
      this.warningLines([
        "Conflicting TraceDock URLs were detected at startup.",
        `Selected playwright.config.ts url: ${publicBaseUrl(optionUrl)}.`,
        `Ignored TRACEDOCK_URL: ${publicBaseUrl(environmentUrl)}.`,
        "Reporter options take precedence over environment fallbacks.",
        `Capability negotiation will use ${selectedUrl}.`,
        bundlePlanMessage(paths.bundleMode, paths.bundleOutputDirectory),
      ]);
    }

    if (isLoopbackUrl(settings.baseUrl)) {
      const detail = environmentFlag(process.env.CI)
        ? "Inside CI, loopback points to the build agent rather than your TraceDock server."
        : "Ensure TraceDock is running locally and, for HTTPS, that its certificate is trusted.";
      this.warningLines([
        `The selected TraceDock URL uses a loopback host: ${selectedUrl}.`,
        detail,
      ]);
    }
  }

  private reportFinalPublicationStatus(bundleOutputPath?: string, bundleError?: string): void {
    if (!this.reportingAttempted || this.publicationSucceeded) return;
    const lines = ["TraceDock results were not published."];
    if (this.publishTarget) {
      lines.push(
        `Publishing target: ${publicBaseUrl(this.publishTarget.baseUrl)} (${this.publishTarget.source}).`,
      );
    }
    if (bundleOutputPath) {
      lines.push(`Portable run bundle retained at: ${singleLine(bundleOutputPath)}.`);
      lines.push("Upload this ZIP from the TraceDock project Upload page.");
    } else if (this.bundlePlan?.mode === "off") {
      lines.push("No portable run bundle was created because bundle mode is off.");
    } else if (this.bundleSuppressedReason) {
      lines.push(`No portable run bundle was created because ${this.bundleSuppressedReason}.`);
    } else if (bundleError) {
      lines.push(`Portable run bundle creation failed: ${bundleError}.`);
      if (this.bundlePlan) {
        lines.push(
          `Configured bundle output directory: ${singleLine(this.bundlePlan.outputDirectory)}.`,
        );
      }
    } else if (this.bundlePlan) {
      lines.push(
        `No portable run bundle was created; configured output directory: ${singleLine(this.bundlePlan.outputDirectory)}.`,
      );
    }
    this.warningLines(lines);
  }

  private warningLines(lines: readonly string[]): void {
    process.stderr.write(
      `${lines.map((line) => `[tracedock] Warning: ${singleLine(line)}`).join("\n")}\n`,
    );
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
      "TraceDock reporter is not configured; this run will not be published.",
      `Missing configuration: ${reason.replace(/^missing\s+/, "")}.`,
      "Configure the environment:",
      "  TRACEDOCK_URL=https://tracedock.example.com",
      "  TRACEDOCK_TOKEN=td_...",
      "  TRACEDOCK_PROJECT=checkout-web",
      "Configure run and CI context (recommended):",
      "  TRACEDOCK_RUN_NAME=checkout-e2e",
      "  TRACEDOCK_CI_PROVIDER=github",
      "  TRACEDOCK_CI_BUILD_NUMBER=84",
      "  TRACEDOCK_CI_PIPELINE_NAME='Nightly regression'",
      "  TRACEDOCK_CI_JOB_NAME=playwright-chromium",
      "  TRACEDOCK_CI_JOB_URL=https://ci.example/jobs/12001",
      "Configure playwright.config.ts with evidence defaults plus the JUnit and TraceDock reporters:",
      "  import { withTraceDockDefaults } from '@tracedock/playwright';",
      "  const junitFile = 'test-results/junit.xml';",
      "  export default defineConfig(withTraceDockDefaults({",
      "    reporter: [",
      "      ['junit', { outputFile: junitFile, includeRetries: true }],",
      "      ['@tracedock/playwright', { junitFile }],",
      "    ],",
      "  }));",
      ...(this.bundlePlan
        ? [bundlePlanMessage(this.bundlePlan.mode, this.bundlePlan.outputDirectory)]
        : []),
      `Setup guide: ${CONFIGURATION_GUIDE}`,
    ];
    process.stderr.write(`${lines.map((line) => `[tracedock] ${line}`).join("\n")}\n`);
  }

  /** Missing labels should be discoverable without making observability break the test command. */
  private runContextWarning(missing: readonly string[], runName: string): void {
    const lines = [
      "TraceDock run context is incomplete; publishing will continue.",
      `Missing configuration: ${missing.join(", ")}.`,
      `Run name for this publication: ${runName}.`,
      "Set reporter options (name, ci) or the corresponding TRACEDOCK_RUN_NAME and TRACEDOCK_CI_* environment variables.",
      `Setup guide: ${CONFIGURATION_GUIDE}`,
    ];
    process.stderr.write(`${lines.map((line) => `[tracedock] ${line}`).join("\n")}\n`);
  }

  private output(message: string): void {
    process.stdout.write(`[tracedock] ${message}\n`);
  }

  private async writeGithubSummary(runUrl: string): Promise<void> {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary) return;
    try {
      await appendFile(summary, `\n[TraceDock run](${runUrl})\n`, "utf8");
    } catch (error) {
      this.warn(`Could not update the GitHub job summary: ${safeErrorMessage(error)}`);
    }
  }
}

function browserRunUrl(run: ActiveRun): string | undefined {
  return browserRunUrlFor(run.baseUrl, run.organization, run.response.runId);
}

function browserRunUrlFor(
  baseUrl: string,
  organization: string | undefined,
  runId: string,
): string | undefined {
  if (!organization) return undefined;
  const path = `/o/${encodeURIComponent(organization)}/runs/${encodeURIComponent(runId)}`;
  return new URL(path, `${baseUrl}/`).toString();
}

function defaultRunName(buildNumber: string | undefined): string {
  return buildNumber ? `Playwright build ${buildNumber}` : "Playwright run";
}

function missingRunContext(
  configuredRunName: string | undefined,
  ci: TraceDockCiOptions | undefined,
): string[] {
  return [
    !configuredRunName ? "TRACEDOCK_RUN_NAME (or reporter name option)" : undefined,
    !ci?.provider ? "TRACEDOCK_CI_PROVIDER" : undefined,
    !ci?.buildId && !ci?.buildNumber
      ? "TRACEDOCK_CI_BUILD_ID or TRACEDOCK_CI_BUILD_NUMBER"
      : undefined,
    !ci?.pipelineName ? "TRACEDOCK_CI_PIPELINE_NAME (or TRACEDOCK_CI_BUILD_NAME)" : undefined,
    !ci?.jobName ? "TRACEDOCK_CI_JOB_NAME" : undefined,
    !ci?.jobUrl && !ci?.pipelineUrl
      ? "TRACEDOCK_CI_JOB_URL or TRACEDOCK_CI_PIPELINE_URL"
      : undefined,
  ].filter((value): value is string => value !== undefined);
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value as number)))
    : fallback;
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "")?.trim();
}

function publicBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "(invalid URL)";
  }
}

function normalizedBaseUrl(value: string): string {
  return publicBaseUrl(value).toLowerCase().replace(/\/$/, "");
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("127.")
    );
  } catch {
    return false;
  }
}

function environmentFlag(value: string | undefined): boolean {
  return value ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) : false;
}

function bundlePlanMessage(mode: BundleMode, outputDirectory: string): string {
  return mode === "off"
    ? "Portable bundle fallback: disabled (bundle mode is off)."
    : `Portable bundle fallback: ${mode}; output directory: ${singleLine(outputDirectory)}.`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function reporterEnv(name: string): string | undefined {
  return first(process.env[`TRACEDOCK_${name}`]);
}

function removeUndefined<Value extends object>(input: Value): Value {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Value;
}
