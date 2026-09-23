import type { Buffer } from "node:buffer";

/** Options are safe to commit. The API token is intentionally environment-only. */
export interface TestCenterReporterOptions {
  /** Test Center project key. Falls back to TESTCENTER_PROJECT. */
  project?: string;
  /** JUnit file written by Playwright's built-in junit reporter. */
  junitFile: string;
  /** Test Center origin. Falls back to TESTCENTER_URL. */
  url?: string;
  /** Optional organization slug used only to print the final browser URL. */
  organization?: string;
  name?: string;
  environment?: string;
  branch?: string;
  commitSha?: string;
  pullRequest?: number;
  tags?: Record<string, string>;
  /** Maximum simultaneous object-store PUTs. Defaults to 3. */
  uploadConcurrency?: number;
}

export interface ReporterAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: Buffer;
}

/**
 * The small structural slice of Playwright's public reporter types used at runtime.
 * Keeping it local leaves the published JavaScript dependency-free while the package's peer
 * dependency still tells npm which runner versions are supported.
 */
export interface ReporterTestCase {
  title: string;
  titlePath(): string[];
  location: { file: string };
}

export interface ReporterTestResult {
  attachments: ReporterAttachment[];
  retry: number;
}

export interface ReporterFullConfig {
  rootDir: string;
  version: string;
  shard: { current: number; total: number } | null;
  argv?: string[];
}

export interface ReporterSuite {
  allTests(): Array<unknown>;
}
