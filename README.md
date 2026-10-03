# `@traceoptix/playwright`

Source development lives in the standalone `traceoptix-playwright` repository. Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, and `pnpm test` from this directory. See [local development](LOCAL_DEVELOPMENT.md) for packing and installation.

Runnable [Wikipedia examples](examples/README.md) cover plain Playwright and Playwright BDD,
with API/UI tests, cURL evidence, ordinary and BDD steps, and deliberate failures.
Each example has its own `package.json`; a root workspace install supplies both projects.

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

Run names and CI metadata are optional. Once the required publishing settings are valid, any
suggestions for adding run labels or CI links are printed as informational output, not warnings.
Missing CI metadata does not prevent publication, including when running locally.

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

A capability-negotiation failure always prints `Could not resolve the project publishing mode:
<server message>` first — the exact response, useful for grepping logs or filing a support
request. One of three anticipated HTTP statuses (401, 403, 404) also gets a plain-language block
appended, because the raw message alone is guesswork for whoever reads it — most sharply for 404,
where the server deliberately returns the identical "unknown project" whether a project key is
simply misspelled or genuinely belongs to a different organisation (confirming the latter would
let a token enumerate project keys outside its own org, so it does not distinguish the two). Any
other status prints only the original message, so no failure is ever silently hidden:

- **404** — `Could not publish to TraceOptix: project "<project>" was not found for this token's
  organisation.`, followed by a line naming both possible causes and a line telling you to check
  that `TRACEOPTIX_TOKEN` was minted for the organisation that owns the configured project, and
  that `project` (or `TRACEOPTIX_PROJECT`) is the project's key, not its display name.
- **403** — `Could not publish to TraceOptix: this token is not valid for project "<project>".`,
  followed by a line explaining the token is scoped to a different project and how to fix it.
- **401** — `Could not publish to TraceOptix: TRACEOPTIX_TOKEN is invalid, expired or revoked.`,
  followed by a line telling you to mint a replacement.

This is the single most common cause of "results were not published" with no other explanation:
a token minted for one project (or organisation) left configured against a `playwright.config.ts`
that points at a different one, usually after switching between a real project and a disposable
test project without re-minting the token to match.

The reporter can show that guidance only after it has been registered in `playwright.config.ts`.
If `@traceoptix/playwright` is absent from the reporter list, Playwright never loads it and no
package code can print a configuration message.

## API evidence and ordinary test steps

BDD is not required for step reporting. The reporter collects executed `test.step` calls,
Playwright API/browser operations, assertions, fixtures and hooks, with hierarchy, status,
timing, source location, errors and linked attachments. Plain JavaScript needs an explicit
`test.step` to appear as a named operation. Unexecuted ordinary JavaScript steps cannot be
inferred; planned skipped BDD steps remain a separate feature.

Automatic screenshots and videos captured during Playwright teardown are published as
test-level evidence. Media explicitly attached inside a test step stays linked to that step.

For API request/response evidence and cURL templates, opt in with the supplied test fixture.
Keep the JUnit and TraceOptix reporters configured as above:

```ts
import { test, expect } from "@traceoptix/playwright/test";

test.use({
  baseURL: "https://api.example.com",
  traceoptixApi: {
    redactFields: ["email", "customerId"],
    maxBodyBytes: 64 * 1024,
    maxRequests: 100,
  },
});

test("creates an order", async ({ request }) => {
  await test.step("Create order", async () => {
    const response = await request.post("/orders", {
      data: { product: "book", quantity: 1 },
    });
    expect(response.status()).toBe(201);
  });
});
```

The `request` fixture captures `get`, `post`, `put`, `patch`, `delete`, `head` and `fetch`.
Each captured call gets an `API METHOD` step with `api-N.json` and `api-N.curl.txt` attachments.
TraceOptix also displays the sanitized cURL directly in that step's expanded details while keeping
the text attachment downloadable. Inline commands are limited to 2,000 characters; longer commands
show a truncation notice pointing to the complete text download. This metadata is included in both
live publication and portable bundles. Earlier uploads are unchanged; rerun to populate inline cURL.
JSON includes the supplied request method, resolved URL, headers, sanitized JSON/form body,
response status, headers and JSON body, start time, and duration. Original responses and thrown
errors are preserved; attachment failures do not fail the test. HTTP error statuses follow
Playwright's normal `failOnStatusCode` behavior. Passing and failing attempts retain evidence,
with retries linked separately. Playwright 1.50 falls back to test-level attachments; newer
versions attach directly to the API step.

This wraps the API `request` fixture, not browser network traffic, global `fetch`, Axios, or
contexts created elsewhere. For existing custom fixtures or `page.request`/`context.request`,
wrap the context explicitly and call through the returned object:

