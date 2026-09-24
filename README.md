# `@testcenter/playwright`

Publish Playwright JUnit results, the complete test-step tree, screenshots, videos, traces, HAR
files and logs to Test Center. Evidence is linked to the testcase, retry and originating step that
produced it. Publishing is warning-only: a Test Center or object-storage outage never changes
Playwright's exit code.

## Install

```bash
npm install --save-dev @testcenter/playwright
```

## Configure

Keep Playwright's built-in JUnit reporter and give both reporters the same file:

```ts
import { defineConfig } from "@playwright/test";

const junitFile = "test-results/junit.xml";

export default defineConfig({
  reporter: [
    ["line"],
    ["junit", { outputFile: junitFile, includeRetries: true }],
    [
      "@testcenter/playwright",
      {
        junitFile,
        project: "checkout-web",
        name: "checkout-e2e",
        // This is the default; shown here to make the resulting run name explicit.
        namePattern: "{name}-{timestamp}",
        // Optional. Defaults to test-results/testcenter-bundles beside junit.xml.
        bundle: { outputDir: "test-results/testcenter-bundles" },
      },
    ],
  ],
  outputDir: "test-results/artifacts",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
```

The Test Center reporter reads the JUnit file in Playwright's `onExit` hook, after every reporter
has finished `onEnd`. If another reporter enriches the JUnit file, it may remain after the built-in
JUnit reporter; Test Center receives the final version.

Set credentials in the environment, never in `playwright.config.ts`:

```bash
export TESTCENTER_URL='https://testcenter.example.com'
export TESTCENTER_PROJECT='checkout-web' # optional when project is in reporter options
export TESTCENTER_TOKEN='tc_...'
export TESTCENTER_ORG='acme'              # optional; enables the final browser URL
export TESTCENTER_RUN_NAME='checkout-e2e' # becomes checkout-e2e-20260924T104231456Z

npx playwright test
```

A complete copyable template is included as [`testcenter.env.example`](./testcenter.env.example):

```bash
cp node_modules/@testcenter/playwright/testcenter.env.example .env.testcenter.local
# Edit the ignored .env.testcenter.local file, then load it before Playwright starts.
set -a
. ./.env.testcenter.local
set +a
npx playwright test
```

`TESTCENTER_TOKEN`, `TESTCENTER_URL`, and the project key must all resolve before publishing
starts. If any value or the shared `junitFile` option is missing, the reporter makes no request
and prints an actionable configuration block showing the missing values, the required environment
variables, the paired Playwright reporter configuration, and a link back to this guide. This is
warning-only so a developer who intentionally runs without Test Center still gets the original
Playwright exit code.

The reporter can show that guidance only after it has been registered in `playwright.config.ts`.
If `@testcenter/playwright` is absent from the reporter list, Playwright never loads it and no
package code can print a configuration message.

## Options

| Option              | Environment fallback                         | Purpose                                                                                                             |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `junitFile`         | —                                            | Required path also used by Playwright's JUnit reporter; relative paths resolve from the Playwright config directory |
| `project`           | `TESTCENTER_PROJECT`                         | Test Center project key                                                                                             |
| `url`               | `TESTCENTER_URL`                             | Test Center origin                                                                                                  |
| `organization`      | `TESTCENTER_ORG`                             | Organization slug used to print the run URL                                                                         |
| `name`              | `TESTCENTER_RUN_NAME`                        | Base run name                                                                                                       |
| `namePattern`       | `TESTCENTER_RUN_NAME_PATTERN`                | Run-name pattern supporting `{name}` and `{timestamp}`; default `{name}-{timestamp}`                                |
| `environment`       | `TESTCENTER_ENVIRONMENT`                     | Target environment                                                                                                  |
| `branch`            | `TESTCENTER_BRANCH`, then CI metadata        | Source branch                                                                                                       |
| `commitSha`         | `TESTCENTER_COMMIT_SHA`, then CI metadata    | Source revision                                                                                                     |
| `pullRequest`       | `TESTCENTER_PULL_REQUEST`, then CI metadata  | Pull-request number                                                                                                 |
| `ci`                | `TESTCENTER_CI_*`, then detected CI metadata | Build, job and pipeline context                                                                                     |
| `tags`              | —                                            | Run tags                                                                                                            |
| `uploadConcurrency` | —                                            | Concurrent evidence uploads, from 1 to 16; default 3                                                                |
| `bundle.mode`       | `TESTCENTER_BUNDLE_MODE`                     | Portable ZIP retention: `always` (default), `on-failure`, or `off`                                                  |
| `bundle.outputDir`  | `TESTCENTER_BUNDLE_OUTPUT_DIR`               | ZIP destination; defaults to `testcenter-bundles` beside the configured JUnit file                                 |

