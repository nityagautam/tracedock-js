import { test as base, expect } from "@playwright/test";
import { captureApiRequests } from "./api-capture.cjs";
import type { TraceOptixApiOptions } from "./api-capture.cjs";

export interface TraceOptixTestOptions {
  traceoptixApi: TraceOptixApiOptions;
}

/** Opt-in fixture entry point; importing the reporter never changes test fixtures. */
export const test = base.extend<TraceOptixTestOptions>({
  traceoptixApi: [{}, { option: true }],
  request: async (
    { request, baseURL, extraHTTPHeaders, traceoptixApi },
    use,
    testInfo,
  ) => {
    await use(
      captureApiRequests(
        request,
        testInfo,
        { baseURL, extraHTTPHeaders, ...traceoptixApi },
        (title, body) =>
          base.step(title, async (step) =>
            body(typeof step?.attach === "function" ? step : testInfo),
          ),
      ),
    );
  },
});

export { expect };
