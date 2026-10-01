# `@traceoptix/playwright`

Source development lives in the standalone `traceoptix-playwright` repository. Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, and `pnpm test` from this directory. See [local development](LOCAL_DEVELOPMENT.md) for packing and installation.

Publish Playwright JUnit results, the complete test-step tree, screenshots, videos, traces, HAR
files and logs to TraceOptix. Evidence is linked to the testcase, retry and originating step that
produced it. Publishing is warning-only: a TraceOptix or object-storage outage never changes
Playwright's exit code.

Upload capacity is configured on the TraceOptix server using `TRACEOPTIX_UPLOAD_*`, not in
this reporter's environment. Live publication uses signed per-file uploads, so the server's
single-shot request cap does not apply. Evidence has fixed per-kind caps, and portable run ZIPs
have separate archive/structure limits. In the server repository, see
[`docs/upload-limits.md`](../../../docs/upload-limits.md) for the complete path/type matrix.

## Install

```bash
npm install --save-dev @traceoptix/playwright
```

To build and pack an unpublished checkout, run these commands from the TraceOptix repository root:

```bash
pnpm --filter @traceoptix/playwright build
pnpm --filter @traceoptix/playwright test
mkdir -p /absolute/path/to/playwright-project/scripts/vendor
npm pack ./src/packages/playwright-reporter-plugin --pack-destination /absolute/path/to/playwright-project/scripts/vendor
cd /absolute/path/to/playwright-project
npm install --save-dev ./scripts/vendor/traceoptix-playwright-1.0.2.tgz
```

