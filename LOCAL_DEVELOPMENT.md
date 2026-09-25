# Local package development

Use this workflow to build `@testcenter/playwright`, create an npm-compatible tarball, and install
that tarball into any local Playwright project. It exercises the same package contents a registry
installation receives without publishing a version.

Prerequisites:

- Node.js 20 or newer.
- Corepack and pnpm for the Test Center repository.
- An existing Playwright project using npm, pnpm, or Yarn.

## macOS and Linux (zsh/bash)

Set the two project paths. The tarball may remain in the operating system's temporary directory.

```bash
TESTCENTER_REPO="/absolute/path/to/TestCenter"
PLAYWRIGHT_PROJECT="/absolute/path/to/playwright-project"
REPORTER_TARBALL="${TMPDIR:-/tmp}/testcenter-playwright-local.tgz"
```

Install the Test Center workspace dependencies, then build and test the reporter:

```bash
cd "$TESTCENTER_REPO"
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @testcenter/playwright build
pnpm --filter @testcenter/playwright test
```

Pack the reporter and optionally inspect the archive:

```bash
pnpm --filter @testcenter/playwright pack --out "$REPORTER_TARBALL"
tar -tzf "$REPORTER_TARBALL"
```

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
node -e "import('@testcenter/playwright').then(() => console.log('@testcenter/playwright loaded'))"
npx playwright test --list
```

## Windows (PowerShell)

Set the two project paths. `Join-Path` keeps the temporary tarball path valid regardless of the
Windows user profile location.

```powershell
$TestCenterRepo = "C:\path\to\TestCenter"
$PlaywrightProject = "C:\path\to\playwright-project"
$ReporterTarball = Join-Path $env:TEMP "testcenter-playwright-local.tgz"
```

Install the Test Center workspace dependencies, then build and test the reporter:

```powershell
Set-Location $TestCenterRepo
corepack enable
pnpm install --frozen-lockfile
pnpm --filter '@testcenter/playwright' build
pnpm --filter '@testcenter/playwright' test
```

Pack the reporter and optionally inspect the archive with the `tar` included in current Windows
installations:

```powershell
pnpm --filter '@testcenter/playwright' pack --out $ReporterTarball
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
node -e "import('@testcenter/playwright').then(() => console.log('@testcenter/playwright loaded'))"
npx playwright test --list
```

## Rebuild after changing the reporter

The package version does not change during local development, so force the target package manager
to refresh the tarball after rebuilding it.

macOS/Linux:

```bash
cd "$TESTCENTER_REPO"
pnpm --filter @testcenter/playwright build
pnpm --filter @testcenter/playwright test
pnpm --filter @testcenter/playwright pack --out "$REPORTER_TARBALL"

cd "$PLAYWRIGHT_PROJECT"
npm install --save-dev --force "$REPORTER_TARBALL"
# pnpm add --save-dev --force "$REPORTER_TARBALL"
# yarn add --dev --force "$REPORTER_TARBALL"
```

Windows PowerShell:

```powershell
Set-Location $TestCenterRepo
pnpm --filter '@testcenter/playwright' build
pnpm --filter '@testcenter/playwright' test
pnpm --filter '@testcenter/playwright' pack --out $ReporterTarball

Set-Location $PlaywrightProject
npm install --save-dev --force $ReporterTarball
# pnpm add --save-dev --force $ReporterTarball
# yarn add --dev --force $ReporterTarball
```

After reinstalling, rerun the verification commands and then the target project's normal
Playwright test command.

## Configure the installed reporter

Installation alone does not register the reporter. Add `@testcenter/playwright` beside
Playwright's JUnit reporter in `playwright.config.ts`, then provide `TESTCENTER_URL`,
`TESTCENTER_TOKEN`, and the project key. The complete helper and helper-free configurations are in
the [package guide](README.md).
