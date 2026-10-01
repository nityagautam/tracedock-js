import type { PlannedStep } from "./step-plan.js";
import { randomUUID } from "node:crypto";
import { basename, relative, resolve } from "node:path";
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
  plan: readonly PlannedStep[] = [],
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
      ...(validDate(step.startTime)
        ? { startedAt: step.startTime.toISOString() }
        : {}),
      ...(step.error
        ? {
            error: {
              ...(step.error.message
                ? { message: step.error.message.slice(0, 100_000) }
                : {}),
              ...(step.error.stack
                ? { stack: step.error.stack.slice(0, 200_000) }
                : {}),
            },
          }
        : {}),
      ...(step.location
        ? {
            location: {
              file: displayPath(step.location.file, rootDir).slice(0, 2_048),
              ...(step.location.line && step.location.line > 0
                ? { line: step.location.line }
                : {}),
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

  for (const step of completePlannedSteps(test, result.steps ?? [], plan))
    visit(step);
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

/** Place unobserved declarations beside their scenario siblings, leaving actual subtrees intact. */
function completePlannedSteps(
  test: ReporterTestCase,
  observed: readonly ReporterTestStep[],
  plan: readonly PlannedStep[],
): ReporterTestStep[] {
  if (!plan.length) return [...observed];
  const clone = (step: ReporterTestStep): ReporterTestStep => ({
    ...step,
    steps: step.steps.map(clone),
  });
  const roots = observed.map(clone);
  const anchors = new Map<
    number,
    { step: ReporterTestStep; siblings: ReporterTestStep[] }
  >();
  const find = (siblings: ReporterTestStep[]) => {
    for (const step of siblings) {
      if (
        step.category === "test.step" &&
        step.location?.line &&
        resolve(step.location.file) === resolve(test.location.file)
      ) {
        anchors.set(step.location.line, { step, siblings });
      }
      find(step.steps);
    }
  };
  find(roots);
  for (let i = 0; i < plan.length; i++) {
    const planned = plan[i]!;
    if (anchors.has(planned.line)) continue;
    const step: ReporterTestStep = {
      title: planned.title,
      category: "test.step",
      duration: 0,
      startTime: new Date(NaN),
      location: { file: test.location.file, line: planned.line },
      annotations: [
        {
          type: "skip",
          description: "Declared BDD step was not executed in this attempt.",
        },
      ],
      attachments: [],
      steps: [],
    };
    const next = plan
      .slice(i + 1)
      .find((p) => p.background === planned.background && anchors.has(p.line));
    const previous = plan
      .slice(0, i)
      .reverse()
      .find((p) => p.background === planned.background && anchors.has(p.line));
    const anchor = next
      ? anchors.get(next.line)
      : previous
        ? anchors.get(previous.line)
        : undefined;
    const beforeHooks = roots.find(
      (s) => s.category === "hook" && s.title === "Before Hooks",
    );
    const siblings =
      anchor?.siblings ??
      (planned.background && beforeHooks ? beforeHooks.steps : roots);
    const afterHooks = siblings.findIndex(
      (s) => s.category === "hook" && s.title === "After Hooks",
    );
    const index = anchor
      ? siblings.indexOf(anchor.step) + (next ? 0 : 1)
      : afterHooks >= 0
        ? afterHooks
        : siblings.length;
    siblings.splice(index, 0, step);
    anchors.set(planned.line, { step, siblings });
  }
  return roots;
}
