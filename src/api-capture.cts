import { performance } from "node:perf_hooks";
import type {
  APIRequestContext,
  APIResponse,
  TestInfo,
} from "@playwright/test";

export interface TraceOptixApiOptions {
  /** Resolve relative request URLs for evidence only; never changes the actual request. */
  baseURL?: string;
  /** Context defaults, when known. Credentials and cookie-jar headers are never inferred. */
  extraHTTPHeaders?: Record<string, string>;
  /** Additional case-insensitive header, query, JSON and form field names to redact. */
  redactFields?: string[];
  /** Maximum body bytes retained per direction. Default 64 KiB, hard cap 1 MiB. */
  maxBodyBytes?: number;
  /** Maximum exchanges captured by this wrapper. Default 100, hard cap 1,000. */
  maxRequests?: number;
  enabled?: boolean;
}

type Sink = Pick<TestInfo, "attach">;
export type ApiStepRunner = <T>(
  title: string,
  body: (sink: Sink) => Promise<T>,
) => Promise<T>;
type RequestOptions = NonNullable<Parameters<APIRequestContext["fetch"]>[1]>;
type Input = Parameters<APIRequestContext["fetch"]>[0];
const METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "fetch",
]);
const REDACTED = "[REDACTED]";
const SENSITIVE =
  /authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|signature|session/i;

/** Wrap only public request methods; the original context and returned responses stay intact. */
export function captureApiRequests(
  context: APIRequestContext,
  testInfo: Sink,
  options: TraceOptixApiOptions = {},
  runStep?: ApiStepRunner,
): APIRequestContext {
  if (options.enabled === false) return context;
  const limit = bounded(options.maxBodyBytes, 64 * 1024, 1024 * 1024);
  const maxRequests = bounded(options.maxRequests, 100, 1000);
  const redact = redactor(options.redactFields ?? []);
  let sequence = 0;
  return new Proxy(context, {
    get(target, property) {
      const original = Reflect.get(target, property, target);
      if (typeof original !== "function") return original;
      if (!METHODS.has(String(property))) return original.bind(target);
      return async (input: Input, requestOptions: RequestOptions = {}) => {
        const invoke = () =>
          original.call(target, input, requestOptions) as Promise<APIResponse>;
        if (sequence >= maxRequests) return invoke();
        const id = ++sequence;
        // Evidence inspection must not prevent an otherwise valid API call.
        let request: ReturnType<typeof describeRequest> | undefined;
        try {
          request = describeRequest(
            String(property),
            input,
            requestOptions,
            options,
            limit,
            redact,
          );
        } catch {
          /* Unsupported evidence is omitted; the request still runs. */
        }
        const execute = async (sink: Sink) => {
          const startedAt = new Date().toISOString();
          const started = performance.now();
          let response: APIResponse | undefined;
          let failed = false;
          try {
            response = await invoke();
            return response;
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            const durationMs = Math.round(performance.now() - started);
            try {
              const responseEvidence = response
                ? await describeResponse(response, limit, redact)
                : undefined;
              await sink.attach(`api-${id}.json`, {
                contentType: "application/json",
                body: JSON.stringify(
                  {
                    schemaVersion: 1,
                    startedAt,
                    durationMs,
                    request,
                    response: responseEvidence,
                    ...(failed
                      ? {
                          error:
                            "Request failed; see the Playwright step for the original error.",
                        }
                      : {}),
                    notes: [
                      "Request evidence reflects supplied options, not a wire capture. Automatic cookies, credentials, redirect hops and transport-added headers are not included.",
                    ],
                  },
                  null,
                  2,
                ),
              });
              if (request)
                await sink.attach(`api-${id}.curl.txt`, {
                  contentType: "text/plain",
                  body: request.curl,
                });
            } catch {
              /* Attachment failures must never replace the request's result or error. */
            }
          }
        };
        return runStep
          ? runStep(
              `API ${request?.method ?? String(property).toUpperCase()}`,
              execute,
            )
          : execute(testInfo);
      };
    },
  });
}

