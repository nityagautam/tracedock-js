const MAX_RUN_TAGS = 50;
const MAX_RUN_TAG_KEY_LENGTH = 40;
const MAX_RUN_TAG_VALUE_LENGTH = 200;
const RUN_TAG_KEY = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Resolve CI-controlled run tags without conflating them with Playwright's testcase tags.
 * Reporter options win over the environment, while system tags are always retained and cannot be
 * spoofed by configuration.
 */
export function resolveRunTags(
  environmentValue: string | undefined,
  optionTags: Record<string, string> | undefined,
  systemTags: Record<string, string>,
  warn: (message: string) => void,
): Record<string, string> {
  const configured = normalizedEntries({
    ...parseEnvironmentTags(environmentValue, warn),
    ...optionTags,
  });
  const system = Object.fromEntries(normalizedEntries(systemTags));
  const reservedKeys = new Set(Object.keys(system));
  const availableConfiguredSlots = Math.max(0, MAX_RUN_TAGS - reservedKeys.size);

  return {
    ...Object.fromEntries(
      configured.filter(([key]) => !reservedKeys.has(key)).slice(0, availableConfiguredSlots),
    ),
    ...system,
  };
}

function parseEnvironmentTags(
  value: string | undefined,
  warn: (message: string) => void,
): Record<string, string> {
  const input = value?.trim();
  if (!input) return {};

  if (input.startsWith("{")) {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warn("Ignoring TRACEDOCK_RUN_TAGS because its JSON value must be an object.");
        return {};
      }
      const tags: Record<string, string> = {};
      for (const [key, rawValue] of Object.entries(parsed)) {
        if (
          typeof rawValue !== "string" &&
          typeof rawValue !== "number" &&
          typeof rawValue !== "boolean"
        ) {
          warn(
            `Ignoring TRACEDOCK_RUN_TAGS entry "${key}" because its value is not a string, number, or boolean.`,
          );
          continue;
        }
        tags[key] = String(rawValue);
      }
      return tags;
    } catch {
      warn("Ignoring TRACEDOCK_RUN_TAGS because it is not valid JSON.");
      return {};
    }
  }

  const tags: Record<string, string> = {};
  for (const rawEntry of input.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const equals = entry.indexOf("=");
    const colon = entry.indexOf(":");
    const separator = equals > 0 ? equals : colon > 0 ? colon : -1;
    if (separator < 1 || !entry.slice(separator + 1).trim()) {
      warn(
        `Ignoring malformed TRACEDOCK_RUN_TAGS entry "${entry}"; expected key=value or key:value.`,
      );
      continue;
    }
    tags[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return tags;
}

function normalizedEntries(input: Record<string, string>): Array<readonly [string, string]> {
  return Object.entries(input)
    .map(([rawKey, rawValue]) => {
      const key = rawKey.trim().toLowerCase().replace(/\s+/g, "-").slice(0, MAX_RUN_TAG_KEY_LENGTH);
      const value = rawValue.trim().slice(0, MAX_RUN_TAG_VALUE_LENGTH);
      return key && value && RUN_TAG_KEY.test(key) ? ([key, value] as const) : null;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);
}
