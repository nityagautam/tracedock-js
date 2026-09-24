const DEFAULT_RUN_NAME_PATTERN = "{name}-{timestamp}";

/**
 * A compact UTC timestamp keeps names sortable and safe in URLs, shells and filenames.
 * Milliseconds matter when shards or retries start within the same second.
 */
export function formatRunName(baseName: string, startedAt: Date, pattern?: string): string {
  const resolvedPattern = pattern?.trim() || DEFAULT_RUN_NAME_PATTERN;
  const timestamp = startedAt
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "");
  return resolvedPattern.replaceAll("{name}", baseName).replaceAll("{timestamp}", timestamp);
}
