import { afterEach, expect, it, vi } from "vitest";
import { HttpError, TraceOptixClient } from "./client.js";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("honors Retry-After and preserves the request identity and body", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "Retry-After": "60" } }),
    )
    .mockResolvedValueOnce(Response.json({ runId: "same" }));
  vi.stubGlobal("fetch", fetcher);
  const client = new TraceOptixClient("https://example.test", "secret");
  const pending = client.createRun({ name: "run" }, "stable-key");
  await vi.advanceTimersByTimeAsync(59_999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ runId: "same" });
  expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]);
});
it("bounds repeated rate-limit rejection and leaves permanent failures alone", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response("{}", { status: 429, headers: { "Retry-After": "1" } }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const client = new TraceOptixClient("https://example.test", "secret");
  const pending = client.createRun({}, "key");
  const rejected = expect(pending).rejects.toBeInstanceOf(HttpError);
  await vi.runAllTimersAsync();
  await rejected;
  expect(fetcher).toHaveBeenCalledTimes(4);
  fetcher.mockReset().mockResolvedValue(new Response("{}", { status: 422 }));
  await expect(client.createRun({}, "key")).rejects.toMatchObject({
    status: 422,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("also retries final completion and understands HTTP-date Retry-After", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("{}", {
        status: 429,
        headers: { "Retry-After": "Thu, 01 Oct 2026 00:00:02 GMT" },
      }),
    )
    .mockResolvedValueOnce(Response.json({ status: "parsing" }));
  vi.stubGlobal("fetch", fetcher);
  const client = new TraceOptixClient("https://example.test", "secret");
  const pending = client.complete({
    runId: "id",
    uploads: [],
    attachmentUrl: "/attachments",
    stepsUrl: "/steps",
    testPrioritiesUrl: "/priorities",
    completeUrl: "/complete",
  });
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ status: "parsing" });
});
