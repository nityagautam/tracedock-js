import { junitSuiteName } from "./attachments.js";
import type { ReporterTestCase } from "./types.js";
export interface TestIssueDeclaration {
  suite?: string;
  test: string;
  issues: {
    reference: string;
    provider?: "jira" | "azure" | "github" | "gitlab";
  }[];
}
const prefixes: Record<
  string,
  "jira" | "azure" | "github" | "gitlab" | undefined
> = {
  issue: undefined,
  ticket: undefined,
  jira: "jira",
  azure: "azure",
  azureboard: "azure",
  azureboards: "azure",
  ado: "azure",
  github: "github",
  gitlab: "gitlab",
};
/** Playwright supplies resolved suite/test tags; never infer ticket intent from unrelated tags. */
export function prepareTestIssues(
  tests: readonly ReporterTestCase[],
  rootDir: string,
  warn: (message: string) => void,
): TestIssueDeclaration[] {
  const declarations = new Map<string, TestIssueDeclaration>();
  for (const test of tests) {
    const suite = junitSuiteName(test, rootDir);
    // Matches Playwright's built-in JUnit name, including nested describe titles.
    const name = (test.titlePath().slice(3).join(" › ") || test.title)
      .slice(0, 1000)
      .trim();
    const identity = JSON.stringify([suite ?? "", name]);
    const declaration = declarations.get(identity) ?? {
      ...(suite ? { suite } : {}),
      test: name,
      issues: [],
    };
    for (const tag of test.tags) {
      const match =
        /^@(issue|ticket|jira|azure|azureboard|azureboards|ado|github|gitlab)[:=](.*)$/i.exec(
          tag.trim(),
        );
      if (!match) continue;
      const reference = match[2]!.trim(),
        provider = prefixes[match[1]!.toLowerCase()];
      const isUrl = /^https?:\/\//i.test(reference);
      let valid = reference.length > 0 && reference.length <= 2048;
      if (isUrl) {
        try {
          const url = new URL(reference);
          valid &&= !url.username && !url.password;
        } catch {
          valid = false;
        }
      } else
        valid &&= /^(?:AB#)?[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/i.test(reference);
      if (!valid) {
        warn(
          "Ignored a malformed ticket tag; use @issue:KEY or @ticket:https://tracker/issue.",
        );
        continue;
      }
      if (
        declaration.issues.some(
          (issue) =>
            issue.reference === reference && issue.provider === provider,
        )
      )
        continue;
      if (declaration.issues.length >= 20) {
        warn(
          "Ignored excess ticket tags; at most 20 issue references are supported per test identity.",
        );
        continue;
      }
      declaration.issues.push({ reference, ...(provider ? { provider } : {}) });
    }
    if (name && declaration.issues.length)
      declarations.set(identity, declaration);
  }
  return [...declarations.values()];
}
