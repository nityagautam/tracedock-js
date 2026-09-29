# Local package development

Use this workflow to build `@traceoptix/playwright`, create an npm-compatible tarball, and install
that tarball into any local Playwright project. It exercises the same package contents a registry
installation receives without publishing a version.

## Quick start: build, pack, install

From the traceoptix-playwright repository root, build and test the reporter, then pack it directly into the
Playwright project's vendor directory:

```bash
pnpm build
pnpm test
mkdir -p /absolute/path/to/playwright-project/scripts/vendor
npm pack . --pack-destination /absolute/path/to/playwright-project/scripts/vendor
```

The final line printed by npm is the archive filename. For the current package version it is
`traceoptix-playwright-1.0.1.tgz`.

From the Playwright project root, install that exact file:

```bash
npm install --save-dev ./scripts/vendor/traceoptix-playwright-1.0.1.tgz
```

If a workflow intentionally updates only `package.json` and `package-lock.json`, use:

```bash
npm install --save-dev --package-lock-only --ignore-scripts \
  @traceoptix/playwright@file:scripts/vendor/traceoptix-playwright-1.0.1.tgz
```

`--package-lock-only` does not install anything into `node_modules`; omit it for a usable local
installation. The version in the install command must exactly match the `.tgz` filename emitted by
`npm pack`. For example, a command naming `1.0.0` cannot install the current `1.0.1` archive.

Prerequisites:

- Node.js 20 or newer.
- Corepack and pnpm for the traceoptix-playwright repository.
- An existing Playwright project using npm, pnpm, or Yarn.

### Installation troubleshooting

This repository uses pnpm and commits `pnpm-lock.yaml`. Use `pnpm install --frozen-lockfile`
for source development. The npm installation commands below apply to the consuming Playwright project.

Running `npm install` over a pnpm-created `node_modules` can produce an `ERESOLVE` error mentioning
`typescript` and `typescript-eslint`, even though this project does not depend on `typescript-eslint`.
In that case, npm is traversing the linked TypeScript package's development dependencies.
Continue with pnpm, or move `node_modules` aside before installing with npm. When switching package
managers in either direction, start with a clean `node_modules`; do not use `--force` or
`--legacy-peer-deps` to work around this error.

## macOS and Linux (zsh/bash)

Set the repository, target project and tarball destination paths. `npm pack` requires the
destination directory to exist.

```bash
TRACEOPTIX_REPO="/absolute/path/to/traceoptix-playwright"
PLAYWRIGHT_PROJECT="/absolute/path/to/playwright-project"
PACK_DESTINATION="/absolute/path/to/playwright-project/scripts/vendor"
```

Install the reporter dependencies, then build and test the reporter:

```bash
cd "$TRACEOPTIX_REPO"
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Create the destination and pack from the traceoptix-playwright repository root. The package's `prepack` script
rebuilds `dist` as a final stale-output guard, even if the explicit build above was skipped.

```bash
mkdir -p "$PACK_DESTINATION"
REPORTER_TARBALL="$PACK_DESTINATION/$(npm pack . --pack-destination "$PACK_DESTINATION" | tail -n 1)"
tar -tzf "$REPORTER_TARBALL"
```

The pack command may also be written across two lines, but the backslash must be the final
character on its line—no trailing spaces:

```bash
npm pack . \
  --pack-destination "$PACK_DESTINATION"
```

If zsh reports `command not found: --pack-destination`, the continuation was malformed and the
option started a second shell command. An additional `undefined-0.1.0.tgz` indicates that npm also
interpreted the escaped whitespace as another package argument. Use the single-line command above
or remove every character after the backslash.

Install it in the Playwright project. Run exactly one install command, matching that project's
package manager:

```bash
cd "$PLAYWRIGHT_PROJECT"

npm install --save-dev "$REPORTER_TARBALL"
# pnpm add --save-dev "$REPORTER_TARBALL"
# yarn add --dev "$REPORTER_TARBALL"
```

Verify that Node can load the package and that Playwright can read the project configuration:

```bash
node -e "import('@traceoptix/playwright').then(() => console.log('@traceoptix/playwright loaded'))"
npx playwright test --list
```

## Windows (PowerShell)

Set the repository, target project and tarball destination paths.

```powershell
$TraceOptixRepo = "C:\path\to\traceoptix-playwright"
$PlaywrightProject = "C:\path\to\playwright-project"
$PackDestination = "C:\path\to\playwright-project\scripts\vendor"
```

Install the reporter dependencies, then build and test the reporter:

```powershell
Set-Location $TraceOptixRepo
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Create the destination, pack from the traceoptix-playwright repository root, and optionally inspect the archive
with the `tar` included in current Windows installations. The `prepack` script rebuilds `dist` as a
final stale-output guard.

```powershell
New-Item -ItemType Directory -Force -Path $PackDestination | Out-Null
$TarballName = npm pack . --pack-destination $PackDestination | Select-Object -Last 1
$ReporterTarball = Join-Path $PackDestination $TarballName
tar -tzf $ReporterTarball
```

Install it in the Playwright project. Run exactly one install command, matching that project's
package manager:

```powershell
Set-Location $PlaywrightProject

npm install --save-dev $ReporterTarball
# pnpm add --save-dev $ReporterTarball
# yarn add --dev $ReporterTarball
```

Verify the installation:

```powershell
node -e "import('@traceoptix/playwright').then(() => console.log('@traceoptix/playwright loaded'))"
npx playwright test --list
```

## Rebuild after changing the reporter

The package version does not change during local development, so force the target package manager
to refresh the tarball after rebuilding it.

macOS/Linux:

```bash
cd "$TRACEOPTIX_REPO"
pnpm build
pnpm test
REPORTER_TARBALL="$PACK_DESTINATION/$(npm pack . --pack-destination "$PACK_DESTINATION" | tail -n 1)"

cd "$PLAYWRIGHT_PROJECT"
npm install --save-dev --force "$REPORTER_TARBALL"
# pnpm add --save-dev --force "$REPORTER_TARBALL"
# yarn add --dev --force "$REPORTER_TARBALL"
```

Windows PowerShell:

```powershell
Set-Location $TraceOptixRepo
pnpm build
pnpm test
$TarballName = npm pack . --pack-destination $PackDestination | Select-Object -Last 1
$ReporterTarball = Join-Path $PackDestination $TarballName

Set-Location $PlaywrightProject
npm install --save-dev --force $ReporterTarball
# pnpm add --save-dev --force $ReporterTarball
# yarn add --dev --force $ReporterTarball
```

After reinstalling, rerun the verification commands and then the target project's normal
Playwright test command.

## Configure the installed reporter

Installation alone does not register the reporter. Add `@traceoptix/playwright` beside
Playwright's JUnit reporter in `playwright.config.ts`, then provide `TRACEOPTIX_URL`,
`TRACEOPTIX_TOKEN`, and the project key. The complete helper and helper-free configurations are in
the [package guide](README.md).
