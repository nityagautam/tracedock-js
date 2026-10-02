import { readFile, stat } from "node:fs/promises";
import type { ReporterTestCase } from "./types.js";

export interface PlannedStep {
  line: number;
  title: string;
  background: boolean;
}
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Read generated JSON metadata, never execute/import a user's test file. */
export class BddStepPlans {
  private readonly files = new Map<
    string,
    Promise<Map<number, PlannedStep[]>>
  >();

  async forTest(
    test: ReporterTestCase,
    warn: (message: string) => void,
  ): Promise<PlannedStep[]> {
    if (!test.location.line) return [];
    let pending = this.files.get(test.location.file);
    if (!pending) {
      if (this.files.size >= 8)
        this.files.delete(this.files.keys().next().value!);
      pending = this.read(test.location.file, warn);
      this.files.set(test.location.file, pending);
    }
    return (await pending).get(test.location.line) ?? [];
  }

  private async read(
    file: string,
    warn: (message: string) => void,
  ): Promise<Map<number, PlannedStep[]>> {
    const plans = new Map<number, PlannedStep[]>();
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) return plans;
      const source = await readFile(file, "utf8");
      if (
        Buffer.byteLength(source) > MAX_FILE_BYTES ||
        !source.startsWith("// Generated from:")
      )
        return plans;
      const lines = source.split(/\r?\n/);
      const start = lines.findIndex((line) =>
        line.trimEnd().endsWith("// bdd-data-start"),
      );
      const end = lines.findIndex((line) =>
        line.trimEnd().endsWith("// bdd-data-end"),
      );
      if (start < 0 || end <= start) return plans;
      for (const line of lines.slice(start + 1, end)) {
        if (!line.trim()) continue;
        const entry: unknown = JSON.parse(line.trim().replace(/,$/, ""));
        if (!entry || typeof entry !== "object")
          throw new Error("invalid BDD plan");
        const data = entry as { pwTestLine?: unknown; steps?: unknown };
        if (
          !Number.isSafeInteger(data.pwTestLine) ||
          (data.pwTestLine as number) < 1 ||
          !Array.isArray(data.steps) ||
          data.steps.length > 5_000
        )
          throw new Error("invalid BDD plan");
        const steps: PlannedStep[] = [];
        const seen = new Set<number>();
        for (const value of data.steps) {
          if (
            !value ||
            typeof value !== "object" ||
            !Number.isSafeInteger(value.pwStepLine) ||
            value.pwStepLine < 1 ||
            seen.has(value.pwStepLine) ||
            typeof value.textWithKeyword !== "string" ||
            !value.textWithKeyword.trim()
          )
            throw new Error("invalid BDD step");
          seen.add(value.pwStepLine);
          steps.push({
            line: value.pwStepLine,
            title: value.textWithKeyword.slice(0, 1_024),
            background: value.isBg === true,
          });
        }
        if (plans.has(data.pwTestLine as number))
          throw new Error("ambiguous BDD test");
        plans.set(data.pwTestLine as number, steps);
      }
    } catch (error) {
      // A normal Playwright test has no BDD metadata. Missing source is expected for blob replays.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warn(
          "Could not read the BDD step plan; reporting only observed steps.",
        );
      plans.clear();
    }
    return plans;
  }
}
