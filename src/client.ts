import type { AttachmentDeclaration } from "./attachments.js";
import type { TestPriorityDeclaration } from "./priorities.js";
import type { StepBatch } from "./steps.js";

export interface PresignedUpload {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface ArtifactUpload extends PresignedUpload {
  artifactId: string;
  filename: string;
}

export interface AttachmentUpload extends PresignedUpload {
  attachmentId: string;
  name: string;
}

export interface CreateRunResponse {
  runId: string;
  uploads: ArtifactUpload[];
  attachmentUrl: string;
  stepsUrl: string;
  testPrioritiesUrl: string;
  completeUrl: string;
}

export interface CompleteRunResponse {
  runId: string;
  status: "parsing";
  missingAttachments?: string[];
}

export interface PublishCapabilitiesResponse {
  schemaVersion: 1;
  project: string;
  collectionMode: "full" | "summary_only";
  policyRevision: number;
  expiresAt: string;
  summarySchemaVersion: 1;
  summary: { limit: number; used: number; remaining: number; periodEnd: string } | null;
  summaryUrl: string;
}

export interface CreateSummaryRunResponse {
  runId: string;
  status: "complete";
  dataMode: "summary_only";
}

export class TraceDockClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  createRun(body: unknown, idempotencyKey: string): Promise<CreateRunResponse> {
    return this.requestJson<CreateRunResponse>("/api/v1/runs", {
      body,
      headers: { "idempotency-key": idempotencyKey },
    });
  }

  async getPublishCapabilities(
    project: string,
    timeoutMs = 5_000,
  ): Promise<PublishCapabilitiesResponse> {
    const response = await this.requestJson<unknown>(
      `/api/v1/projects/${encodeURIComponent(project)}/publish-capabilities`,
      { method: "GET", signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!isPublishCapabilitiesResponse(response)) {
      throw new Error("TraceDock returned an unsupported publish-capability response");
    }
    if (Date.parse(response.expiresAt) <= Date.now()) {
      throw new Error("TraceDock returned an expired publish-capability response");
    }
    return response;
  }

  createSummaryRun(
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<CreateSummaryRunResponse> {
    return this.requestJson<CreateSummaryRunResponse>(path, {
      body,
      headers: { "idempotency-key": idempotencyKey },
    });
  }

  declareAttachments(
    run: CreateRunResponse,
    declarations: AttachmentDeclaration[],
  ): Promise<{
    uploads: AttachmentUpload[];
  }> {
    return this.requestJson<{ uploads: AttachmentUpload[] }>(run.attachmentUrl, {
      body: { attachments: declarations },
    });
  }

  declareSteps(
    run: CreateRunResponse,
    batch: StepBatch,
  ): Promise<{ declared: number; inserted: number }> {
    return this.requestJson<{ declared: number; inserted: number }>(run.stepsUrl, { body: batch });
  }

  async declareTestPriorities(
    run: CreateRunResponse,
    tests: readonly TestPriorityDeclaration[],
  ): Promise<number> {
    let declared = 0;
    for (let offset = 0; offset < tests.length; offset += 1_000) {
      const chunk = tests.slice(offset, offset + 1_000);
      const response = await this.requestJson<{ declared: number }>(run.testPrioritiesUrl, {
        body: { tests: chunk },
      });
      declared += response.declared;
    }
    return declared;
  }

  async refreshArtifact(runId: string, artifactId: string): Promise<ArtifactUpload> {
    const response = await this.requestJson<{ uploads: ArtifactUpload[] }>(
      `/api/v1/runs/${runId}/artifact-upload-urls`,
      { body: { artifactIds: [artifactId] } },
    );
    const upload = response.uploads.find((candidate) => candidate.artifactId === artifactId);
    if (!upload) throw new Error("artifact refresh returned no upload URL");
    return upload;
  }

  complete(run: CreateRunResponse): Promise<CompleteRunResponse> {
    return this.requestJson<CompleteRunResponse>(run.completeUrl, {});
  }

  async put(upload: PresignedUpload, body: Buffer): Promise<void> {
    const response = await fetch(this.absoluteUrl(upload.uploadUrl), {
      method: upload.method,
      headers: upload.headers,
      body,
    });
    if (!response.ok)
      throw new HttpError(response.status, `object upload returned HTTP ${response.status}`);
  }

  isNearExpiry(upload: PresignedUpload, now = Date.now()): boolean {
    const expiry = Date.parse(upload.expiresAt);
    return !Number.isFinite(expiry) || expiry <= now + 5_000;
  }

  private async requestJson<Response>(
    path: string,
    request: {
      body?: unknown;
      headers?: Record<string, string>;
      method?: "GET" | "POST";
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const response = await fetch(this.absoluteUrl(path), {
      method: request.method ?? "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...request.headers,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: request.signal,
    });

    if (!response.ok) {
      let message = `TraceDock API returned HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { message?: string }; message?: string };
        message = body.error?.message ?? body.message ?? message;
      } catch {
        // A proxy often returns HTML. Status is safer and more useful than logging that body.
      }
      throw new HttpError(response.status, message);
    }
    return (await response.json()) as Response;
  }

  private absoluteUrl(path: string): string {
    return new URL(path, `${this.baseUrl}/`).toString();
  }
}

function isPublishCapabilitiesResponse(value: unknown): value is PublishCapabilitiesResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PublishCapabilitiesResponse>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.summarySchemaVersion === 1 &&
    (candidate.collectionMode === "full" || candidate.collectionMode === "summary_only") &&
    typeof candidate.project === "string" &&
    Number.isSafeInteger(candidate.policyRevision) &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(Date.parse(candidate.expiresAt)) &&
    typeof candidate.summaryUrl === "string" &&
    (candidate.summary === null ||
      (typeof candidate.summary === "object" &&
        Number.isSafeInteger(candidate.summary.limit) &&
        Number.isSafeInteger(candidate.summary.used) &&
        Number.isSafeInteger(candidate.summary.remaining) &&
        typeof candidate.summary.periodEnd === "string"))
  );
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async use<Value>(operation: () => Promise<Value>): Promise<Value> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}
