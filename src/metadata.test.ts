import { describe, expect, it } from "vitest";
import { detectMetadata, resolveCiContext } from "./metadata.js";

describe("CI metadata detection", () => {
  it("maps GitHub Actions metadata", () => {
    expect(
      detectMetadata({
        GITHUB_ACTIONS: "true",
        GITHUB_SERVER_URL: "https://github.example",
        GITHUB_REPOSITORY: "acme/checkout",
        GITHUB_RUN_ID: "9001",
        GITHUB_RUN_NUMBER: "42",
        GITHUB_WORKFLOW: "E2E",
        GITHUB_JOB: "playwright",
        GITHUB_HEAD_REF: "feature/card",
        GITHUB_SHA: "deadbeef",
        GITHUB_REF: "refs/pull/27/merge",
      }),
    ).toEqual({
      branch: "feature/card",
      commitSha: "deadbeef",
      pullRequest: 27,
      ci: {
        provider: "github",
        buildId: "9001",
        buildNumber: "42",
        jobName: "playwright",
        jobUrl: "https://github.example/acme/checkout/actions/runs/9001",
        pipelineName: "E2E",
        pipelineUrl: "https://github.example/acme/checkout/actions/runs/9001",
      },
    });
  });

  it("maps Azure Pipelines metadata", () => {
    const metadata = detectMetadata({
      TF_BUILD: "True",
      BUILD_BUILDID: "321",
      BUILD_BUILDNUMBER: "20260923.1",
      BUILD_SOURCEBRANCH: "refs/heads/main",
      BUILD_SOURCEVERSION: "cafebabe",
      BUILD_DEFINITIONNAME: "Nightly",
      SYSTEM_JOBDISPLAYNAME: "API tests",
      SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/acme/",
      SYSTEM_TEAMPROJECT: "Checkout Platform",
    });

    expect(metadata.branch).toBe("main");
    expect(metadata.ci).toEqual(
      expect.objectContaining({
        provider: "azure",
        buildId: "321",
        pipelineName: "Nightly",
        pipelineUrl: "https://dev.azure.com/acme/Checkout%20Platform/_build/results?buildId=321",
      }),
    );
  });

  it("merges config and generic environment values over detected CI metadata", () => {
    expect(
      resolveCiContext(
        { jobName: "Configured browser tests" },
        {
          TESTCENTER_CI_BUILD_NUMBER: "84",
          TESTCENTER_CI_BUILD_NAME: "Nightly regression",
          TESTCENTER_CI_JOB_URL: "https://ci.example/jobs/84",
        },
        {
          provider: "github",
          buildId: "9001",
          buildNumber: "42",
          jobName: "playwright",
          pipelineUrl: "https://github.example/acme/checkout/actions/runs/9001",
        },
      ),
    ).toEqual({
      provider: "github",
      buildId: "9001",
      buildNumber: "84",
      jobName: "Configured browser tests",
      jobUrl: "https://ci.example/jobs/84",
      pipelineName: "Nightly regression",
      pipelineUrl: "https://github.example/acme/checkout/actions/runs/9001",
    });
  });
});
