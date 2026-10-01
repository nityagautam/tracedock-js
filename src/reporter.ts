import { randomUUID } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { prepareAttachments, safeErrorMessage } from "./attachments.js";
import { PortableRunBundle, resolveBundleMode, type BundleMode } from "./bundle.js";
import {
  HttpError,
  Semaphore,
  TraceOptixClient,
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
  TraceOptixCiOptions,
  TraceOptixReporterOptions,
} from "./types.js";

interface ActiveRun {
  client: TraceOptixClient;
  response: CreateRunResponse;
  reportUpload: ArtifactUpload;
  organization?: string;
  baseUrl: string;
}

interface FullPublication {
  client: TraceOptixClient;
  body: Record<string, unknown>;
  bundleId: string;
  testPriorities: ReturnType<typeof prepareTestPriorities>;
  organization?: string;
  baseUrl: string;
}

interface PublishSettings {
  baseUrl: string;
  baseUrlSource: "playwright.config.ts url option" | "TRACEOPTIX_URL";
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
  client: TraceOptixClient;
  summaryUrl: string;
  bundleId: string;
  baseUrl: string;
  organization?: string;
  startedAt: Date;
  body: Record<string, unknown>;
  outcomes: Map<string, { status: "passed" | "failed" | "skipped" | "errored"; flaky: boolean }>;
}

const CONFIGURATION_GUIDE =
  "https://github.com/nityagautam/traceoptix-playwright#configure";

export default class TraceOptixReporter {
  private readonly options: TraceOptixReporterOptions;
  private readonly uploads: Semaphore;
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
  private fullPublication: FullPublication | undefined;
  private presence: { client: TraceOptixClient; project: string; id: string } | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatPending: Promise<void> | undefined;
  private presencePhase: "running" | "uploading" = "running";
  private readonly finishedTests = new Set<string>();
  private heartbeatWarned = false;

