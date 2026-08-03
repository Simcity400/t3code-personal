import * as NodeChildProcess from "node:child_process";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

// Launch the app DIRECTORY, not the entry file: with a bare file Electron has
// no package.json, so app.getVersion() reports Electron's own version (the
// stage label resolves to "Alpha" instead of "Nightly") and the default app
// identity is "Electron". The directory launch reads main/version/productName
// from apps/desktop/package.json.
const electronCommand = resolveElectronLaunchCommand([desktopDir]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
