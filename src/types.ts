import type { Buffer } from "node:buffer";

export type TraceOptixCiProvider =
  | "github"
  | "gitlab"
  | "jenkins"
  | "circleci"
  | "buildkite"
  | "azure"
  | "bitbucket"
  | "teamcity"
  | "local"
  | "unknown";

export interface TraceOptixCiOptions {
  provider?: TraceOptixCiProvider;
  buildId?: string;
  buildNumber?: string;
  jobName?: string;
  jobUrl?: string;
  pipelineName?: string;
  pipelineUrl?: string;
  actor?: string;
  triggerEvent?: string;
}

/** Options are safe to commit. The API token is intentionally environment-only. */
export interface TraceOptixReporterOptions {
  /** TraceOptix project key. Falls back to TRACEOPTIX_PROJECT. */
  project?: string;
  /** JUnit file written by Playwright's built-in junit reporter. */
  junitFile: string;
  /** TraceOptix origin. Overrides TRACEOPTIX_URL; differing values produce a startup warning. */
  url?: string;
  /** Optional organization slug used only to print the final browser URL. */
  organization?: string;
  /** Base run name. Falls back to TRACEOPTIX_RUN_NAME, then the detected CI build. */
  name?: string;
  /** Supports {name} and {timestamp}. Defaults to "{name}-{timestamp}". */
  namePattern?: string;
  environment?: string;
  branch?: string;
  commitSha?: string;
  pullRequest?: number;
  /** Explicit CI fields override TRACEOPTIX_CI_* and provider-detected values. */
  ci?: TraceOptixCiOptions;
  /** Run tags. Values override matching TRACEOPTIX_RUN_TAGS entries. */
  tags?: Record<string, string>;
  /** Detect @p0–@p3 Playwright tags and synchronize testcase priority. Defaults to true. */
  priority?: { fromTags?: boolean };
  /** Maximum simultaneous object-store PUTs. Defaults to 3. */
  uploadConcurrency?: number;
  /** Project capability lookup timeout in milliseconds. Defaults to 5,000. */
  capabilityTimeoutMs?: number;
  /** Portable ZIP output. Defaults to always, beside junitFile in traceoptix-bundles/. */
  bundle?: {
    mode?: "always" | "on-failure" | "off";
    outputDir?: string;
  };
}

export interface ReporterAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: Buffer;
}

export interface ReporterTestError {
  message?: string;
  stack?: string;
}

export interface ReporterTestStep {
  title: string;
  category: string;
  duration: number;
  startTime: Date;
  error?: ReporterTestError;
  location?: { file: string; line?: number; column?: number };
  annotations: Array<{ type: string; description?: string }>;
  attachments: ReporterAttachment[];
  steps: ReporterTestStep[];
}

/**
 * The small structural slice of Playwright's public reporter types used at runtime.
 * Keeping it local leaves the published JavaScript dependency-free while the package's peer
 * dependency still tells npm which runner versions are supported.
 */
export interface ReporterTestCase {
  id?: string;
  title: string;
  tags: string[];
  titlePath(): string[];
  location: { file: string };
}

export interface ReporterTestResult {
  attachments: ReporterAttachment[];
  retry: number;
  status?: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration?: number;
  steps?: ReporterTestStep[];
}

export interface ReporterFullConfig {
  rootDir: string;
  configFile?: string;
  version: string;
  shard: { current: number; total: number } | null;
  argv?: string[];
}

export interface ReporterSuite {
  allTests(): ReporterTestCase[];
}
