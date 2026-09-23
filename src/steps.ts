import { randomUUID } from "node:crypto";
import { basename, relative } from "node:path";
import { junitSuiteName } from "./attachments.js";
import type {
  ReporterAttachment,
  ReporterTestCase,
  ReporterTestResult,
  ReporterTestStep,
} from "./types.js";

export const MAX_STEPS_PER_ATTEMPT = 5_000;

export interface StepDeclaration {
  id: string;
  parentId?: string;
  ordinal: number;
  title: string;
  category: string;
  status: "passed" | "failed" | "skipped";
  durationMs?: number;
  startedAt?: string;
  error?: { message?: string; stack?: string };
  location?: { file: string; line?: number; column?: number };
  annotations?: Array<{ type: string; description?: string }>;
}

export interface StepBatch {
  suite?: string;
  test: string;
  attempt: number;
  steps: StepDeclaration[];
}

export interface PreparedSteps {
  batch: StepBatch | null;
  stepIdForAttachment(attachment: ReporterAttachment): string | undefined;
}

/** Flatten Playwright's complete nested step tree while retaining parent identities. */
export function prepareSteps(
  test: ReporterTestCase,
  result: ReporterTestResult,
  rootDir: string,
  warn: (message: string) => void,
): PreparedSteps {
  const declarations: StepDeclaration[] = [];
  const attachmentReferences = new Map<ReporterAttachment, string>();
  const attachmentIdentities = new Map<string, string>();
  let truncated = false;

  const visit = (step: ReporterTestStep, parentId?: string): void => {
    if (declarations.length >= MAX_STEPS_PER_ATTEMPT) {
      truncated = true;
      return;
    }
    const title = step.title.trim();
    if (!title) {
      for (const child of step.steps) visit(child, parentId);
      return;
    }

    const id = randomUUID();
    const declaration: StepDeclaration = {
      id,
      ...(parentId ? { parentId } : {}),
      ordinal: declarations.length,
      title: title.slice(0, 1_024),
      category: (step.category.trim() || "unknown").slice(0, 128),
      status: step.error
        ? "failed"
        : step.annotations.some((annotation) => annotation.type === "skip")
          ? "skipped"
          : "passed",
      ...(Number.isFinite(step.duration) && step.duration >= 0
        ? { durationMs: Math.floor(step.duration) }
        : {}),
      ...(validDate(step.startTime) ? { startedAt: step.startTime.toISOString() } : {}),
      ...(step.error
        ? {
            error: {
              ...(step.error.message ? { message: step.error.message.slice(0, 100_000) } : {}),
              ...(step.error.stack ? { stack: step.error.stack.slice(0, 200_000) } : {}),
            },
          }
        : {}),
      ...(step.location
        ? {
            location: {
              file: displayPath(step.location.file, rootDir).slice(0, 2_048),
              ...(step.location.line && step.location.line > 0 ? { line: step.location.line } : {}),
              ...(step.location.column && step.location.column > 0
                ? { column: step.location.column }
                : {}),
            },
          }
        : {}),
      ...(step.annotations.length > 0
        ? {
            annotations: step.annotations.slice(0, 100).map((annotation) => ({
              type: annotation.type.slice(0, 128),
              ...(annotation.description
                ? { description: annotation.description.slice(0, 2_000) }
                : {}),
            })),
          }
        : {}),
    };
    declarations.push(declaration);

    for (const attachment of step.attachments) {
      // Later nested steps replace enclosing steps, so evidence lands on its narrowest owner.
      attachmentReferences.set(attachment, id);
      attachmentIdentities.set(attachmentIdentity(attachment), id);
    }
    for (const child of step.steps) visit(child, id);
  };

  for (const step of result.steps ?? []) visit(step);
  if (truncated) {
    warn(
      `Recorded the first ${MAX_STEPS_PER_ATTEMPT} steps for "${test.title}"; the remainder exceeded the safety limit.`,
    );
  }

  const suite = junitSuiteName(test, rootDir);
  return {
    batch:
      declarations.length === 0
        ? null
        : {
            ...(suite ? { suite } : {}),
            test: test.title.slice(0, 1_000),
            attempt: result.retry,
            steps: declarations,
          },
    stepIdForAttachment: (attachment) =>
      attachmentReferences.get(attachment) ??
      attachmentIdentities.get(attachmentIdentity(attachment)),
  };
}

function attachmentIdentity(attachment: ReporterAttachment): string {
  return `${attachment.name}\0${attachment.contentType}\0${attachment.path ?? ""}`;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function displayPath(file: string, rootDir: string): string {
  const candidate = relative(rootDir, file);
  return candidate && !candidate.startsWith("..") ? candidate : basename(file);
}