GitHub Actions, GitLab CI, Azure Pipelines, Jenkins, CircleCI, Buildkite, Bitbucket Pipelines and
TeamCity metadata is detected without a vendor SDK. In GitHub Actions, the run link is appended to
the step summary when `GITHUB_STEP_SUMMARY` is available.

The timestamp is UTC with millisecond precision, so a base name such as `checkout-e2e` becomes
`checkout-e2e-20260924T104231456Z`. Set `namePattern: '{name}'` only when an external build number
already makes the supplied name unique.

Detected CI values can be overridden in reporter options with `ci.provider`, `ci.buildId`,
`ci.buildNumber`, `ci.jobName`, `ci.jobUrl`, `ci.pipelineName`, `ci.pipelineUrl`, `ci.actor` and
`ci.triggerEvent`:

```ts
[
  "@testcenter/playwright",
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
export TESTCENTER_CI_PROVIDER='unknown'
export TESTCENTER_CI_BUILD_ID='pipeline-9001'
export TESTCENTER_CI_BUILD_NUMBER='84'
export TESTCENTER_CI_PIPELINE_NAME='Nightly regression' # TESTCENTER_CI_BUILD_NAME is an alias
export TESTCENTER_CI_PIPELINE_URL='https://ci.example/pipelines/9001'
export TESTCENTER_CI_JOB_NAME='playwright-chromium'
export TESTCENTER_CI_JOB_URL='https://ci.example/jobs/12001'
export TESTCENTER_CI_ACTOR='release-bot'
export TESTCENTER_CI_TRIGGER_EVENT='schedule'
```

Precedence is reporter option, then `TESTCENTER_CI_*`, then provider auto-detection. Overrides are
merged one field at a time, so setting a friendlier job name does not discard an automatically
detected build URL.

When publishing credentials are valid but the explicit run name or useful CI identity, pipeline,
job and URL fields cannot be resolved, the reporter prints one actionable configuration advisory
and continues publishing with the available values. This has the same warning-only behavior as
the basic configuration check: missing observability metadata never changes Playwright's result.

## Evidence behavior

The reporter consumes `result.attachments` directly, so it does not infer testcase identity from
folder names. It batches the declarations for one test, uploads evidence while later tests are
still running, and records Playwright's zero-based retry number.

- PNG/JPEG/WebP/GIF attachments become screenshots; names containing `diff` become visual diffs.
- WebM and MP4 attachments become videos.
- `trace.zip` becomes a Playwright trace.
- HAR, HTML, JSON, NDJSON, text and Markdown attachments are stored with safe display types.
- Unknown files are stored as binary evidence.

An evidence failure produces a warning and is reported by Test Center as missing evidence. A JUnit
failure leaves the run pending rather than completing it with partial results.

## Test steps

Every Playwright step is recorded automatically from `result.steps`: BDD and `test.step` entries,
assertions, hooks, fixtures, Playwright API calls and attachment steps. Nested steps retain their
hierarchy; timing, source location, annotations and step errors are preserved per retry. Evidence
created inside a step renders with that step in the result panel.

The safety ceiling is 5,000 steps per testcase attempt. If a generated or pathological test
exceeds it, the reporter keeps the first 5,000, prints one warning and continues. This feature is
reporter-native: manually uploaded JUnit XML has no portable structured-step representation, so it
continues to ingest normally and simply shows no Test steps section.

## Portable run ZIP

Every execution produces one `<run-name>.testcenter-run.zip` by default. The archive contains the
finished JUnit XML, run and CI metadata, every structured step, retries, evidence files, and the
exact testcase/attempt/step relationship for each file. It contains no API token, cookie,
presigned URL, or Test Center credential.

The default directory is `testcenter-bundles` beside `junitFile`. Choose another location in the
reporter configuration when CI collects artifacts from a specific directory:

```ts
[
  "@testcenter/playwright",
  {
    junitFile,
    bundle: {
      mode: "always",
      outputDir: "artifacts/testcenter",
    },
  },
];
```

`always` is the default so a portable result exists whether live publishing succeeds or not.
`on-failure` keeps it only when run creation, step/evidence publication, JUnit upload, or completion
is incomplete. `off` disables local staging and ZIP creation. The equivalent environment variables
are `TESTCENTER_BUNDLE_MODE` and `TESTCENTER_BUNDLE_OUTPUT_DIR`.

To publish later, open the target project's **Upload** page and select the ZIP by itself. Test
Center validates it in the background and restores the same results, steps, retries and evidence
as the live reporter. Re-importing the same bundle repairs or returns the original run instead of
appending duplicate evidence.

## Sharding

Each Playwright process creates one Test Center run. To publish one combined run from multiple
shards, use Playwright blob reports plus `npx playwright merge-reports`, then run this reporter as
part of the merge configuration. Automatic cross-process shard merging is not part of `0.1.x`.