```ts
import { captureApiRequests } from "@traceoptix/playwright";

const api = captureApiRequests(customContext, testInfo, {
  baseURL: "https://api.example.com",
  redactFields: ["email"],
});
await api.get("/orders");
```

The helper does not dispose or modify the supplied context. Its attachments are test-level unless
an optional fourth `ApiStepRunner` argument supplies a step attachment sink. Supply the context's
`baseURL` and `extraHTTPHeaders` for evidence; hidden context defaults cannot be inspected.

Redaction happens before these new attachments are saved. Authorization, cookies, passwords,
secrets, tokens, API keys, credentials, signatures and session fields are redacted by field name,
case-insensitively, including nested JSON and query/form fields. `redactFields` adds application
fields. This is field-based redaction, not detection of secrets inside arbitrary values. Existing
Playwright traces, JUnit, logs and user attachments retain their own capture behavior.

Bodies over the limit are omitted rather than partially exposed. Defaults are 64 KiB per direction
and 100 captured exchanges per wrapper/test, with hard caps of 1 MiB and 1,000 exchanges.
Unstructured text, binary and multipart bodies are omitted; streams/files are never read for
evidence. Playwright already buffers API responses; inspecting JSON may read that buffer when its
size is not advertised, but only bodies within the limit are retained. Set
`traceoptixApi: { enabled: false }` to disable fixture capture.

cURL attachments are POSIX-shell-quoted templates, not exact wire replays. Automatic cookie-jar
credentials, redirects and transport-added headers are not reconstructed. Replace redacted
credentials and supply any omitted body before replay. The plugin never executes the cURL.
Full details publication uploads this evidence through the existing attachment pipeline.
Summary-only publication sends no attachments or steps; the opted-in fixture still creates local
Playwright attachments, just as Playwright can still write a user-configured local trace.

## Options

Every supported reporter option, commented in place, as a `playwright.config.ts` you can copy and
trim. Only `junitFile` is required; everything else falls back to an environment variable, a
detected value, or the documented default when omitted.

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [
    ["line"],
    ["junit", { outputFile: "test-results/reports/junit-result.xml", includeRetries: true }],
    [
      "@traceoptix/playwright",
      {
        // Required. Shared with Playwright's built-in JUnit reporter above — both must point at
        // the same file. Relative paths resolve from the Playwright config directory.
        junitFile: "test-results/reports/junit-result.xml",

        // TraceOptix origin. Falls back to TRACEOPTIX_URL. A mismatch between this option and
        // TRACEOPTIX_URL prints a startup warning naming both and stating which one wins (this
        // one). A loopback host (localhost/127.0.0.1) prints a second warning, since inside CI
        // "localhost" means the build agent, not your TraceOptix server.
        url: "https://traceoptix.example.com",

        // TraceOptix project key (not its display name). Falls back to TRACEOPTIX_PROJECT. Must
        // belong to the same organisation TRACEOPTIX_TOKEN was minted for — a token valid for a
        // different project or organisation fails capability negotiation with an actionable
        // warning (see "Configure" above) rather than silently publishing nowhere.
        project: "checkout-web",

        // Organization slug. Optional — falls back to TRACEOPTIX_ORG. Used only to print the
        // final browser run URL; never sent to the server and never affects authorization.
        organization: "acme",

        // Base run name. Falls back to TRACEOPTIX_RUN_NAME, then a name derived from detected CI
        // build metadata. The final run name also has a timestamp appended; see namePattern.
        name: "Checkout regression",

        // Run-name format. Falls back to TRACEOPTIX_RUN_NAME_PATTERN. Supports {name} and
        // {timestamp}; default is "{name}-{timestamp}", producing e.g.
        // "checkout-regression-20260924T104231456Z". Set to "{name}" only when an external build
        // number already makes the supplied name unique on its own.
        namePattern: "{name}-{timestamp}",

        // Target environment label (e.g. staging, production). Falls back to
        // TRACEOPTIX_ENVIRONMENT. Optional; omitted entirely if neither is set.
        environment: "staging",

        // Source branch. Falls back to TRACEOPTIX_BRANCH, then detected CI metadata.
        branch: "main",

        // Source commit SHA. Falls back to TRACEOPTIX_COMMIT_SHA, then detected CI metadata.
        commitSha: "abc123",

        // Pull/merge request number. Falls back to TRACEOPTIX_PULL_REQUEST, then detected CI
        // metadata. Must be a positive integer.
        pullRequest: 42,

        // Run tags. Falls back to TRACEOPTIX_RUN_TAGS (comma-separated key=value pairs, or a JSON
        // object — see "Run tags" below). Reporter-option values here win over a matching
        // environment entry on the same key. The reporter always adds its own reserved
        // "playwright-version" and "test-count" tags; neither can be overridden here.
        tags: {
          suite: "regression",
          team: "checkout",
        },

        // CI metadata. Every field here overrides both TRACEOPTIX_CI_* and whatever the reporter
        // auto-detects from GitHub Actions, GitLab CI, Azure Pipelines, Jenkins, CircleCI,
        // Buildkite, Bitbucket Pipelines or TeamCity. Omit the whole object to use detection as-is.
        ci: {
          // One of: github, gitlab, jenkins, circleci, buildkite, azure, bitbucket, teamcity,
          // local, unknown.
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

        // Synchronize exact @p0–@p3 Playwright tags as testcase priority. Falls back to
        // TRACEOPTIX_PRIORITY_FROM_TAGS. Defaults to true; set false to leave priority entirely
        // under manual TraceOptix control.
        priority: { fromTags: true },

        // Detect ticket/issue tags (e.g. @jira:CHK-482) and link them to the matching testcase.
        // Falls back to TRACEOPTIX_ISSUES_FROM_TAGS. Defaults to true; links are additive and
        // never remove an existing link. Summary-only runs do not retain individual test
        // identities, so this has no effect when the server selects that mode.
        issues: { fromTags: true },

        // Maximum simultaneous evidence (screenshot/video/trace) uploads. No environment
        // fallback. Integer from 1 to 16; defaults to 3.
        uploadConcurrency: 3,

        // Timeout, in milliseconds, for the startup project-capability lookup. No environment
        // fallback. 500–30,000; defaults to 5,000. A timeout is treated the same as any other
        // capability-negotiation failure: offline full-detail capture, no live publish.
        capabilityTimeoutMs: 5_000,

        // Portable run ZIP. Falls back to TRACEOPTIX_BUNDLE_MODE / TRACEOPTIX_BUNDLE_OUTPUT_DIR.
        bundle: {
          // "always" (default): write one every run. "on-failure": only when publishing did not
          // fully succeed, including a capability-negotiation failure. "off": never write one —
          // a failed publish then has no recovery path other than re-running the suite.
          mode: "always",
          // Defaults to "traceoptix-bundles" beside junitFile.
          outputDir: "test-results/reports/traceoptix-bundles",
        },

        // Not shown above: TRACEOPTIX_TOKEN. There is deliberately no `token` reporter option —
        // provide the secret only via the environment or a CI secret store, never in this file.
      },
    ],
  ],
});
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
| `issues.fromTags`     | Boolean; default `true`                            | `TRACEOPTIX_ISSUES_FROM_TAGS`                | Detects ticket/issue tags and links them to the matching testcase                                          |
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