`npm pack` also runs the package's `prepack` build, preventing a stale `dist` directory from being
archived. Install the exact filename printed by `npm pack`; it changes when the package version
changes. For lockfile-only installation, rebuilds, Windows commands, and troubleshooting malformed
shell continuations, follow [`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md).

## Configure

Keep Playwright's built-in JUnit reporter and give both reporters the same file:

### Option A: apply the evidence defaults

Use `withTraceOptixDefaults` when you want the integration to retain Playwright traces and videos
for failed tests without repeating those policies in your configuration:

```ts
import { defineConfig } from "@playwright/test";
import { withTraceOptixDefaults } from "@traceoptix/playwright";

const junitFile = "test-results/junit.xml";

export default defineConfig(
  withTraceOptixDefaults({
    reporter: [
      ["line"],
      ["junit", { outputFile: junitFile, includeRetries: true }],
      [
        "@traceoptix/playwright",
        {
          junitFile,
          project: "checkout-web",
          name: "checkout-e2e",
          // This is the default; shown here to make the resulting run name explicit.
          namePattern: "{name}-{timestamp}",
          // Optional; @p0 through @p3 are synchronized by default.
          priority: { fromTags: true },
          // Optional. Defaults to test-results/traceoptix-bundles beside junit.xml.
          bundle: { outputDir: "test-results/traceoptix-bundles" },
        },
      ],
    ],
    outputDir: "test-results/artifacts",
    use: { screenshot: "only-on-failure" },
  }),
);
```

The helper returns a new configuration and does not mutate the supplied object. It preserves every
existing top-level option and every unrelated `use` option. Explicit `trace` and `video` policies,
including `"off"`, are also preserved; only a missing or nullish policy receives
`"retain-on-failure"`. Per-project `use` overrides remain unchanged and continue to win through
Playwright's normal configuration inheritance.

There is therefore no unrelated configuration side effect from wrapping an existing config. The
one deliberate effect is that a previously unspecified trace or video policy starts retaining that
evidence for failed tests, which can add some execution time and artifact storage.

### Option B: keep an existing configuration unchanged

The helper is optional. If a project already has its complete Playwright configuration and evidence
policy, add only the JUnit and TraceOptix reporter entries:

```ts
import { defineConfig } from "@playwright/test";

const junitFile = "test-results/junit.xml";

export default defineConfig({
  reporter: [
    ["line"],
    ["junit", { outputFile: junitFile, includeRetries: true }],
    [
      "@traceoptix/playwright",
      {
        junitFile,
        project: "checkout-web",
        name: "checkout-e2e",
      },
    ],
  ],
  outputDir: "test-results/artifacts",
  use: {
    baseURL: "https://checkout.example.com",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  retries: 2,
  workers: 4,
});
```

Existing trace and video choices do not have to be changed. The reporter publishes the evidence
Playwright produces under those policies; for example, `trace: "off"` remains valid but naturally
means there is no trace to upload. Whether defaults are written manually or applied by the helper,
they must be resolved while Playwright builds its configuration—the reporter callback itself is too
late to change what Playwright records.

On servers advertising execution presence v1, the reporter registers a **Running** execution at
startup, before the JUnit file exists. It sends aggregate progress heartbeats every 15 seconds,
then switches to **Uploading** during final publication. The run list and execution page refresh
automatically; a missing heartbeat for two minutes displays **Interrupted**. Retry attempts count
once per test identity. No individual test names, logs or evidence are sent by the presence API.

The initial ID is retained by final Full/Summary-only publication or later ZIP recovery. Startup
uses a five-second timeout with one idempotent retry; heartbeat failures only warn. Servers without
the capability keep the existing final-only flow, and `--list` does not create a run. Existing
installations need to install this updated reporter build to enable early visibility.

The TraceOptix reporter reads the JUnit file in Playwright's `onExit` hook, after every reporter
has finished `onEnd`. If another reporter enriches the JUnit file, it may remain after the built-in
JUnit reporter; TraceOptix receives the final version. Full-detail publication also starts there so
the reporter can declare the final JUnit byte size before TraceOptix issues its upload URL.

### Server-selected Summary-only mode

At the start of each execution, the reporter asks TraceOptix for the configured project's
publish mode. In **Full details**, the JUnit, priorities, steps and evidence flow is unchanged.
In **Summary-only**, it sends one content-free aggregate containing run/CI metadata and final
passed, failed, skipped, errored, blocked and flaky counts. It does not create an upload, send JUnit,
declare testcase priorities, capture steps/evidence or build a portable ZIP.

An administrator selects this policy in project settings; there is deliberately no reporter or
environment override. Community plan revisions include 500 summary runs per period, Pro includes
5,000 and Enterprise uses its explicit custom allowance. Each accepted summary consumes one
summary-run unit and no detailed-result units. Test names, failure diagnosis, testcase history,
flake analysis and testcase-level gates are unavailable for that run.

If capability negotiation times out, is rejected, or comes from an incompatible older server, the
reporter warns and publishes nothing to TraceOptix. It never guesses Full details, because that
could send data the administrator chose not to retain. Playwright's own result and exit code remain
unchanged.

Set credentials in the environment, never in `playwright.config.ts`:

```bash
export TRACEOPTIX_URL='https://traceoptix.example.com'
export TRACEOPTIX_PROJECT='checkout-web' # optional when project is in reporter options
export TRACEOPTIX_TOKEN='td_...'
export TRACEOPTIX_ORG='acme'              # optional; enables the final browser URL
export TRACEOPTIX_RUN_NAME='checkout-e2e' # becomes checkout-e2e-20260924T104231456Z

npx playwright test
```

A complete copyable template is included as [`traceoptix.env.example`](traceoptix.env.example):

```bash
cp node_modules/@traceoptix/playwright/traceoptix.env.example .env.traceoptix.local
# Edit the ignored .env.traceoptix.local file, then load it before Playwright starts.
set -a
. ./.env.traceoptix.local
set +a
npx playwright test
```

`TRACEOPTIX_TOKEN`, `TRACEOPTIX_URL`, and the project key must all resolve before publishing
starts. If any value or the shared `junitFile` option is missing, the reporter makes no request
and prints an actionable configuration block showing the missing values, the required environment
variables, the paired Playwright reporter configuration, and a link back to this guide. This is
warning-only so a developer who intentionally runs without TraceOptix still gets the original
Playwright exit code.

Only the documented `TRACEOPTIX_*` environment variables and TraceOptix TypeScript exports are
supported.

Reporter options take precedence over their environment fallbacks. In particular, a `url` in
`playwright.config.ts` overrides `TRACEOPTIX_URL`. At startup the reporter prints the selected
publishing target and portable-bundle policy. If both URLs are present and differ, it warns with
the selected and ignored destinations before capability negotiation; it also warns when a loopback
destination is selected, because `localhost` inside CI refers to the build agent.

If capability negotiation fails, the reporter does not send details under an unknown server
policy. It switches to offline full-detail capture instead, retaining steps and evidence for the
portable ZIP. At the end it warns that publication did not complete and prints the absolute ZIP
path. If bundle creation is disabled or fails, the final warning states that explicitly and shows
the configured output directory when available.

The reporter can show that guidance only after it has been registered in `playwright.config.ts`.
If `@traceoptix/playwright` is absent from the reporter list, Playwright never loads it and no
package code can print a configuration message.

## Options

This example shows every reporter option. Supply only the fields your project needs:

```ts
[
  "@traceoptix/playwright",
  {
    // Required and shared with Playwright's built-in JUnit reporter.
    junitFile: "test-results/reports/junit-result.xml",

    // TraceOptix destination. The token is deliberately not a reporter option.
    url: "https://traceoptix.example.com",
    project: "checkout-web",
    organization: "acme",

    // Run metadata.
    name: "Checkout regression",
    namePattern: "{name}-{timestamp}",
    environment: "staging",
    branch: "main",
    commitSha: "abc123",
    pullRequest: 42,
    tags: {
      suite: "regression",
      team: "checkout",
    },

    // Explicit values override TRACEOPTIX_CI_* and detected CI metadata.
    ci: {
      provider: "azure",
      buildId: "9001",
      buildNumber: "84",
      jobName: "playwright-chromium",
      jobUrl: "https://ci.example/jobs/9001",
      pipelineName: "Nightly regression",
      pipelineUrl: "https://ci.example/pipelines/9001",
      actor: "release-bot",
      triggerEvent: "schedule",
    },

    priority: { fromTags: true },
    uploadConcurrency: 3,
    capabilityTimeoutMs: 5_000,
    bundle: {
      mode: "always",
      outputDir: "test-results/reports/traceoptix-bundles",
    },
  },
];
```

| Option                | Accepted value                                     | Environment fallback                         | Purpose                                                                                                    |
| --------------------- | -------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `junitFile`           | File path; required                                | —                                            | Path also used by Playwright's JUnit reporter; relative paths resolve from the Playwright config directory |
| `project`             | Project key                                        | `TRACEOPTIX_PROJECT`                         | TraceOptix destination project                                                                             |
| `url`                 | HTTP or HTTPS URL                                  | `TRACEOPTIX_URL`                             | TraceOptix origin                                                                                          |
| `organization`        | Organization slug                                  | `TRACEOPTIX_ORG`                             | Enables the final browser run URL                                                                          |
| `name`                | String                                             | `TRACEOPTIX_RUN_NAME`                        | Base run name                                                                                              |
| `namePattern`         | String containing `{name}` and/or `{timestamp}`    | `TRACEOPTIX_RUN_NAME_PATTERN`                | Run-name format; default `{name}-{timestamp}`                                                              |
| `environment`         | String                                             | `TRACEOPTIX_ENVIRONMENT`                     | Target environment                                                                                         |
| `branch`              | String                                             | `TRACEOPTIX_BRANCH`, then CI metadata        | Source branch                                                                                              |
| `commitSha`           | String                                             | `TRACEOPTIX_COMMIT_SHA`, then CI metadata    | Source revision                                                                                            |
| `pullRequest`         | Positive integer                                   | `TRACEOPTIX_PULL_REQUEST`, then CI metadata  | Pull-request number                                                                                        |
| `ci`                  | CI metadata object                                 | `TRACEOPTIX_CI_*`, then detected CI metadata | Build, job, pipeline, actor and trigger context                                                            |
| `tags`                | `Record<string, string>`                           | `TRACEOPTIX_RUN_TAGS`                        | Run tags; reporter-option values override matching environment entries                                     |
| `priority.fromTags`   | Boolean; default `true`                            | `TRACEOPTIX_PRIORITY_FROM_TAGS`              | Synchronizes exact `@p0`–`@p3` Playwright tags                                                             |
| `uploadConcurrency`   | Integer from 1 to 16; default 3                    | —                                            | Maximum simultaneous evidence uploads                                                                      |
| `capabilityTimeoutMs` | 500–30,000 milliseconds; default 5,000             | —                                            | Project capability lookup timeout                                                                          |
| `bundle.mode`         | `always`, `on-failure`, or `off`; default `always` | `TRACEOPTIX_BUNDLE_MODE`                     | Portable ZIP retention policy                                                                              |
| `bundle.outputDir`    | Directory path                                     | `TRACEOPTIX_BUNDLE_OUTPUT_DIR`               | ZIP destination; defaults to `traceoptix-bundles` beside `junitFile`                                       |

The `ci` object accepts `provider`, `buildId`, `buildNumber`, `jobName`, `jobUrl`, `pipelineName`,
`pipelineUrl`, `actor`, and `triggerEvent`. Valid providers are `github`, `gitlab`, `jenkins`,
`circleci`, `buildkite`, `azure`, `bitbucket`, `teamcity`, `local`, and `unknown`.

`token` is intentionally not an accepted reporter option. Provide the required secret as
`TRACEOPTIX_TOKEN` in the process environment or CI secret store so it cannot be committed in
`playwright.config.ts`.

GitHub Actions, GitLab CI, Azure Pipelines, Jenkins, CircleCI, Buildkite, Bitbucket Pipelines and
TeamCity metadata is detected without a vendor SDK. In GitHub Actions, the run link is appended to
the step summary when `GITHUB_STEP_SUMMARY` is available.

### Run tags

Set run tags from CI with a comma-separated `key=value` (or `key:value`) list:

```bash
export TRACEOPTIX_RUN_TAGS='suite=regression,team=checkout,release=train-84'
```

Use a JSON object when a value contains a comma or colon:

```bash
export TRACEOPTIX_RUN_TAGS='{"suite":"smoke,critical","target":"https://checkout.example.com"}'
```

The reporter merges these with its `tags` option. Reporter-option values win on matching keys.
TraceOptix then adds the reserved `playwright-version` and `test-count` run tags; configuration
cannot replace those values. Tags are included in Full details, Summary-only publications, and
portable bundles. A malformed environment entry is skipped with a warning rather than failing the
Playwright run.

Run tags are separate from Playwright testcase tags. The reporter intentionally consumes only its
reserved exact `@p0`–`@p3` testcase tags as priority declarations; it does not promote arbitrary
tags such as `@smoke` to the run.

The timestamp is UTC with millisecond precision, so a base name such as `checkout-e2e` becomes
`checkout-e2e-20260924T104231456Z`. Set `namePattern: '{name}'` only when an external build number
already makes the supplied name unique.

Detected CI values can be overridden in reporter options with `ci.provider`, `ci.buildId`,
`ci.buildNumber`, `ci.jobName`, `ci.jobUrl`, `ci.pipelineName`, `ci.pipelineUrl`, `ci.actor` and
`ci.triggerEvent`:

```ts
[
  "@traceoptix/playwright",
  {
    junitFile,
    name: "checkout-e2e",
    ci: {
      provider: "unknown",
      pipelineName: "Nightly regression",
      jobName: "playwright-chromium",
      jobUrl: process.env.CI_JOB_URL,
    },
  },
];
```

Custom CI systems can instead set the equivalent environment variables:

```bash
export TRACEOPTIX_CI_PROVIDER='unknown'
export TRACEOPTIX_CI_BUILD_ID='pipeline-9001'
export TRACEOPTIX_CI_BUILD_NUMBER='84'
export TRACEOPTIX_CI_PIPELINE_NAME='Nightly regression' # TRACEOPTIX_CI_BUILD_NAME is an alias
export TRACEOPTIX_CI_PIPELINE_URL='https://ci.example/pipelines/9001'
export TRACEOPTIX_CI_JOB_NAME='playwright-chromium'
export TRACEOPTIX_CI_JOB_URL='https://ci.example/jobs/12001'
export TRACEOPTIX_CI_ACTOR='release-bot'
export TRACEOPTIX_CI_TRIGGER_EVENT='schedule'
```

Precedence is reporter option, then `TRACEOPTIX_CI_*`, then provider auto-detection. Overrides are
merged one field at a time, so setting a friendlier job name does not discard an automatically
detected build URL.

When publishing credentials are valid but the explicit run name or useful CI identity, pipeline,
job and URL fields cannot be resolved, the reporter prints one actionable configuration advisory
and continues publishing with the available values. This has the same warning-only behavior as
the basic configuration check: missing observability metadata never changes Playwright's result.

## Test priorities

Add one exact `@p0`, `@p1`, `@p2` or `@p3` tag to a Playwright test or suite. Matching is
case-insensitive, and inherited suite tags are included by Playwright:

```ts
test("card payment", { tag: "@p0" }, async ({ page }) => {
  // ...
});
```

The reporter declares every selected test, including tests with no priority tag. That lets a later
run clear an older reporter-managed priority when its tag is removed. A non-null priority chosen in
the TraceOptix UI is an explicit manual override and is never replaced; clearing it allows the
next reporter run to restore the source tag. Conflicting tags such as `@p0` and `@p2` produce a
warning; the first tag in Playwright's resolved order wins and the others are ignored.

Prefer the `tag` metadata above instead of embedding `@p0` in the test title. Playwright exposes
both, but changing a title changes TraceOptix's testcase identity. Use
`priority: { fromTags: false }` or `TRACEOPTIX_PRIORITY_FROM_TAGS=false` to disable synchronization.
Ordinary JUnit uploads remain supported and do not declare priorities automatically.

## Evidence behavior

The reporter consumes `result.attachments` directly, so it does not infer testcase identity from
folder names. It stages each test's declarations and evidence on bounded local disk while tests run,
then publishes them after creating the run with the final JUnit byte size. It records Playwright's
zero-based retry number.

- PNG/JPEG/WebP/GIF attachments become screenshots; names containing `diff` become visual diffs.
- WebM and MP4 attachments become videos.
- `trace.zip` becomes a Playwright trace.
- HAR, HTML, JSON, NDJSON, text and Markdown attachments are stored with safe display types.
- Unknown files are stored as binary evidence.

Metadata API requests retry HTTP 429 responses up to three times and honor `Retry-After`
(seconds or an HTTP date). This includes step/evidence declarations and final completion,
so a large suite can span the server’s rate-limit windows. A requested wait above two minutes
fails back to the portable bundle instead of holding CI indefinitely. Other HTTP errors retain
their existing handling.

An evidence failure produces a warning and is reported by TraceOptix as missing evidence. A final JUnit
publication failure notifies the server through its optional `failureUrl`, making an unaccepted
upload Failed with a recovery message. Accepted results cannot be overwritten by this notification.
If notification is unavailable, the updated server expires abandoned Uploading sessions after
60 minutes without activity; the runtime worker checks each minute. Older servers retain their
existing behavior. Import the matching retained ZIP to recover the same run ID.

## Test steps

Every Playwright step is recorded automatically from `result.steps`: BDD and `test.step` entries,
assertions, hooks, fixtures, Playwright API calls and attachment steps. Nested steps retain their
hierarchy; timing, source location, annotations and step errors are preserved per retry. Evidence
created inside a step renders with that step in the result panel.

For Playwright-BDD generated scenarios, the reporter also reads the generated file's JSON
step plan. Declared steps that were never reached appear as **Skipped**, in scenario order,
after a failure or setup interruption. Background steps and expanded scenario-outline values
are preserved; retries have independent step statuses. These declarations are included in both
full-detail publication and portable ZIPs. The reporter does not execute the source file.

This is validated with playwright-bdd 8.4.1. Generated source must remain available through
reporter completion. Ordinary Playwright tests, missing source, or unsupported metadata fall
back to observed steps; the reporter cannot infer future dynamic `test.step()` calls. Summary-only
publication remains aggregate-only and does not read or transmit scenario plans.

The safety ceiling is 5,000 steps per testcase attempt. If a generated or pathological test
exceeds it, the reporter keeps the first 5,000, prints one warning and continues. This feature is
reporter-native: manually uploaded JUnit XML has no portable structured-step representation, so it
continues to ingest normally and simply shows no Test steps section.

## Portable run ZIP

Every execution produces one `<run-name>.traceoptix-run.zip` by default. The archive contains the
finished JUnit XML, run and CI metadata, tag-derived testcase priorities, every structured step,
retries, evidence files, and the exact testcase/attempt/step relationship for each file. Version
`0.2.0` and later write schema-version-2 metadata as `manifest.json`, including the number of tests selected
at `onBegin`. During import TraceOptix verifies that count with its canonical JUnit parser before
promoting the run. It contains no API token, cookie, presigned URL, or TraceOptix credential.

The default directory is `traceoptix-bundles` beside `junitFile`. Choose another location in the
reporter configuration when CI collects artifacts from a specific directory:

```ts
[
  "@traceoptix/playwright",
  {
    junitFile,
    bundle: {
      mode: "always",
      outputDir: "artifacts/traceoptix",
    },
  },
];
```

`always` is the default so a portable result exists whether live publishing succeeds or not.
`on-failure` keeps it only when run creation, step/evidence publication, JUnit upload, or completion
is incomplete. `off` disables ZIP creation; Full-detail live publication still uses a temporary
disk stage and removes it during `onExit`. The equivalent environment variables are
`TRACEOPTIX_BUNDLE_MODE` and `TRACEOPTIX_BUNDLE_OUTPUT_DIR`.

To publish later, open the target project's **Upload** page and select the ZIP by itself. Test
Center validates it in the background and restores the same results, priorities, steps, retries
and evidence as the live reporter. Re-importing the same bundle repairs or returns the original run instead of
appending duplicate evidence.

Bundles created by reporter `0.1.x` remain importable. They do not contain a declared testcase
count, so the importer cannot apply the new count check to them. Both legacy and current inline
manifests are bounded at 64 MiB and 10,000 evidence files. Current reporters write compact manifest
JSON; archive-size subscription allowances remain a separate server-side admission check.

## Sharding

Each Playwright process creates one TraceOptix run. To publish one combined run from multiple
shards, use Playwright blob reports plus `npx playwright merge-reports`, then run this reporter as
part of the merge configuration. Automatic cross-process shard merging is not part of `0.2.x`.