function describeRequest(
  operation: string,
  input: Input,
  requestOptions: RequestOptions,
  options: TraceOptixApiOptions,
  limit: number,
  redact: ReturnType<typeof redactor>,
) {
  const source = typeof input === "string" ? undefined : input;
  const rawUrl = typeof input === "string" ? input : input.url();
  const method = (
    operation === "fetch"
      ? (requestOptions.method ?? source?.method() ?? "GET")
      : operation
  ).toUpperCase();
  const url = new URL(rawUrl, options.baseURL);
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const [key, value] of parameters(requestOptions.params))
    url.searchParams.append(key, value);
  for (const key of [...url.searchParams.keys()]) {
    if (redact.sensitive(key)) url.searchParams.set(key, REDACTED);
  }
  const headers: Record<string, string> = {};
  for (const layer of [
    options.extraHTTPHeaders,
    source?.headers(),
    requestOptions.headers,
  ]) {
    for (const [key, value] of Object.entries(layer ?? {}))
      headers[key.toLowerCase()] = value;
  }
  let body: unknown;
  let bodyText: string | undefined;
  let bodyOmitted: string | undefined;
  if (requestOptions.multipart !== undefined) {
    bodyOmitted =
      "Multipart body omitted; files and streams are never consumed for evidence.";
  } else if (requestOptions.form !== undefined) {
    const form = new URLSearchParams();
    for (const [key, value] of parameters(requestOptions.form))
      form.append(key, redact.sensitive(key) ? REDACTED : value);
    const encoded = form.toString();
    if (Buffer.byteLength(encoded) <= limit) {
      bodyText = encoded;
      body = encoded;
      headers["content-type"] ??= "application/x-www-form-urlencoded";
    } else bodyOmitted = "Body exceeds capture limit.";
  } else {
    const data = requestOptions.data ?? source?.postDataBuffer() ?? undefined;
    if (data !== undefined) {
      const captured = captureBody(data, limit, redact);
      body = captured.body;
      bodyText = captured.text;
      bodyOmitted = captured.omitted;
      // Playwright infers JSON only for object data; preserve explicitly supplied types.
      headers["content-type"] ??=
        typeof data === "object" && !Buffer.isBuffer(data)
          ? "application/json"
          : "application/octet-stream";
    }
  }
  const safeHeaders = redact.fields(headers) as Record<string, string>;
  const parts = [
    "curl",
    "--request",
    quote(method),
    "--url",
    quote(url.toString()),
  ];
  for (const [key, value] of Object.entries(safeHeaders)) {
    // A captured length no longer describes a redacted/omitted body.
    if (key !== "content-length")
      parts.push("--header", quote(`${key}: ${value}`));
  }
  if (bodyText !== undefined) parts.push("--data-raw", quote(bodyText));
  return {
    method,
    url: url.toString(),
    headers: safeHeaders,
    body,
    bodyOmitted,
    curl: [
      "# Redacted request template. Replace credentials before replay.",
      "# Automatic cookies/auth and redirect hops are not captured.",
      ...(bodyOmitted
        ? [`# ${bodyOmitted} Supply the original body before replay.`]
        : []),
      parts.join(" "),
      "",
    ].join("\n"),
  };
}

async function describeResponse(
  response: APIResponse,
  limit: number,
  redact: ReturnType<typeof redactor>,
) {
  const headers = response.headers();
  let captured: ReturnType<typeof captureBody> = {
    omitted: "Non-JSON response body omitted.",
  };
  if (/\bjson\b/i.test(headers["content-type"] ?? "")) {
    const length = Number(headers["content-length"]);
    if (Number.isFinite(length) && length > limit)
      captured = { omitted: "Body exceeds capture limit." };
    else {
      try {
        captured = captureBody(await response.body(), limit, redact);
      } catch {
        captured = { omitted: "Response body unavailable." };
      }
    }
  }
  const url = new URL(response.url());
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (redact.sensitive(key)) url.searchParams.set(key, REDACTED);
  // Location can contain credentials/query secrets; omit it instead of copying an opaque value.
  const safeHeaders = redact.fields(headers) as Record<string, string>;
  if (safeHeaders.location) safeHeaders.location = REDACTED;
  return {
    url: url.toString(),
    status: response.status(),
    headers: safeHeaders,
    body: captured.body,
    bodyOmitted: captured.omitted,
  };
}

function captureBody(
  data: unknown,
  limit: number,
  redact: ReturnType<typeof redactor>,
): { body?: unknown; text?: string; omitted?: string } {
  const raw = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : typeof data === "string"
      ? data
      : JSON.stringify(data);
  if (!raw || Buffer.byteLength(raw) > limit)
    return { omitted: "Body is empty or exceeds capture limit." };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      return { omitted: "Unstructured body omitted." };
    const body = redact.fields(parsed);
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > limit)
      return { omitted: "Redacted body exceeds capture limit." };
    return { body, text };
  } catch {
    return { omitted: "Non-JSON or binary body omitted." };
  }
}

function redactor(extra: string[]) {
  const names = new Set(extra.map((name) => name.toLowerCase()));
  const sensitive = (key: string) =>
    SENSITIVE.test(key) || names.has(key.toLowerCase());
  const fields = (value: unknown, depth = 0): unknown => {
    if (depth > 30) return "[OMITTED: depth limit]";
    if (Array.isArray(value))
      return value.map((item) => fields(item, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          sensitive(key) ? REDACTED : fields(item, depth + 1),
        ]),
      );
    return value;
  };
  return { sensitive, fields };
}

function parameters(value: unknown): Array<[string, string]> {
  if (typeof value === "string" || value instanceof URLSearchParams)
    return [...new URLSearchParams(value)];
  if (value && typeof value === "object")
    return Object.entries(value).map(([key, item]) => [key, String(item)]);
  return [];
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function bounded(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.min(max, Math.floor(value)))
    : fallback;
}
