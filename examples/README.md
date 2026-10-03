# Wikipedia Playwright examples

Two runnable projects demonstrate API and UI evidence using this checkout's TraceOptix plugin.
Each project has its own `package.json` with dependencies and scripts. They are repository
workspaces and use the local plugin build, including the API capture fixture; no published
package version is assumed. Install dependencies once from the repository root.

| Project | Test style | Passing cases | Deliberate failures |
| --- | --- | --- | --- |
| [Plain Playwright](plain/playwright.config.ts) | TypeScript with nested `test.step` | API site information; article heading/content | API expects HTTP 418; UI expects an incorrect heading |
| [Playwright BDD](bdd/playwright.config.ts) | Gherkin features and TypeScript steps | Same API and UI checks | Same incorrect status and heading |

Each full project run should produce **2 passes and 2 failures**, exiting with code **1**.
The failures are tagged `@intentional-failure`; they are real assertion failures, not `test.fail()`
or skipped tests. They demonstrate failed steps, cURL/JSON evidence, screenshots, videos and traces.
These expectations assume Wikipedia is reachable and its public page/API contract is unchanged.

## Install and run

From the repository root:

```bash
npm ci
npx playwright install chromium
npm run example:plain
npm run example:bdd
```

Run each command separately: the intentional failures make the first example return a nonzero
exit code. The BDD command generates `.features-gen` before running Playwright. Both commands
build the local reporter first. API tests do not launch a browser; only the UI project uses Chromium.
These examples only read public Wikipedia content and do not edit pages or authenticate.

You can also run commands inside either example directory after the root install:

```bash
cd examples/plain # or examples/bdd
npm test
npm run test:api
npm run test:ui
npm run list
npm run report
```

`npm test` builds the local plugin first; the BDD project also generates its tests. Test
arguments are supported, for example `npm test -- --grep-invert @intentional-failure`.
The root lockfile covers both workspaces. These are repository examples, so keep the root
plugin and shared `examples/config.ts` when running them in this checkout.
To publish using the saved example settings from either project directory, first run:

```bash
set -a
. ../.env.traceoptix.local
set +a
npm test
```

For a green run, exclude the intentional failures:

```bash
npm run example:plain -- --grep-invert @intentional-failure
npm run example:bdd -- --grep-invert @intentional-failure
```

Select a test type or run only the failures:

```bash
npm run example:plain -- --project api
npm run example:bdd -- --project chromium
npm run example:plain -- --grep @intentional-failure
npm run example:bdd -- --grep @intentional-failure
```

Offline configuration/type checks and discovery, without contacting Wikipedia or TraceOptix:

```bash
npm run examples:check
```

## Publish to TraceOptix

Set the same three publishing variables as any other reporter consumer:

```bash
export TRACEOPTIX_URL='https://your-traceoptix-server.com'
export TRACEOPTIX_TOKEN='td_your_token'
export TRACEOPTIX_PROJECT='your-project-key'
# Optional, to print the final browser link:
export TRACEOPTIX_ORG='your-organization-slug'

npm run example:plain
npm run example:bdd
```

CI variables are optional. The default run names are `wikipedia-plain` and `wikipedia-bdd`;
`TRACEOPTIX_RUN_NAME` supplies a shared base name with `Plain Playwright` or `BDD` appended so the
two executions are easy to distinguish. The `example` run tag also identifies the project.
`TRACEOPTIX_ENVIRONMENT` labels the execution environment. URL/project resolve from the environment.
If your settings are saved in the ignored `examples/.env.traceoptix.local`, load them from the
repository root before running:

```bash
set -a
. ./examples/.env.traceoptix.local
set +a
npm run example:plain
npm run example:bdd
```

Without publishing credentials,
the reporter explains the missing settings and keeps local evidence and a recovery ZIP.
Set valid credentials only when you want to publish these demo runs to that project.

## Inspect the evidence

Each project has independent output directories:

```text
examples/plain/                         examples/bdd/
  playwright-report/                     playwright-report/
  test-results/                          test-results/
    junit.xml                              junit.xml
    artifacts/                             artifacts/
    traceoptix-bundles/                     traceoptix-bundles/
```

Open the local HTML report:

```bash
npx playwright show-report examples/plain/playwright-report
npx playwright show-report examples/bdd/playwright-report
```

- API calls attach sanitized `api-N.json` and `api-N.curl.txt` on both passing and failing tests.
  In TraceOptix Full details, they are linked to the API step and testcase attempt. Expand the API
  step to see cURL directly; the text download remains available beside it. Long commands show a
  preview with a notice to download the complete command.
- All UI tests retain screenshots and videos as test-level evidence. Failing UI tests also
  retain traces. Both passing and failing tests record their executed step tree.
- Plain tests show ordinary `test.step`, Playwright API calls, assertions, hooks and fixtures.
- BDD scenarios show Given/When/Then steps. Steps after an intentional failure can be represented
  as skipped using the generated BDD plan; arbitrary unexecuted TypeScript cannot be inferred.
- Summary-only projects receive aggregate results, with no step or attachment uploads. Local
  Playwright files still follow the example's capture settings.

Generated reports, traces, bundles and BDD code are ignored by Git. The plugin never executes
generated cURL commands. Before replay, replace redacted credentials and any omitted body.
See [API capture behavior and limits](../README.md#api-evidence-and-ordinary-test-steps).

## Reuse in another project

Copy the desired `plain` or `bdd` directory along with `examples/config.ts`, preserving their
relative layout. Install a build of `@traceoptix/playwright` containing the API fixture,
`@playwright/test`, and for BDD `playwright-bdd`. See the repository's
[local packing instructions](../LOCAL_DEVELOPMENT.md) for using this unpublished checkout.
Replace the manifest's `file:../..` plugin dependency with your packed package path or a
published version containing these features, and remove the repository-specific `pretest`
build command. The shared config must also be able to resolve those dependencies (for example,
keep both directories in a workspace with dependencies installed at its root).
The BDD fixture uses `mergeTests` to retain both BDD fixtures and TraceOptix's request wrapper.

References: [MediaWiki site information API](https://www.mediawiki.org/wiki/API:Siteinfo),
[Playwright BDD fixtures](https://vitalets.github.io/playwright-bdd/#/writing-steps/playwright-style).
