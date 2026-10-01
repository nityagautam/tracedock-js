import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BddStepPlans } from "./step-plan.js";
import type { ReporterTestCase } from "./types.js";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "step-plan-"));
  directories.push(directory);
  const file = join(directory, "generated.spec.js");
  await writeFile(file, source);
  return {
    title: "scenario",
    tags: [],
    titlePath: () => ["scenario"],
    location: { file, line: 8 },
  } satisfies ReporterTestCase;
}
it("reads the exact scenario's expanded background and outline step plan without evaluating JS", async () => {
  const test = await fixture(`// Generated from: features/example.feature
throw new Error("must never execute");
const bddFileData = [ // bdd-data-start
{"pwTestLine":8,"steps":[{"pwStepLine":9,"textWithKeyword":"Given customer Alice","isBg":true},{"pwStepLine":10,"textWithKeyword":"Then order 42 exists"}]},
{"pwTestLine":15,"steps":[{"pwStepLine":16,"textWithKeyword":"Given customer Bob"}]},
]; // bdd-data-end`);
  const plans = new BddStepPlans();
  expect(await plans.forTest(test, vi.fn())).toEqual([
    { line: 9, title: "Given customer Alice", background: true },
    { line: 10, title: "Then order 42 exists", background: false },
  ]);
  expect(
    await plans.forTest(
      { ...test, location: { ...test.location, line: 15 } },
      vi.fn(),
    ),
  ).toEqual([{ line: 16, title: "Given customer Bob", background: false }]);
});
it("falls back for ordinary tests and malformed generated metadata", async () => {
  const ordinary = await fixture('test("ordinary",()=>{});');
  expect(await new BddStepPlans().forTest(ordinary, vi.fn())).toEqual([]);
  const broken = await fixture(
    "// Generated from: example.feature\nconst plan = [ // bdd-data-start\nprocess.exit(1),\n]; // bdd-data-end",
  );
  const warn = vi.fn();
  expect(await new BddStepPlans().forTest(broken, warn)).toEqual([]);
  expect(warn).toHaveBeenCalledOnce();
});
