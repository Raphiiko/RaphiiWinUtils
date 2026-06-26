import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import type { AppConfig } from "../config/schema.ts";
import { Logger } from "../system/logger.ts";
import { getNodeExecutablePath, getNpmCliPath, getSnoreToastPath } from "../system/paths.ts";
import { requireSuccess } from "../system/process.ts";

export async function installLocal(config: AppConfig, logger: Logger): Promise<void> {
  const log = logger.child("install");
  const installDir = config.updater.installDir;
  const sourceDir = join(installDir, "source");

  mkdirSync(installDir, { recursive: true });

  log.info("Building current source with Node", { node: process.version });
  const nodePath = getNodeExecutablePath();
  const npmCli = getNpmCliPath();
  await requireSuccess(nodePath, [npmCli, "install"], {
    cwd: process.cwd(),
    timeoutMs: 120_000
  });
  await requireSuccess(nodePath, [npmCli, "run", "build:all"], {
    cwd: process.cwd(),
    timeoutMs: 180_000
  });

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

  registerWindowsIntegration(installDir, config.notifications.appName);
  await installPushUpdateHook(config, log);
  log.info("Install complete", {
    node: nodePath,
    entrypoint: join(installDir, "app", "src", "main.ts")
  });
}

export function copyBuildArtifacts(fromDir: string, installDir: string): void {
  const app = join(fromDir, "app");
  const helpers = join(fromDir, "helpers");
  if (!existsSync(app)) throw new Error(`Missing staged application: ${app}`);

  const targetApp = join(installDir, "app");
  rmSync(targetApp, { recursive: true, force: true });
  cpSync(app, targetApp, { recursive: true, force: true });
  rmSync(join(installDir, "RaphiiWinUtils.exe"), { force: true });
  if (existsSync(helpers)) {
    const targetHelpers = join(installDir, "helpers");
    rmSync(targetHelpers, { recursive: true, force: true });
    cpSync(helpers, targetHelpers, { recursive: true, force: true });
  }
}

function registerWindowsIntegration(installDir: string, appName: string): void {
  const launcherPath = writeLauncherScript(installDir);
  const nodePath = getNodeExecutablePath();
  const snoreInstall = spawnSync(
    getSnoreToastPath(),
    ["-install", appName, nodePath, "Raphiiko.RaphiiWinUtils"],
    {
      windowsHide: true,
      encoding: "utf8"
    }
  );

  if (snoreInstall.status !== 0) {
    throw new Error(`Failed to register notification shortcut: ${snoreInstall.stderr}`);
  }

  removeStartupShortcut(appName);
  registerLogonTask(installDir, appName, launcherPath);
}

export function writeLauncherScript(installDir: string): string {
  const entrypoint = join(installDir, "app", "src", "main.ts");
  const launcherPath = join(installDir, "RaphiiWinUtils.launch.vbs");
  const command = `"""${vbs(getNodeExecutablePath())}"" ""${vbs(entrypoint)}"" run"`;
  const script = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${vbs(installDir)}"`,
    `exitCode = shell.Run(${command}, 0, True)`,
    "WScript.Quit exitCode"
  ].join("\r\n");
  writeFileSync(launcherPath, `${script}\r\n`, "utf8");
  return launcherPath;
}

function removeStartupShortcut(appName: string): void {
  const startupDir = join(
    process.env.APPDATA ?? "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
  const startupShortcutPath = join(startupDir, `${appName}.lnk`);
  rmSync(startupShortcutPath, { force: true });
}

function registerLogonTask(installDir: string, appName: string, launcherPath: string): void {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$taskName = "${ps(appName)}"`,
    `$launcherPath = "${ps(launcherPath)}"`,
    `$installDir = "${ps(installDir)}"`,
    "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    '$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ("//B //Nologo `"" + $launcherPath + "`"") -WorkingDirectory $installDir',
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user",
    "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
    "$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
    `Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "${ps(appName)} background service" -Force | Out-Null`
  ].join("; ");

  const taskResult = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      encoding: "utf8"
    }
  );
  if (taskResult.status !== 0) {
    throw new Error(`Failed to register logon task: ${taskResult.stderr}`);
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

async function installPushUpdateHook(config: AppConfig, log: Logger): Promise<void> {
  if (!config.control.enabled) {
    log.info("Skipping push update hook because control API is disabled");
    return;
  }

  try {
    const hookPath = (
      await requireSuccess("git", ["rev-parse", "--git-path", "hooks/pre-push"], {
        cwd: process.cwd()
      })
    ).stdout.trim();
    const absoluteHookPath = isAbsolute(hookPath) ? hookPath : join(process.cwd(), hookPath);
    const endpoint = `http://${config.control.host}:${config.control.port}/update/check`;
    const begin = "# BEGIN RaphiiWinUtils update check";
    const end = "# END RaphiiWinUtils update check";
    const block = [
      begin,
      "# Git has no client-side post-push hook, so pre-push starts a background process that waits for this git push to exit.",
      `RAPHII_GIT_PUSH_PID="$PPID" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 'Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-Command","try { Wait-Process -Id $env:RAPHII_GIT_PUSH_PID -ErrorAction SilentlyContinue } catch { }; Start-Sleep -Seconds 3; try { Invoke-RestMethod -Method Post -Uri ${endpoint} | Out-Null } catch { }") -WindowStyle Hidden'`,
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
    removeManagedPostPushHook(log);
    log.info("Installed push update hook", { hookPath: absoluteHookPath, endpoint });
  } catch (error) {
    log.warn("Could not install push update hook", { error: String(error) });
  }
}

function removeManagedPostPushHook(log: Logger): void {
  try {
    const hookPath = join(process.cwd(), ".git", "hooks", "post-push");
    const begin = "# BEGIN RaphiiWinUtils update check";
    const end = "# END RaphiiWinUtils update check";
    if (!existsSync(hookPath)) return;

    const existing = readFileSync(hookPath, "utf8");
    const withoutOldBlock = existing
      .replace(
        new RegExp(`\\n?${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m"),
        "\n"
      )
      .trimEnd();

    if (withoutOldBlock.trim().length === 0 || withoutOldBlock.trim() === "#!/bin/sh") {
      rmSync(hookPath, { force: true });
      return;
    }

    writeFileSync(hookPath, `${withoutOldBlock}\n`, "utf8");
  } catch (error) {
    log.warn("Could not remove old post-push hook", { error: String(error) });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ps(value: string): string {
  return value.replace(/`/g, "``").replace(/"/g, '`"');
}

function vbs(value: string): string {
  return value.replace(/"/g, '""');
}
