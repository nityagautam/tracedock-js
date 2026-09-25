import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { PreparedAttachment } from "./attachments.js";
import type { TestPriorityDeclaration } from "./priorities.js";
import type { StepBatch } from "./steps.js";
import type { TestCenterCiOptions } from "./types.js";
import { REPORTER_VERSION } from "./version.js";
import { writeStoredZip } from "./zip.js";

export type BundleMode = "always" | "on-failure" | "off";

// The reporter is published without Test Center's private core package, so these mirror the
// server contract deliberately. Boundary tests on both packages keep the values aligned.
export const MAX_PORTABLE_BUNDLE_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_PORTABLE_BUNDLE_EVIDENCE_FILES = 10_000;

export interface BundleRunMetadata {
  name: string;
  framework: "playwright";
  environment?: string;
  branch?: string;
  commitSha?: string;
  pullRequest?: number;
  startedAt: string;
  ci?: TestCenterCiOptions;
  shard?: { groupId: string; index: number; total: number };
  tags: Record<string, string>;
}

interface ManifestFile {
  path: string;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
}

interface ManifestEvidence extends ManifestFile {
  id: string;
  kind: PreparedAttachment["declaration"]["kind"];
  stepId?: string;
}

interface ManifestAttempt {
  suite?: string;
  test: string;
  attempt: number;
  steps: NonNullable<StepBatch>["steps"];
  evidence: ManifestEvidence[];
}

export class PortableRunBundle {
  readonly bundleId: string;
  readonly mode: BundleMode;
  private readonly stageRoot: string;
  private readonly outputDirectory: string;
  private readonly attempts: ManifestAttempt[] = [];
  private evidenceFileCount = 0;
  private initialized = false;

  constructor(
    private readonly input: {
      bundleId: string;
      mode: BundleMode;
      outputDirectory: string;
      projectHint?: string;
      playwrightVersion: string;
      testCaseCount: number;
      run: BundleRunMetadata;
      testPriorities: TestPriorityDeclaration[];
    },
  ) {
    this.bundleId = input.bundleId;
    this.mode = input.mode;
    this.outputDirectory = resolve(input.outputDirectory);
    this.stageRoot = join(this.outputDirectory, `.testcenter-staging-${input.bundleId}`);
  }

  async addAttempt(input: {
    suite?: string;
    test: string;
    attempt: number;
    steps: StepBatch | null;
    attachments: readonly PreparedAttachment[];
  }): Promise<void> {
    if (this.mode === "off") return;
    if (this.evidenceFileCount + input.attachments.length > MAX_PORTABLE_BUNDLE_EVIDENCE_FILES) {
      throw new Error(
        `portable bundle evidence exceeds ${MAX_PORTABLE_BUNDLE_EVIDENCE_FILES} files`,
      );
    }
    await this.initialize();
    const evidence: ManifestEvidence[] = [];
    for (const attachment of input.attachments) {
      const id = randomUUID();
      const path = `evidence/${id}/${safeFileName(attachment.declaration.name)}`;
      const target = join(this.stageRoot, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, attachment.body);
      const inspected = await hashFile(target);
      evidence.push({
        id,
        path,
        name: attachment.declaration.name,
        kind: attachment.declaration.kind,
        contentType: attachment.declaration.contentType,
        bytes: inspected.bytes,
        sha256: inspected.sha256,
        ...(attachment.declaration.stepId ? { stepId: attachment.declaration.stepId } : {}),
      });
    }
    this.evidenceFileCount += evidence.length;
    if ((input.steps?.steps.length ?? 0) === 0 && evidence.length === 0) return;
    this.attempts.push({
      ...(input.suite ? { suite: input.suite } : {}),
      test: input.test,
      attempt: input.attempt,
      steps: input.steps?.steps ?? [],
      evidence,
    });
  }

  async finalize(junitPath: string): Promise<string> {
    if (this.mode === "off") throw new Error("portable bundle output is disabled");
    await this.initialize();
    const reportPath = "reports/junit.xml";
    const stagedReport = join(this.stageRoot, "reports", "junit.xml");
    await mkdir(dirname(stagedReport), { recursive: true });
    await copyFile(junitPath, stagedReport);
    const report = await hashFile(stagedReport);
    if (report.bytes === 0) throw new Error(`JUnit report is missing or empty: ${junitPath}`);
    const manifest = {
      schemaVersion: 2,
      testCaseCount: this.input.testCaseCount,
      bundleId: this.input.bundleId,
      createdAt: new Date().toISOString(),
      producer: {
        name: "@testcenter/playwright",
        version: REPORTER_VERSION,
        playwrightVersion: this.input.playwrightVersion,
      },
      ...(this.input.projectHint ? { projectHint: this.input.projectHint } : {}),
      run: this.input.run,
      report: {
        path: reportPath,
        name: basename(junitPath),
        contentType: "application/xml",
        bytes: report.bytes,
        sha256: report.sha256,
      },
      testPriorities: this.input.testPriorities,
      attempts: this.attempts,
    };
    const manifestPath = join(this.stageRoot, "manifest.json");
    const manifestJson = JSON.stringify(manifest);
    const manifestBytes = Buffer.byteLength(manifestJson, "utf8");
    if (manifestBytes > MAX_PORTABLE_BUNDLE_MANIFEST_BYTES) {
      throw new Error(
        `portable bundle metadata is ${manifestBytes} bytes; limit is ` +
          `${MAX_PORTABLE_BUNDLE_MANIFEST_BYTES}`,
      );
    }
    await writeFile(manifestPath, manifestJson, "utf8");
    const destination = await availableOutputPath(
      this.outputDirectory,
      `${safeFileName(this.input.run.name)}.testcenter-run.zip`,
    );
    await writeStoredZip(destination, [
      { name: "manifest.json", path: manifestPath },
      { name: reportPath, path: stagedReport },
      ...this.attempts.flatMap((attempt) =>
        attempt.evidence.map((evidence) => ({
          name: evidence.path,
          path: join(this.stageRoot, ...evidence.path.split("/")),
        })),
      ),
    ]);
    await this.discard();
    return destination;
  }

  async discard(): Promise<void> {
    await rm(this.stageRoot, { recursive: true, force: true });
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.stageRoot, { recursive: true });
    this.initialized = true;
  }
}

export function resolveBundleMode(value: string | undefined): BundleMode {
  if (!value) return "always";
  if (value === "always" || value === "on-failure" || value === "off") return value;
  return "always";
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${path} is not a file`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const raw of createReadStream(path)) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function availableOutputPath(directory: string, filename: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const extension = ".testcenter-run.zip";
  const stem = filename.endsWith(extension) ? filename.slice(0, -extension.length) : filename;
  for (let occurrence = 1; occurrence < 10_000; occurrence += 1) {
    const candidate = join(
      directory,
      occurrence === 1 ? `${stem}${extension}` : `${stem}-${occurrence}${extension}`,
    );
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("could not choose an unused portable bundle filename");
}

function safeFileName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 160) || "playwright-run";
}
