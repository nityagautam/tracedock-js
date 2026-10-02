import { expect, it, vi } from "vitest";
import { prepareTestIssues } from "./issues.js";
import type { ReporterTestCase } from "./types.js";
const test = (tags: string[], title = "pays"): ReporterTestCase => ({
  title,
  tags,
  titlePath: () => ["", "chromium", "checkout.spec.ts", "Checkout", title],
  location: { file: "/repo/checkout.spec.ts" },
});
it("detects explicit aliases and inherited tags, preserves JUnit identity and deduplicates", () => {
  const rows = prepareTestIssues(
    [
      test([
        "@smoke",
        "@jira:PAY-123",
        "@JIRA:PAY-123",
        "@ticket:https://github.com/org/repo/issues/1",
        "@ado=88",
      ]),
      test(["@issue:PAY-124"]),
    ],
    "/repo",
    vi.fn(),
  );
  expect(rows).toEqual([
    {
      suite: "checkout.spec.ts",
      test: "Checkout › pays",
      issues: [
        { reference: "PAY-123", provider: "jira" },
        { reference: "https://github.com/org/repo/issues/1" },
        { reference: "88", provider: "azure" },
        { reference: "PAY-124" },
      ],
    },
  ]);
});
it("ignores ordinary and malformed tags, bounds references and does not log secret URLs", () => {
  const warn = vi.fn();
  const rows = prepareTestIssues(
    [
      test([
        "@PAY-123",
        "@issue:",
        "@ticket:javascript:alert(1)",
        "@ticket:https://user:secret@host.test/1",
        ...Array.from({ length: 23 }, (_, i) => `@azure:${i + 1}`),
      ]),
    ],
    "/repo",
    warn,
  );
  expect(rows[0]?.issues).toHaveLength(20);
  expect(warn).toHaveBeenCalled();
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
});
