import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type FactoryCloudProvider = "aws" | "gcp" | "azure";

export type FactoryCloudCommandResult = {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type FactoryCloudCommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
) => Promise<FactoryCloudCommandResult>;

export type FactoryAwsExecutionContext = {
  readonly cliPath?: string;
  readonly version?: string;
  readonly profiles: ReadonlyArray<string>;
  readonly selectedProfile?: string;
  readonly defaultRegion?: string;
  readonly callerIdentity?: {
    readonly accountId: string;
    readonly arn: string;
    readonly userId?: string;
  };
};

export type FactoryGcpExecutionContext = {
  readonly cliPath?: string;
  readonly version?: string;
  readonly activeAccount?: string;
  readonly activeProject?: string;
};

export type FactoryAzureExecutionContext = {
  readonly cliPath?: string;
  readonly version?: string;
  readonly subscriptionId?: string;
  readonly subscriptionName?: string;
  readonly tenantId?: string;
  readonly user?: string;
};

export type FactoryCloudExecutionContext = {
  readonly summary: string;
  readonly availableProviders: ReadonlyArray<FactoryCloudProvider>;
  readonly activeProviders: ReadonlyArray<FactoryCloudProvider>;
  readonly preferredProvider?: FactoryCloudProvider;
  readonly guidance: ReadonlyArray<string>;
  readonly aws?: FactoryAwsExecutionContext;
  readonly gcp?: FactoryGcpExecutionContext;
  readonly azure?: FactoryAzureExecutionContext;
};

const trim = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const parseLines = (value: string): ReadonlyArray<string> =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const parseJson = <T>(value: string): T | undefined => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const defaultRunner: FactoryCloudCommandRunner = async (command, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    return {
      ok: true,
      exitCode: 0,
      stdout,
      stderr,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      readonly code?: string | number;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      ok: false,
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : (err.message ?? ""),
    };
  }
};

const commandPath = async (runner: FactoryCloudCommandRunner, command: string): Promise<string | undefined> => {
  const whichResult = process.platform === "win32"
    ? await runner("where", [command])
    : await runner("which", [command]);
  return whichResult.ok ? trim(parseLines(whichResult.stdout)[0]) : undefined;
};

const scanAwsExecutionContext = async (
  runner: FactoryCloudCommandRunner,
): Promise<FactoryAwsExecutionContext | undefined> => {
  const cliPath = await commandPath(runner, "aws");
  if (!cliPath) return undefined;
  const versionResult = await runner("aws", ["--version"]);
  const profilesResult = await runner("aws", ["configure", "list-profiles"]);
  const profiles = profilesResult.ok ? parseLines(profilesResult.stdout) : [];
  const selectedProfile = trim(process.env.AWS_PROFILE) ?? (profiles.includes("default") ? "default" : profiles[0]);
  const regionEnv = trim(process.env.AWS_REGION) ?? trim(process.env.AWS_DEFAULT_REGION);
  const regionArgs = selectedProfile ? ["configure", "get", "region", "--profile", selectedProfile] : ["configure", "get", "region"];
  const regionResult = regionEnv ? undefined : await runner("aws", regionArgs);
  const identityArgs = ["sts", "get-caller-identity", "--output", "json"];
  if (selectedProfile && !process.env.AWS_PROFILE) identityArgs.push("--profile", selectedProfile);
  const identityResult = await runner("aws", identityArgs);
  const identityJson = identityResult.ok
    ? parseJson<{ readonly Account?: string; readonly Arn?: string; readonly UserId?: string }>(identityResult.stdout)
    : undefined;
  return {
    cliPath,
    version: trim(versionResult.stderr) ?? trim(versionResult.stdout),
    profiles,
    selectedProfile,
    defaultRegion: regionEnv ?? trim(regionResult?.stdout),
    callerIdentity: identityJson?.Account && identityJson.Arn
      ? {
          accountId: identityJson.Account,
          arn: identityJson.Arn,
          userId: trim(identityJson.UserId),
        }
      : undefined,
  };
};

const scanGcpExecutionContext = async (
  runner: FactoryCloudCommandRunner,
): Promise<FactoryGcpExecutionContext | undefined> => {
  const cliPath = await commandPath(runner, "gcloud");
  if (!cliPath) return undefined;
  const versionResult = await runner("gcloud", ["--version"]);
  const accountResult = await runner("gcloud", ["config", "get-value", "account"]);
  const projectResult = await runner("gcloud", ["config", "get-value", "project"]);
  const activeAccount = trim(accountResult.stdout);
  const activeProject = trim(projectResult.stdout);
  return {
    cliPath,
    version: trim(parseLines(versionResult.stdout)[0]),
    activeAccount: activeAccount && activeAccount !== "(unset)" ? activeAccount : undefined,
    activeProject: activeProject && activeProject !== "(unset)" ? activeProject : undefined,
  };
};

