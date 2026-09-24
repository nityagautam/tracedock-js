import type { TestCenterCiOptions, TestCenterCiProvider } from "./types.js";

export interface CiContext extends TestCenterCiOptions {
  provider: TestCenterCiProvider;
}

export interface DetectedMetadata {
  ci?: CiContext;
  branch?: string;
  commitSha?: string;
  pullRequest?: number;
}

type Environment = NodeJS.ProcessEnv;

const CI_PROVIDERS = new Set<TestCenterCiProvider>([
  "github",
  "gitlab",
  "jenkins",
  "circleci",
  "buildkite",
  "azure",
  "bitbucket",
  "teamcity",
  "local",
  "unknown",
]);

/** Detects the common CI providers without invoking git or vendor SDKs. */
export function detectMetadata(env: Environment): DetectedMetadata {
  if (env.GITHUB_ACTIONS === "true") return githubMetadata(env);
  if (env.GITLAB_CI === "true") return gitlabMetadata(env);
  if (env.TF_BUILD === "True" || env.TF_BUILD === "true") return azureMetadata(env);
  if (env.JENKINS_URL || env.BUILD_URL) return jenkinsMetadata(env);
  if (env.CIRCLECI === "true") return circleMetadata(env);
  if (env.BUILDKITE === "true") return buildkiteMetadata(env);
  if (env.BITBUCKET_BUILD_NUMBER) return bitbucketMetadata(env);
  if (env.TEAMCITY_VERSION) return teamcityMetadata(env);

  return compactMetadata({
    branch: first(env.TESTCENTER_BRANCH, env.GIT_BRANCH, env.BRANCH_NAME),
    commitSha: first(env.TESTCENTER_COMMIT_SHA, env.GIT_COMMIT),
    pullRequest: positiveInteger(env.TESTCENTER_PULL_REQUEST),
  });
}

/**
 * CI systems with native variables need no configuration, while custom runners can supply the
 * same fields through stable Test Center names. Merge per field so adding one override (usually a
 * friendlier job name) does not discard the URLs and build identifiers detected from the provider.
 */