### Link tests to tickets from Playwright tags

```ts
test('payment succeeds', {
  tag: ['@jira:PAY-123', '@ticket:https://github.com/acme/checkout/issues/42'],
}, async ({ page }) => {
  // ...
});
```

Use `@issue:KEY` or `@ticket:KEY` with the effective TraceOptix project tracker. Provider-specific
forms are `@jira:PAY-123`, `@azure:88`, `@azureboards:88`, `@azureboard:88`, `@ado:88`,
`@github:42` and `@gitlab:42`; `=` may replace `:`. Full HTTP(S) URLs work without a configured
default through `@ticket:https://…` or `@issue:https://…`. Prefixes are case-insensitive.
Provider-specific keys require the same provider in the effective tracker configuration.
Bare tags such as `@PAY-123` are not interpreted as tickets.

Organization defaults and project overrides are configured in TraceOptix under **Tickets & issues**.
Inherited `test.describe` tags are supported through Playwright's resolved tags. Each canonical
JUnit identity can declare up to 20 distinct references; retries and Playwright projects are deduplicated.
Nested describe titles are included in the identity, so same-named tests in different groups stay separate.

Links are added after JUnit ingestion identifies the tests. Existing labels and manually added links
are preserved. Removing a tag does not unlink a ticket. Ambiguous or missing test identities are left
unlinked. Resolved URLs are captured when declarations reach TraceOptix; later tracker changes do not
rewrite accepted links. Invalid references or mismatched providers produce warnings without preventing
result publishing. Projection summaries record rejected/unmatched counts; successful additions are audited.

Detection is on by default. Set `issues: { fromTags: false }` in the reporter options or
`TRACEOPTIX_ISSUES_FROM_TAGS=false` to disable it (the explicit option wins). Summary-only runs do not
retain test identities and cannot apply ticket tags. Report ZIPs retain these declarations for later
import; old ZIPs without them still work. Requires a TraceOptix server with migration 0060 and the
`testIssuesUrl` upload capability. Older servers produce an explicit unsupported-feature warning.
No external tracker credentials or external issue creation are involved.
