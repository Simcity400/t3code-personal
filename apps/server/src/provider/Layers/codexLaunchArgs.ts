import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

/** Account overlays keep authentication private while reading one conversation database. */
export const withCodexAccountLaunchArgs = (launchArgs: string, sharedHomePath: string): string =>
  `${launchArgs} --config cli_auth_credentials_store=file --config ${JSON.stringify(`sqlite_home=${sharedHomePath}`)}`.trim();

export function hasCodexModelCatalogOverride(launchArgs: string): boolean {
  const args = codexLaunchArgv(launchArgs);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    // clap also accepts the attached short form `-cmodel_catalog_json=…`.
    const configValue =
      argument === "--config" || argument === "-c"
        ? args[index + 1]
        : argument.startsWith("--config=")
          ? argument.slice("--config=".length)
          : argument.startsWith("-c=")
            ? argument.slice("-c=".length)
            : argument.startsWith("-c") && argument.includes("=")
              ? argument.slice(2)
              : undefined;
    if (configValue !== undefined && /^\s*model_catalog_json\s*=/.test(configValue)) {
      return true;
    }
  }
  return false;
}

export const withCodexModelCatalogLaunchArgs = (
  launchArgs: string | undefined,
  modelCatalogPath: string | undefined,
): string => {
  const configured = launchArgs?.trim() ?? "";
  if (modelCatalogPath === undefined) return configured;
  if (hasCodexModelCatalogOverride(configured)) return configured;
  const override = `--config model_catalog_json=${JSON.stringify(modelCatalogPath)}`;
  return configured.length === 0 ? override : `${configured} ${override}`;
};

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};
