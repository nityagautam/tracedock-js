import { mergeTests } from "@playwright/test";
import type { APIResponse } from "@playwright/test";
import { test as bddTest, createBdd } from "playwright-bdd";
import { test as traceoptixTest, expect } from "@traceoptix/playwright/test";

// Preserve BDD's fixtures and use TraceOptix's instrumented API request fixture.
export const test = mergeTests(bddTest, traceoptixTest).extend<{
  apiState: { response?: APIResponse };
}>({
  apiState: async ({}, use) => {
    await use({});
  },
});

export const { Given, When, Then } = createBdd(test);
export { expect };
