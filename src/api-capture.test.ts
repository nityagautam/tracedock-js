import { describe, expect, it, vi } from "vitest";
import type {
  APIRequestContext,
  APIResponse,
  TestInfo,
} from "@playwright/test";
// Exercise the shipped CommonJS module; Vite does not transform .cts source files.
import { captureApiRequests } from "../dist/api-capture.cjs";

function fixture(responseBody = '{"ok":true,"token":"response-secret"}') {
  const response = {
    url: () => "https://api.example/items?token=response-query",
    status: () => 201,
    headers: () => ({
      "content-type": "application/json",
      "set-cookie": "session=secret",
    }),
    body: vi.fn(async () => Buffer.from(responseBody)),
  } as unknown as APIResponse;
  const post = vi.fn(async () => response);
  const dispose = vi.fn();
  const context = {
    post,
    get: post,
    fetch: post,
    dispose,
  } as unknown as APIRequestContext;
  const attach = vi.fn<TestInfo["attach"]>(async () => {});
  return { response, post, dispose, context, attach };
}

describe("API evidence capture", () => {
  it("redacts nested JSON, credentials, query/form fields and produces quoted curl without changing the call", async () => {
    const f = fixture();
    const options = {
      headers: { Authorization: "Bearer secret", "x-api-key": "key-secret" },
      params: { token: "query-secret", page: 2 },
      data: {
        title: "Bob's item",
        password: "password-secret",
        nested: [{ email: "private@example.com" }],
      },
    };
    const api = captureApiRequests(
      f.context,
      { attach: f.attach },
      { baseURL: "https://user:password@api.example", redactFields: ["email"] },
    );
    expect(await api.post("/items", options)).toBe(f.response);
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/items", options);
    expect(f.post.mock.contexts[0]).toBe(f.context);
    const evidence = JSON.stringify(f.attach.mock.calls);
    for (const secret of [
      "response-secret",
      "response-query",
      "session=secret",
      "Bearer secret",
      "key-secret",
      "query-secret",
      "password-secret",
      "private@example.com",
      "user:password",
    ]) {
      expect(evidence).not.toContain(secret);
    }
    const record = JSON.parse(String(f.attach.mock.calls[0]![1]!.body));
    expect(record.request.body.title).toBe("Bob's item");
    expect(record.response.status).toBe(201);
    expect(record.request.curl).toContain(`Bob'"'"'s item`);
    expect(record.request.curl).toContain("--request 'POST'");
    expect(record.request.curl).toContain("page=2");
    api.dispose();
    expect(f.dispose.mock.contexts[0]).toBe(f.context);
  });

  it("captures sanitized form fields but never reads multipart streams", async () => {
    const f = fixture();
    const api = captureApiRequests(f.context, { attach: f.attach });
    await api.post("https://api.example", {
      form: { name: "Joe", password: "secret" },
    });
    const record = JSON.parse(String(f.attach.mock.calls[0]![1]!.body));
    expect(record.request.body).toBe("name=Joe&password=%5BREDACTED%5D");
    expect(record.request.curl).toContain("application/x-www-form-urlencoded");
    await api.post("https://api.example", {
      multipart: {
        file: {
          name: "x",
          mimeType: "text/plain",
          buffer: Buffer.from("secret-file"),
        },
      },
    });
    expect(JSON.stringify(f.attach.mock.calls)).not.toContain("secret-file");
    expect(JSON.stringify(f.attach.mock.calls)).toContain(
      "Multipart body omitted",
    );
  });

  it("bounds evidence, omits oversized and non-JSON bodies, and preserves response access", async () => {
    const f = fixture('{"value":"' + "x".repeat(100) + '"}');
    const api = captureApiRequests(
      f.context,
      { attach: f.attach },
      { maxBodyBytes: 20, maxRequests: 2 },
    );
    await api.post("https://api.example", { data: { value: "x".repeat(100) } });
    await api.post("https://api.example", { data: "raw-secret" });
    await api.post("https://api.example");
    expect(f.post).toHaveBeenCalledTimes(3);
    expect(f.attach).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(f.attach.mock.calls)).not.toContain("raw-secret");
    expect(JSON.stringify(f.attach.mock.calls)).not.toContain("x".repeat(100));
    expect((await f.response.body()).toString()).toContain("x".repeat(100));
  });

  it("records failed calls without exposing raw error messages or replacing the error", async () => {
    const f = fixture();
    const error = new Error("https://secret:password@example.com?token=secret");
    f.post.mockRejectedValue(error);
    const api = captureApiRequests(f.context, { attach: f.attach });
    await expect(api.post("https://api.example")).rejects.toBe(error);
    expect(JSON.stringify(f.attach.mock.calls)).toContain("Request failed");
    expect(JSON.stringify(f.attach.mock.calls)).not.toContain(
      "secret:password",
    );
    f.attach.mockRejectedValue(new Error("attachment failed"));
    await expect(api.post("https://api.example")).rejects.toBe(error);
    f.post.mockResolvedValue(f.response);
    expect(await api.post("https://api.example")).toBe(f.response);
  });

  it("leaves disabled capture untouched and uses the provided step attachment sink", async () => {
    const f = fixture();
    expect(
      captureApiRequests(f.context, { attach: f.attach }, { enabled: false }),
    ).toBe(f.context);
    const stepAttach = vi.fn(async () => {});
    const titles: string[] = [];
    const api = captureApiRequests(
      f.context,
      { attach: f.attach },
      {},
      async (title, body) => {
        titles.push(title);
        return body({ attach: stepAttach });
      },
    );
    await api.get("https://api.example");
    expect(titles).toEqual(["API GET"]);
    expect(f.attach).not.toHaveBeenCalled();
    expect(stepAttach).toHaveBeenCalledTimes(2);
  });
});