  constructor(options: TraceOptixReporterOptions = { junitFile: "" }) {
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
        source: first(this.options.url) ? "playwright.config.ts url option" : "TRACEOPTIX_URL",
      };
    }
    const publishSettings = this.resolvePublishSettings();
    const projectHint =
      typeof publishSettings === "string"
        ? first(this.options.project, reporterEnv("PROJECT"))
        : publishSettings.project;
    const createPortableBundle = (requiredForLivePublishing = false) => {
      if ((!requiredForLivePublishing && paths.bundleMode === "off") || this.bundle) return;
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

    const client = new TraceOptixClient(publishSettings.baseUrl, publishSettings.token);
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
        if (capability.executionPresenceVersion === 1) {
          try {
            const { runId } = await client.registerExecution({
              operation: "start", project: publishSettings.project, sourceBundleId: bundleId,
              name: runName, branch, startedAt: startedAt.toISOString(), planned: allTests.length,
              collectionMode: capability.collectionMode, policyRevision: capability.policyRevision,
            });
            if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("invalid execution identity");
            this.presence = { client, project: publishSettings.project, id: runId };
            this.heartbeatTimer = setInterval(() => { void this.sendHeartbeat(); }, 15_000);
            this.heartbeatTimer.unref();
            this.output(`Run started: ${runId}`);
          } catch (error) {
            this.warn(`Could not register live execution: ${safeErrorMessage(error)}`);
          }
        }
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

        // Full-detail servers require the exact JUnit byte size before issuing a presigned upload
        // URL. Playwright writes that file only after reporter onEnd hooks, so create the run in
        // onExit and keep steps/evidence in the same bounded disk stage used by portable bundles.
        createPortableBundle(true);
        this.fullPublication = {
          client,
          body: removeUndefined({
            ...commonBody,
            collectionMode: "full" as const,
            policyRevision: capability.policyRevision,
          }),
          bundleId,
          testPriorities,
          organization: publishSettings.organization,
          baseUrl: publishSettings.baseUrl,
        };
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
    this.finishedTests.add(test.id ?? `${test.location.file}\0${test.titlePath().join("\0")}`);
    if (!this.modePromise && !this.bundle) return;
    const task = (async () => {
      const mode = this.modePromise ? await this.modePromise : "full";
      if (mode === "summary_only") {
        this.recordSummaryOutcome(test, result);
        return;
      }
      if (mode === "full" && (result.attachments.length > 0 || result.steps?.length)) {
        await this.captureTestDetails(test, result);
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
  private sendHeartbeat(): Promise<void> {
    if (this.heartbeatPending) return this.heartbeatPending;
    if (!this.presence) return Promise.resolve();
    const { client, project, id } = this.presence;
    this.heartbeatPending = client.heartbeatExecution({ operation: "heartbeat", project, id,
      completed: this.finishedTests.size, phase: this.presencePhase,
    }).then(() => {}).catch(error => {
      if (!this.heartbeatWarned) {
        this.heartbeatWarned = true;
        this.warn(`Live execution heartbeat unavailable: ${safeErrorMessage(error)}`);
      }
    }).finally(() => { this.heartbeatPending = undefined; });
    return this.heartbeatPending;
  }

  async onExit(): Promise<void> {
    try {
      await this.modePromise;
      this.presencePhase = "uploading";
      await this.heartbeatPending;
      await this.sendHeartbeat();
      await this.finalizePublication();
    } finally {
      clearInterval(this.heartbeatTimer);
      await this.heartbeatPending;
    }
  }

  private async finalizePublication(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    const mode = this.modePromise ? await this.modePromise : this.bundle ? "full" : null;
    if (mode === "summary_only") {
      await this.publishSummary();
      this.reportFinalPublicationStatus();
      return;
    }
    const junitPath = this.junitPath;
    if (!junitPath) {
      this.reportFinalPublicationStatus();
      return;
    }

    const prepared = this.fullPublication
      ? await this.createFullRun(junitPath, this.fullPublication)
      : null;
    if (prepared) {
      const { run, report } = prepared;
      try {
        await this.publishStagedTestDetails(run);

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
    } else if (this.fullPublication) {
      this.publishFailed = true;
    }

    let bundleOutputPath: string | undefined;
    let bundleError: string | undefined;
    if (this.bundle) {
      const retain =
        this.bundle.mode === "always" ||
        (this.bundle.mode === "on-failure" && this.publishFailed);
      try {
        if (retain) {
          const outputPath = await this.bundle.finalize(junitPath);
          bundleOutputPath = outputPath;
          this.output(`Portable run bundle: ${outputPath}`);
          this.output("Upload this ZIP from the TraceOptix project Upload page.");
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

  private async captureTestDetails(test: ReporterTestCase, result: ReporterTestResult): Promise<void> {
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
        this.warn(`Could not stage test details for "${test.title}": ${safeErrorMessage(error)}`);
      }
    }
  }

  private async createFullRun(
    junitPath: string,
    publication: FullPublication,
  ): Promise<{ run: ActiveRun; report: Buffer } | null> {
    let report: Buffer;
    try {
      const metadata = await stat(junitPath);
      if (!metadata.isFile() || metadata.size === 0) {
        throw new Error(`JUnit report is missing or empty: ${junitPath}`);
      }
      report = await readFile(junitPath);
    } catch (error) {
      this.publishFailed = true;
      this.warn(`Could not read the final JUnit report: ${safeErrorMessage(error)}`);
      return null;
    }

    try {
      const response = await publication.client.createRun(
        {
          ...publication.body,
          artifacts: [
            {
              filename: basename(junitPath),
              contentType: "application/xml",
              bytes: report.byteLength,
              format: "junit-xml",
            },
          ],
        },
        publication.bundleId,
      );
      const reportUpload = response.uploads[0];
      if (!reportUpload) throw new Error("run creation returned no JUnit upload URL");
      if (publication.testPriorities.length > 0) {
        try {
          await publication.client.declareTestPriorities(response, publication.testPriorities);
        } catch (error) {
          this.publishFailed = true;
          this.warn(`Could not publish testcase priorities: ${safeErrorMessage(error)}`);
        }
      }
      return {
        run: {
          client: publication.client,
          response,
          reportUpload,
          organization: publication.organization,
          baseUrl: publication.baseUrl,
        },
        report,
      };
    } catch (error) {
      this.publishFailed = true;
      this.warn(`Could not create the run: ${safeErrorMessage(error)}`);
      return null;
    }
  }

  private async publishStagedTestDetails(run: ActiveRun): Promise<void> {
    if (!this.bundle) return;
    for await (const attempt of this.bundle.stagedAttempts()) {
      if (attempt.steps) {
        try {
          await run.client.declareSteps(run.response, attempt.steps);
        } catch (error) {
          this.publishFailed = true;
          this.warn(`Could not record steps for "${attempt.test}": ${safeErrorMessage(error)}`);
        }
      }
      if (attempt.attachments.length === 0) continue;

      try {
        const declared = await run.client.declareAttachments(
          run.response,
          attempt.attachments.map((attachment) => attachment.declaration),
        );
        if (declared.uploads.length !== attempt.attachments.length) {
          throw new Error(
            `TraceOptix returned ${declared.uploads.length} of ${attempt.attachments.length} evidence upload URLs`,
          );
        }
        await Promise.all(
          declared.uploads.map((upload, index) => {
            const attachment = attempt.attachments[index];
            if (!attachment) throw new Error("evidence upload order did not match its declaration");
            return this.uploads.use(() => run.client.put(upload, attachment.body));
          }),
        );
      } catch (error) {
        this.publishFailed = true;
        this.warn(`Could not publish evidence for "${attempt.test}": ${safeErrorMessage(error)}`);
      }
    }
  }

  private resolvePublishSettings(): PublishSettings | string {
    const optionUrl = first(this.options.url);
    const environmentUrl = reporterEnv("URL");
    const baseUrl = first(optionUrl, environmentUrl);
    const token = first(reporterEnv("TOKEN"));
    const project = first(this.options.project, reporterEnv("PROJECT"));
    const missing = [
      !baseUrl ? "TRACEOPTIX_URL" : undefined,
      !token ? "TRACEOPTIX_TOKEN" : undefined,
      !project ? "TRACEOPTIX_PROJECT (or reporter project option)" : undefined,
    ].filter((value): value is string => value !== undefined);
    if (missing.length > 0) return `missing ${missing.join(", ")}`;
    if (!baseUrl || !token || !project) {
      return "required publishing settings did not resolve";
    }

    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "TRACEOPTIX_URL must use http or https";
      }
    } catch {
      return "TRACEOPTIX_URL is not a valid URL";
    }

    return {
      baseUrl,
      baseUrlSource: optionUrl ? "playwright.config.ts url option" : "TRACEOPTIX_URL",
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
        : join(dirname(junitPath), "traceoptix-bundles"),
    };
  }

  private warn(message: string): void {
    process.stderr.write(`[traceoptix] Warning: ${safeErrorMessage(message)}\n`);
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
        "Conflicting TraceOptix URLs were detected at startup.",
        `Selected playwright.config.ts url: ${publicBaseUrl(optionUrl)}.`,
        `Ignored TRACEOPTIX_URL: ${publicBaseUrl(environmentUrl)}.`,
        "Reporter options take precedence over environment fallbacks.",
        `Capability negotiation will use ${selectedUrl}.`,
        bundlePlanMessage(paths.bundleMode, paths.bundleOutputDirectory),
      ]);
    }

    if (isLoopbackUrl(settings.baseUrl)) {
      const detail = environmentFlag(process.env.CI)
        ? "Inside CI, loopback points to the build agent rather than your TraceOptix server."
        : "Ensure TraceOptix is running locally and, for HTTPS, that its certificate is trusted.";
      this.warningLines([
        `The selected TraceOptix URL uses a loopback host: ${selectedUrl}.`,
        detail,
      ]);
    }
  }

  private reportFinalPublicationStatus(bundleOutputPath?: string, bundleError?: string): void {
    if (!this.reportingAttempted || this.publicationSucceeded) return;
    const lines = ["TraceOptix results were not published."];
    if (this.publishTarget) {
      lines.push(
        `Publishing target: ${publicBaseUrl(this.publishTarget.baseUrl)} (${this.publishTarget.source}).`,
      );
    }
    if (bundleOutputPath) {
      lines.push(`Portable run bundle retained at: ${singleLine(bundleOutputPath)}.`);
      lines.push("Upload this ZIP from the TraceOptix project Upload page.");
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
      `${lines.map((line) => `[traceoptix] Warning: ${singleLine(line)}`).join("\n")}\n`,
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
      "TraceOptix reporter is not configured; this run will not be published.",
      `Missing configuration: ${reason.replace(/^missing\s+/, "")}.`,
      "Configure the environment:",
      "  TRACEOPTIX_URL=https://traceoptix.example.com",
      "  TRACEOPTIX_TOKEN=td_...",
      "  TRACEOPTIX_PROJECT=checkout-web",
      "Configure run and CI context (recommended):",
      "  TRACEOPTIX_RUN_NAME=checkout-e2e",
      "  TRACEOPTIX_CI_PROVIDER=github",
      "  TRACEOPTIX_CI_BUILD_NUMBER=84",
      "  TRACEOPTIX_CI_PIPELINE_NAME='Nightly regression'",
      "  TRACEOPTIX_CI_JOB_NAME=playwright-chromium",
      "  TRACEOPTIX_CI_JOB_URL=https://ci.example/jobs/12001",
      "Configure playwright.config.ts with evidence defaults plus the JUnit and TraceOptix reporters:",
      "  import { withTraceOptixDefaults } from '@traceoptix/playwright';",
      "  const junitFile = 'test-results/junit.xml';",
      "  export default defineConfig(withTraceOptixDefaults({",
      "    reporter: [",
      "      ['junit', { outputFile: junitFile, includeRetries: true }],",
      "      ['@traceoptix/playwright', { junitFile }],",
      "    ],",
      "  }));",
      ...(this.bundlePlan
        ? [bundlePlanMessage(this.bundlePlan.mode, this.bundlePlan.outputDirectory)]
        : []),
      `Setup guide: ${CONFIGURATION_GUIDE}`,
    ];
    process.stderr.write(`${lines.map((line) => `[traceoptix] ${line}`).join("\n")}\n`);
  }

  /** Missing labels should be discoverable without making observability break the test command. */
  private runContextWarning(missing: readonly string[], runName: string): void {
    const lines = [
      "TraceOptix run context is incomplete; publishing will continue.",
      `Missing configuration: ${missing.join(", ")}.`,
      `Run name for this publication: ${runName}.`,
      "Set reporter options (name, ci) or the corresponding TRACEOPTIX_RUN_NAME and TRACEOPTIX_CI_* environment variables.",
      `Setup guide: ${CONFIGURATION_GUIDE}`,
    ];
    process.stderr.write(`${lines.map((line) => `[traceoptix] ${line}`).join("\n")}\n`);
  }

  private output(message: string): void {
    process.stdout.write(`[traceoptix] ${message}\n`);
  }

  private async writeGithubSummary(runUrl: string): Promise<void> {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary) return;
    try {
      await appendFile(summary, `\n[TraceOptix run](${runUrl})\n`, "utf8");
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
  ci: TraceOptixCiOptions | undefined,
): string[] {
  return [
    !configuredRunName ? "TRACEOPTIX_RUN_NAME (or reporter name option)" : undefined,
    !ci?.provider ? "TRACEOPTIX_CI_PROVIDER" : undefined,
    !ci?.buildId && !ci?.buildNumber
      ? "TRACEOPTIX_CI_BUILD_ID or TRACEOPTIX_CI_BUILD_NUMBER"
      : undefined,
    !ci?.pipelineName ? "TRACEOPTIX_CI_PIPELINE_NAME (or TRACEOPTIX_CI_BUILD_NAME)" : undefined,
    !ci?.jobName ? "TRACEOPTIX_CI_JOB_NAME" : undefined,
    !ci?.jobUrl && !ci?.pipelineUrl
      ? "TRACEOPTIX_CI_JOB_URL or TRACEOPTIX_CI_PIPELINE_URL"
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
  return first(process.env[`TRACEOPTIX_${name}`]);
}

function removeUndefined<Value extends object>(input: Value): Value {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Value;
}