const scanAzureExecutionContext = async (
  runner: FactoryCloudCommandRunner,
): Promise<FactoryAzureExecutionContext | undefined> => {
  const cliPath = await commandPath(runner, "az");
  if (!cliPath) return undefined;
  const versionResult = await runner("az", ["version", "--output", "json"]);
  const accountResult = await runner("az", ["account", "show", "--output", "json"]);
  const versionJson = versionResult.ok
    ? parseJson<Record<string, string>>(versionResult.stdout)
    : undefined;
  const accountJson = accountResult.ok
    ? parseJson<{
        readonly id?: string;
        readonly name?: string;
        readonly tenantId?: string;
        readonly user?: { readonly name?: string };
      }>(accountResult.stdout)
    : undefined;
  return {
    cliPath,
    version: trim(versionJson?.["azure-cli"]),
    subscriptionId: trim(accountJson?.id),
    subscriptionName: trim(accountJson?.name),
    tenantId: trim(accountJson?.tenantId),
    user: trim(accountJson?.user?.name),
  };
};

export const scanFactoryCloudExecutionContext = async (
  runner: FactoryCloudCommandRunner = defaultRunner,
): Promise<FactoryCloudExecutionContext> => {
  const [aws, gcp, azure] = await Promise.all([
    scanAwsExecutionContext(runner),
    scanGcpExecutionContext(runner),
    scanAzureExecutionContext(runner),
  ]);
  const availableProviders: FactoryCloudProvider[] = [
    ...(aws ? ["aws" as const] : []),
    ...(gcp ? ["gcp" as const] : []),
    ...(azure ? ["azure" as const] : []),
  ];
  const activeProviders: FactoryCloudProvider[] = [
    ...(aws?.callerIdentity ? ["aws" as const] : []),
    ...(gcp?.activeAccount ? ["gcp" as const] : []),
    ...(azure?.subscriptionId ? ["azure" as const] : []),
  ];
  const preferredProvider = activeProviders.length === 1
    ? activeProviders[0]
    : activeProviders.length === 0 && availableProviders.length === 1
      ? availableProviders[0]
      : undefined;
  const guidance = [
    preferredProvider
      ? `One provider is clearly usable from the local CLI context (${preferredProvider}). Use it by default instead of asking the user to restate provider or scope.`
      : activeProviders.length > 1
        ? "Multiple cloud providers are active locally. Confirm the intended provider before using high-confidence counts."
        : availableProviders.length > 0
          ? "Cloud CLIs are installed locally, but no single active provider context was detected."
          : "No cloud CLI context was detected from the local machine.",
    aws?.callerIdentity
      ? `AWS bucket listing is global for the active account ${aws.callerIdentity.accountId}; region is secondary unless the objective asks for regional filtering.`
      : "",
  ].filter(Boolean);
  const summaryParts = [
    aws
      ? aws.callerIdentity
        ? `AWS CLI is available${aws.selectedProfile ? ` via profile ${aws.selectedProfile}` : ""}; active identity ${aws.callerIdentity.arn} in account ${aws.callerIdentity.accountId}${aws.defaultRegion ? ` with region ${aws.defaultRegion}` : ""}.`
        : `AWS CLI is available${aws.selectedProfile ? ` with profile ${aws.selectedProfile}` : ""}, but no active caller identity was confirmed.`
      : "",
    gcp
      ? gcp.activeAccount
        ? `gcloud is available with account ${gcp.activeAccount}${gcp.activeProject ? ` and project ${gcp.activeProject}` : ""}.`
        : "gcloud is available, but no active account was confirmed."
      : "",
    azure
      ? azure.subscriptionId
        ? `Azure CLI is available with subscription ${azure.subscriptionName ?? azure.subscriptionId}.`
        : "Azure CLI is available, but no active subscription was confirmed."
      : "",
    guidance[0] ?? "",
  ].filter(Boolean);
  return {
    summary: summaryParts.join(" "),
    availableProviders,
    activeProviders,
    preferredProvider,
    guidance,
    aws,
    gcp,
    azure,
  };
};
