type RetainOnFailure = "retain-on-failure";

type ConfigUse<TConfig> = TConfig extends { use?: infer TUse }
  ? TUse extends object
    ? TUse
    : object
  : object;

type DefaultedPolicy<TUse extends object, TKey extends "trace" | "video"> = TKey extends keyof TUse
  ? Exclude<TUse[TKey], null | undefined> | RetainOnFailure
  : RetainOnFailure;

export type TraceDockEvidenceDefaults<TUse extends object = object> = Omit<
  TUse,
  "trace" | "video"
> & {
  trace: DefaultedPolicy<TUse, "trace">;
  video: DefaultedPolicy<TUse, "video">;
};

type TraceDockConfig<TConfig extends object> = Omit<TConfig, "use"> & {
  use: TraceDockEvidenceDefaults<ConfigUse<TConfig>>;
};

/**
 * Applies evidence policy before Playwright resolves projects. A reporter callback runs too late
 * to change capture behavior, so this stays an ordinary, immutable config transformation.
 */
export function withTraceDockDefaults<const TConfig extends object>(
  config: TConfig,
): TraceDockConfig<TConfig> {
  const use = ((config as { use?: Record<string, unknown> }).use ?? {}) as Record<string, unknown>;
  return {
    ...config,
    use: {
      ...use,
      trace: use.trace ?? "retain-on-failure",
      video: use.video ?? "retain-on-failure",
    },
  } as TraceDockConfig<TConfig>;
}
