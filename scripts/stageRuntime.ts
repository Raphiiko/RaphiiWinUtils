import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const appDir = join(root, "dist", "app");

mkdirSync(appDir, { recursive: true });
cpSync(join(root, "src"), join(appDir, "src"), { recursive: true });
cpSync(join(root, "package.json"), join(appDir, "package.json"));

const lockPath = join(root, "package-lock.json");
if (!existsSync(lockPath)) {
  throw new Error("package-lock.json is required; run npm install first");
}
cpSync(lockPath, join(appDir, "package-lock.json"));

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("npm_execpath is unavailable; run this script through npm");
}

const install = spawnSync(
  process.execPath,
  [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  {
    cwd: appDir,
    windowsHide: true,
    stdio: "inherit"
  }
);

if (install.status !== 0) {
  throw new Error(
    `Failed to install production dependencies (exit ${install.status}): ${String(install.error)}`
  );
}
