import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
  withCodexModelCatalogLaunchArgs,
  withCodexAccountLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("withCodexAccountLaunchArgs", () => {
  it("keeps a shadow account's credentials private and shares the same database for sessions and helpers", () => {
    const sharedHome = "C:\\Users\\Jane Doe\\.codex";
    const configured = "--enable feature --config cli_auth_credentials_store=keyring";
    const launchArgs = withCodexAccountLaunchArgs(configured, sharedHome);
    const expected = [
      "--enable",
      "feature",
      "--config",
      "cli_auth_credentials_store=keyring",
      "--config",
      "cli_auth_credentials_store=file",
      "--config",
      `sqlite_home=${sharedHome}`,
    ];
    NodeAssert.deepEqual(codexAppServerArgs(launchArgs), ["app-server", ...expected]);
    NodeAssert.deepEqual(codexExecLaunchArgs(launchArgs), expected);
  });
});

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("withCodexModelCatalogLaunchArgs", () => {
  it("adds a quoted model catalog override that survives tokenization", () => {
    const launchArgs = withCodexModelCatalogLaunchArgs(
      "--strict-config",
      "C:\\T3 Code\\codex-models.json",
    );

    NodeAssert.deepStrictEqual(codexAppServerArgs(launchArgs), [
      "app-server",
      "--strict-config",
      "--config",
      "model_catalog_json=C:\\T3 Code\\codex-models.json",
    ]);
  });

  it("preserves an explicit user model catalog override", () => {
    NodeAssert.equal(
      withCodexModelCatalogLaunchArgs(
        '--config model_catalog_json="C:\\custom\\models.json"',
        "C:\\t3\\models.json",
      ),
      '--config model_catalog_json="C:\\custom\\models.json"',
    );
  });

  it("preserves a TOML-valid override with whitespace around the equals sign", () => {
    const configured = `-c "model_catalog_json = 'C:\\custom models\\models.json'"`;
    NodeAssert.equal(
      withCodexModelCatalogLaunchArgs(configured, "C:\\t3\\models.json"),
      configured,
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