export function resolveCiContext(
  configured: TestCenterCiOptions | undefined,
  env: Environment,
  detected: CiContext | undefined,
): TestCenterCiOptions | undefined {
  const resolved = removeUndefined<TestCenterCiOptions>({
    provider: configured?.provider ?? ciProvider(env.TESTCENTER_CI_PROVIDER) ?? detected?.provider,
    buildId: first(configured?.buildId, env.TESTCENTER_CI_BUILD_ID, detected?.buildId),
    buildNumber: first(
      configured?.buildNumber,
      env.TESTCENTER_CI_BUILD_NUMBER,
      detected?.buildNumber,
    ),
    jobName: first(configured?.jobName, env.TESTCENTER_CI_JOB_NAME, detected?.jobName),
    jobUrl: first(configured?.jobUrl, env.TESTCENTER_CI_JOB_URL, detected?.jobUrl),
    pipelineName: first(
      configured?.pipelineName,
      env.TESTCENTER_CI_PIPELINE_NAME,
      env.TESTCENTER_CI_BUILD_NAME,
      detected?.pipelineName,
    ),
    pipelineUrl: first(
      configured?.pipelineUrl,
      env.TESTCENTER_CI_PIPELINE_URL,
      detected?.pipelineUrl,
    ),
    actor: first(
      configured?.actor,
      env.TESTCENTER_CI_ACTOR,
      env.TESTCENTER_CI_TRIGGERED_BY,
      detected?.actor,
    ),
    triggerEvent: first(
      configured?.triggerEvent,
      env.TESTCENTER_CI_TRIGGER_EVENT,
      detected?.triggerEvent,
    ),
  });
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function githubMetadata(env: Environment): DetectedMetadata {
  const server = first(env.GITHUB_SERVER_URL, "https://github.com");
  const repository = env.GITHUB_REPOSITORY;
  const runUrl =
    server && repository && env.GITHUB_RUN_ID
      ? `${server}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  return compactMetadata({
    branch: first(env.GITHUB_HEAD_REF, env.GITHUB_REF_NAME),
    commitSha: env.GITHUB_SHA,
    pullRequest: positiveInteger(env.GITHUB_REF?.match(/refs\/pull\/(\d+)\//)?.[1]),
    ci: compactCi({
      provider: "github",
      buildId: env.GITHUB_RUN_ID,
      buildNumber: env.GITHUB_RUN_NUMBER,
      jobName: env.GITHUB_JOB,
      jobUrl: runUrl,
      pipelineName: env.GITHUB_WORKFLOW,
      pipelineUrl: runUrl,
      actor: env.GITHUB_ACTOR,
      triggerEvent: env.GITHUB_EVENT_NAME,
    }),
  });
}

function gitlabMetadata(env: Environment): DetectedMetadata {
  return compactMetadata({
    branch: first(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME, env.CI_COMMIT_REF_NAME),
    commitSha: env.CI_COMMIT_SHA,
    pullRequest: positiveInteger(env.CI_MERGE_REQUEST_IID),
    ci: compactCi({
      provider: "gitlab",
      buildId: env.CI_PIPELINE_ID,
      buildNumber: env.CI_PIPELINE_IID,
      jobName: env.CI_JOB_NAME,
      jobUrl: env.CI_JOB_URL,
      pipelineName: env.CI_PROJECT_PATH,
      pipelineUrl: env.CI_PIPELINE_URL,
      actor: env.GITLAB_USER_LOGIN,
      triggerEvent: env.CI_PIPELINE_SOURCE,
    }),
  });
}

function azureMetadata(env: Environment): DetectedMetadata {
  return compactMetadata({
    branch: first(env.SYSTEM_PULLREQUEST_SOURCEBRANCH, stripRef(env.BUILD_SOURCEBRANCH)),
    commitSha: first(env.SYSTEM_PULLREQUEST_SOURCECOMMITID, env.BUILD_SOURCEVERSION),
    pullRequest: positiveInteger(env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER),
    ci: compactCi({
      provider: "azure",
      buildId: env.BUILD_BUILDID,
      buildNumber: env.BUILD_BUILDNUMBER,
      jobName: first(env.SYSTEM_JOBDISPLAYNAME, env.SYSTEM_JOBNAME),
      jobUrl: azureBuildUrl(env),
      pipelineName: env.BUILD_DEFINITIONNAME,
      pipelineUrl: azureBuildUrl(env),
      actor: env.BUILD_REQUESTEDFOR,
      triggerEvent: env.BUILD_REASON,
    }),
  });
}

function jenkinsMetadata(env: Environment): DetectedMetadata {
  return compactMetadata({
    branch: first(env.CHANGE_BRANCH, env.BRANCH_NAME, env.GIT_BRANCH),
    commitSha: env.GIT_COMMIT,
    pullRequest: positiveInteger(env.CHANGE_ID),
    ci: compactCi({
      provider: "jenkins",
      buildId: env.BUILD_TAG,
      buildNumber: env.BUILD_NUMBER,
      jobName: env.JOB_NAME,
      jobUrl: env.BUILD_URL,
      pipelineName: env.JOB_NAME,
      pipelineUrl: env.JOB_URL,
      actor: env.BUILD_USER_ID,
      triggerEvent: env.BUILD_CAUSE,
    }),
  });
}

function circleMetadata(env: Environment): DetectedMetadata {
  return compactMetadata({
    branch: env.CIRCLE_BRANCH,
    commitSha: env.CIRCLE_SHA1,
    pullRequest: positiveInteger(env.CIRCLE_PULL_REQUEST?.match(/\/(\d+)$/)?.[1]),
    ci: compactCi({
      provider: "circleci",
      buildId: env.CIRCLE_WORKFLOW_ID,
      buildNumber: env.CIRCLE_BUILD_NUM,
      jobName: env.CIRCLE_JOB,
      jobUrl: env.CIRCLE_BUILD_URL,
      pipelineName: env.CIRCLE_PROJECT_REPONAME,
      pipelineUrl: env.CIRCLE_BUILD_URL,
      actor: env.CIRCLE_USERNAME,
    }),
  });
}

function buildkiteMetadata(env: Environment): DetectedMetadata {
  return compactMetadata({
    branch: env.BUILDKITE_BRANCH,
    commitSha: env.BUILDKITE_COMMIT,
    pullRequest: positiveInteger(env.BUILDKITE_PULL_REQUEST),
    ci: compactCi({
      provider: "buildkite",
      buildId: env.BUILDKITE_BUILD_ID,
      buildNumber: env.BUILDKITE_BUILD_NUMBER,
      jobName: env.BUILDKITE_LABEL,
      jobUrl: env.BUILDKITE_BUILD_URL,
      pipelineName: env.BUILDKITE_PIPELINE_NAME,
      pipelineUrl: env.BUILDKITE_BUILD_URL,
      actor: env.BUILDKITE_BUILD_CREATOR,
      triggerEvent: env.BUILDKITE_SOURCE,
    }),
  });
}

function bitbucketMetadata(env: Environment): DetectedMetadata {
  return compactMetadata({
    branch: env.BITBUCKET_BRANCH,
    commitSha: env.BITBUCKET_COMMIT,
    pullRequest: positiveInteger(env.BITBUCKET_PR_ID),
    ci: compactCi({
      provider: "bitbucket",
      buildId: env.BITBUCKET_PIPELINE_UUID,
      buildNumber: env.BITBUCKET_BUILD_NUMBER,
      jobName: env.BITBUCKET_STEP_TRIGGERER_UUID,
      jobUrl: env.BITBUCKET_GIT_HTTP_ORIGIN,
      pipelineName: env.BITBUCKET_REPO_FULL_NAME,
      actor: env.BITBUCKET_STEP_TRIGGERER_UUID,
    }),
  });
}

function teamcityMetadata(env: Environment): DetectedMetadata {
  return compactMetadata({
    branch: env.TEAMCITY_BUILD_BRANCH,
    commitSha: env.BUILD_VCS_NUMBER,
    ci: compactCi({
      provider: "teamcity",
      buildId: env.TEAMCITY_BUILD_ID,
      buildNumber: env.BUILD_NUMBER,
      jobName: env.TEAMCITY_BUILDCONF_NAME,
      jobUrl: env.BUILD_URL,
      pipelineName: env.TEAMCITY_PROJECT_NAME,
    }),
  });
}

function azureBuildUrl(env: Environment): string | undefined {
  if (!env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI || !env.SYSTEM_TEAMPROJECT || !env.BUILD_BUILDID) {
    return undefined;
  }
  return `${env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI}${encodeURIComponent(env.SYSTEM_TEAMPROJECT)}/_build/results?buildId=${env.BUILD_BUILDID}`;
}

function stripRef(value: string | undefined): string | undefined {
  return value?.replace(/^refs\/heads\//, "");
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "")?.trim();
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function ciProvider(value: string | undefined): TestCenterCiProvider | undefined {
  const normalized = value?.trim().toLowerCase() as TestCenterCiProvider | undefined;
  return normalized && CI_PROVIDERS.has(normalized) ? normalized : undefined;
}

function compactMetadata(input: DetectedMetadata): DetectedMetadata {
  return removeUndefined(input);
}

function compactCi(input: CiContext): CiContext {
  return removeUndefined(input);
}

function removeUndefined<Value extends object>(input: Value): Value {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Value;
}
