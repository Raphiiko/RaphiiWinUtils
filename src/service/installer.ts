import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AppConfig } from "../config/schema";
import { Logger } from "../system/logger";
import { getSnoreToastPath } from "../system/paths";
import { requireSuccess } from "../system/process";

export async function installLocal(config: AppConfig, logger: Logger): Promise<void> {
  const log = logger.child("install");
  const installDir = config.updater.installDir;
  const sourceDir = join(installDir, "source");

  mkdirSync(installDir, { recursive: true });

  log.info("Building current source");
  await requireSuccess("bun", ["install"], { cwd: process.cwd(), timeoutMs: 120_000 });
  await requireSuccess("bun", ["run", "build:all"], { cwd: process.cwd(), timeoutMs: 180_000 });

  log.info("Deploying build", { installDir });
  copyBuildArtifacts(join(process.cwd(), "dist"), installDir);
  await writeDeployedRevision(installDir, log);

  if (existsSync(sourceDir) && !existsSync(join(sourceDir, ".git"))) {
    rmSync(sourceDir, { recursive: true, force: true });
  }

  if (!existsSync(sourceDir)) {
    log.info("Cloning self-update source", { sourceDir });
    await requireSuccess(
      "git",
      ["clone", "--branch", config.updater.branch, config.updater.repoUrl, sourceDir],
      {
        timeoutMs: 120_000
      }
    ).catch((error) => {
      log.warn("Could not clone update source yet; install still deployed current build", {
        error: String(error)
      });
    });
  }

  createWindowsShortcuts(installDir, config.notifications.appName);
  await installPostPushHook(config, log);
  log.info("Install complete", { exe: join(installDir, "RaphiiWinUtils.exe") });
}

export function copyBuildArtifacts(fromDir: string, installDir: string): void {
  const exe = join(fromDir, "RaphiiWinUtils.exe");
  const helpers = join(fromDir, "helpers");
  if (!existsSync(exe)) throw new Error(`Missing built executable: ${exe}`);

  cpSync(exe, join(installDir, "RaphiiWinUtils.exe"), { force: true });
  if (existsSync(helpers)) {
    const targetHelpers = join(installDir, "helpers");
    rmSync(targetHelpers, { recursive: true, force: true });
    cpSync(helpers, targetHelpers, { recursive: true, force: true });
  }
}

function createWindowsShortcuts(installDir: string, appName: string): void {
  const exePath = join(installDir, "RaphiiWinUtils.exe");
  const snoreInstall = Bun.spawnSync([
    getSnoreToastPath(),
    "-install",
    appName,
    exePath,
    "Raphiiko.RaphiiWinUtils"
  ]);

  if (snoreInstall.exitCode !== 0) {
    throw new Error(
      `Failed to register notification shortcut: ${new TextDecoder().decode(snoreInstall.stderr)}`
    );
  }

  const startupDir = join(
    process.env.APPDATA ?? "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
  if (!startupDir) throw new Error("APPDATA is not available; cannot create Startup shortcut");

  if (!existsSync(startupDir)) {
    mkdirSync(startupDir, { recursive: true });
  } else if (!statSync(startupDir).isDirectory()) {
    throw new Error(`Startup path exists but is not a directory: ${startupDir}`);
  }

  const startupShortcutPath = join(startupDir, `${appName}.lnk`);
  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut("${ps(startupShortcutPath)}")`,
    `$shortcut.TargetPath = "${ps(exePath)}"`,
    `$shortcut.WorkingDirectory = "${ps(installDir)}"`,
    "$shortcut.Save()"
  ].join("; ");

  const startupResult = Bun.spawnSync([
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ]);
  if (startupResult.exitCode !== 0) {
    throw new Error(
      `Failed to create Startup shortcut: ${new TextDecoder().decode(startupResult.stderr)}`
    );
  }
}

async function writeDeployedRevision(installDir: string, log: Logger): Promise<void> {
  try {
    const revision = (
      await requireSuccess("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })
    ).stdout.trim();
    writeFileSync(join(installDir, ".deployed-revision"), `${revision}\n`, "utf8");
  } catch (error) {
    log.warn("Could not write deployed revision marker", { error: String(error) });
  }
}

async function installPostPushHook(config: AppConfig, log: Logger): Promise<void> {
  if (!config.control.enabled) {
    log.info("Skipping post-push hook because control API is disabled");
    return;
  }

  try {
    const hookPath = (
      await requireSuccess("git", ["rev-parse", "--git-path", "hooks/post-push"], {
        cwd: process.cwd()
      })
    ).stdout.trim();
    const absoluteHookPath = isAbsolute(hookPath) ? hookPath : join(process.cwd(), hookPath);
    const endpoint = `http://${config.control.host}:${config.control.port}/update/check`;
    const begin = "# BEGIN RaphiiWinUtils update check";
    const end = "# END RaphiiWinUtils update check";
    const block = [
      begin,
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Method Post -Uri '${endpoint}' | Out-Null } catch { }"`,
      end
    ].join("\n");

    mkdirSync(dirname(absoluteHookPath), { recursive: true });
    const existing = existsSync(absoluteHookPath)
      ? readFileSync(absoluteHookPath, "utf8")
      : "#!/bin/sh\n";
    const withoutOldBlock = existing
      .replace(
        new RegExp(`\\n?${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m"),
        "\n"
      )
      .trimEnd();
    writeFileSync(absoluteHookPath, `${withoutOldBlock}\n\n${block}\n`, "utf8");
    chmodSync(absoluteHookPath, 0o755);
    log.info("Installed post-push update hook", { hookPath: absoluteHookPath, endpoint });
  } catch (error) {
    log.warn("Could not install post-push update hook", { error: String(error) });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ps(value: string): string {
  return value.replace(/`/g, "``").replace(/"/g, '`"');
}
