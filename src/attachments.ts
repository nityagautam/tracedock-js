import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { ReporterAttachment, ReporterTestCase, ReporterTestResult } from "./types.js";

export type AttachmentKind =
  "screenshot" | "video" | "trace" | "log" | "har" | "report" | "diff" | "other";

export interface AttachmentDeclaration {
  kind: AttachmentKind;
  name: string;
  contentType: string;
  bytes: number;
  suite?: string;
  test: string;
  attempt: number;
  stepId?: string;
}

export interface PreparedAttachment {
  declaration: AttachmentDeclaration;
  body: Buffer;
}

const MAX_BYTES: Record<AttachmentKind, number> = {
  screenshot: 10 * 1024 * 1024,
  diff: 10 * 1024 * 1024,
  log: 10 * 1024 * 1024,
  har: 50 * 1024 * 1024,
  report: 50 * 1024 * 1024,
  trace: 100 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  other: 50 * 1024 * 1024,
};

export async function prepareAttachments(
  test: ReporterTestCase,
  result: ReporterTestResult,
  rootDir: string,
  warn: (message: string) => void,
  stepIdForAttachment?: (attachment: ReporterAttachment) => string | undefined,
): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  const identities = new Map<string, number>();
  const suite = junitSuiteName(test, rootDir);

  for (const attachment of result.attachments) {
    try {
      const body = await attachmentBody(attachment, rootDir);
      if (!body) {
        warn(`Skipped attachment "${attachment.name}": it has neither a path nor a body.`);
        continue;
      }

      const classified = classifyAttachment(attachment);
      if (body.byteLength > MAX_BYTES[classified.kind]) {
        warn(
          `Skipped attachment "${attachment.name}": ${body.byteLength} bytes exceeds the ${classified.kind} limit of ${MAX_BYTES[classified.kind]}.`,
        );
        continue;
      }

      const baseName = attachmentFileName(attachment, classified.extension);
      const identity = `${classified.kind}\0${baseName}`;
      const occurrence = (identities.get(identity) ?? 0) + 1;
      identities.set(identity, occurrence);
      const name = occurrence === 1 ? baseName : numberedName(baseName, occurrence);

      prepared.push({
        body,
        declaration: {
          kind: classified.kind,
          name: name.slice(0, 512),
          contentType: classified.contentType,
          bytes: body.byteLength,
          ...(suite ? { suite } : {}),
          test: test.title.slice(0, 1000),
          attempt: result.retry,
          ...(stepIdForAttachment?.(attachment) ? { stepId: stepIdForAttachment(attachment) } : {}),
        },
      });
    } catch (error) {
      warn(`Skipped attachment "${attachment.name}": ${safeErrorMessage(error)}`);
    }
  }
  return prepared;
}

export function classifyAttachment(attachment: ReporterAttachment): {
  kind: AttachmentKind;
  contentType: string;
  extension: string;
} {
  const contentType = attachment.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const candidate = `${attachment.name} ${attachment.path ?? ""}`.toLowerCase();
  const extension = extname(attachment.path ?? attachment.name).toLowerCase();

  if (
    contentType.startsWith("image/") ||
    [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)
  ) {
    const kind = /(^|[\s_.-])diff([\s_.-]|$)/.test(candidate) ? "diff" : "screenshot";
    const normalized = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType)
      ? contentType
      : extension === ".jpg" || extension === ".jpeg"
        ? "image/jpeg"
        : extension === ".webp"
          ? "image/webp"
          : extension === ".gif" && kind === "screenshot"
            ? "image/gif"
            : "image/png";
    return { kind, contentType: normalized, extension: extension || extensionFor(normalized) };
  }
  if (contentType.startsWith("video/") || extension === ".webm" || extension === ".mp4") {
    const normalized =
      contentType === "video/mp4" || extension === ".mp4" ? "video/mp4" : "video/webm";
    return {
      kind: "video",
      contentType: normalized,
      extension: extension || extensionFor(normalized),
    };
  }
  if (candidate.includes("trace") && (contentType === "application/zip" || extension === ".zip")) {
    return { kind: "trace", contentType: "application/zip", extension: ".zip" };
  }
  if (
    contentType === "application/x-har+json" ||
    extension === ".har" ||
    candidate.includes("har")
  ) {
    return { kind: "har", contentType: "application/json", extension: extension || ".har" };
  }
  if (contentType === "text/html" || extension === ".html" || extension === ".htm") {
    return { kind: "report", contentType: "text/html", extension: extension || ".html" };
  }
  if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/x-ndjson" ||
    [".log", ".txt", ".md", ".json", ".ndjson"].includes(extension)
  ) {
    const normalized =
      contentType === "application/json" || contentType === "application/x-ndjson"
        ? contentType
        : "text/plain";
    return {
      kind: "log",
      contentType: normalized,
      extension: extension || extensionFor(normalized),
    };
  }
  if (contentType === "application/zip" || extension === ".zip") {
    return { kind: "other", contentType: "application/zip", extension: ".zip" };
  }
  return {
    kind: "other",
    contentType: "application/octet-stream",
    extension,
  };
}

export function junitSuiteName(test: ReporterTestCase, rootDir: string): string | undefined {
  const titlePath = test.titlePath();
  // Playwright's hierarchy is root, project, file, then describes/test. Its JUnit reporter uses
  // the file suite's title as `classname`, so index 2 is the exact identity Test Center parses.
  const fileSuite = titlePath[2];
  if (fileSuite?.trim()) return fileSuite.slice(0, 500);

  const relative = test.location.file.startsWith(rootDir)
    ? test.location.file.slice(rootDir.length).replace(/^[/\\]/, "")
    : basename(test.location.file);
  return relative ? relative.slice(0, 500) : undefined;
}

export function safeErrorMessage(error: unknown): string {
  const raw =
    typeof error === "string" ? error : error instanceof Error ? error.message : "upload failed";
  return raw
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&](?:signature|token|credential|x-amz-signature)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/https?:\/\/\S+/gi, "[redacted URL]")
    .slice(0, 500);
}

async function attachmentBody(
  attachment: ReporterAttachment,
  rootDir: string,
): Promise<Buffer | null> {
  if (attachment.body) return attachment.body;
  if (!attachment.path) return null;
  const file = resolve(rootDir, attachment.path);
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error("attachment path is not a file");
  return readFile(file);
}

function attachmentFileName(attachment: ReporterAttachment, inferredExtension: string): string {
  const pathName = attachment.path ? basename(attachment.path) : "";
  const named = basename(attachment.name.trim()) || pathName || "attachment";
  if (extname(named) || !inferredExtension) return named;
  return `${named}${inferredExtension}`;
}

function numberedName(name: string, occurrence: number): string {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem}-${occurrence}${extension}`;
}

function extensionFor(contentType: string): string {
  return (
    {
      "application/json": ".json",
      "application/x-ndjson": ".ndjson",
      "image/gif": ".gif",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "text/plain": ".txt",
      "video/mp4": ".mp4",
      "video/webm": ".webm",
    }[contentType] ?? ""
  );
}
