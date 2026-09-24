import { junitSuiteName } from "./attachments.js";
import type { ReporterTestCase } from "./types.js";

const PRIORITY_TAG = /^@p([0-3])$/i;

export type TestPriority = "P0" | "P1" | "P2" | "P3";

export interface TestPriorityDeclaration {
  suite?: string;
  test: string;
  priority: TestPriority | null;
}

/** Convert Playwright's resolved test/suite tags into one declaration per JUnit identity. */
export function prepareTestPriorities(
  tests: readonly ReporterTestCase[],
  rootDir: string,
  warn: (message: string) => void,
): TestPriorityDeclaration[] {
  const declarations = new Map<string, TestPriorityDeclaration>();

  for (const test of tests) {
    const suite = junitSuiteName(test, rootDir);
    const name = test.title.slice(0, 1_000);
    const identity = `${suite ?? ""}\0${name}`;
    const matches = [
      ...new Set(
        test.tags
          .map((tag) => PRIORITY_TAG.exec(tag.trim())?.[1])
          .filter((value): value is string => value !== undefined)
          .map((value) => `P${value}` as TestPriority),
      ),
    ];

    if (matches.length > 1) {
      warn(
        `Using @${matches[0]!.toLowerCase()} for "${test.title}" because it is the first priority tag; ignored ${matches
          .slice(1)
          .map((priority) => `@${priority.toLowerCase()}`)
          .join(", ")}.`,
      );
    }

    const declaration: TestPriorityDeclaration = {
      ...(suite ? { suite } : {}),
      test: name,
      priority: matches[0] ?? null,
    };
    const existing = declarations.get(identity);
    if (existing && existing.priority !== declaration.priority) {
      warn(
        `Using ${existing.priority ? `@${existing.priority.toLowerCase()}` : "no priority"} for "${test.title}" from the first Playwright project; ignored ${declaration.priority ? `@${declaration.priority.toLowerCase()}` : "no priority"} from a later project.`,
      );
      continue;
    }
    declarations.set(identity, declaration);
  }

  return [...declarations.values()];
}

export function priorityTagsEnabled(
  option: boolean | undefined,
  environmentValue: string | undefined,
): boolean {
  if (option !== undefined) return option;
  if (!environmentValue) return true;
  return !["0", "false", "no", "off"].includes(environmentValue.trim().toLowerCase());
}
