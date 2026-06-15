import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { interval, merge, of, switchMap } from "rxjs";
import type { UpdaterConfig } from "../config/schema";
import { Logger } from "../system/logger";
import { getRuntimeRoot } from "../system/paths";
import { requireSuccess, runCommand } from "../system/process";
import type { Notifier } from "../system/notify";

export class Updater {
  private readonly log: Logger;

  constructor(
    private readonly config: UpdaterConfig,
    private readonly notifier: Notifier,
    logger: Logger
  ) {
    this.log = logger.child("updater");
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("Updater disabled");
      return;
    }

    if (!isInstalledRuntime(this.config.installDir)) {
      this.log.info("Updater inactive outside installed runtime", {
        runtimeRoot: getRuntimeRoot(),
        installDir: this.config.installDir
      });
      return;
    }

    const everyMs = Math.max(1, this.config.checkEveryMinutes) * 60_000;
    merge(of(0), interval(everyMs))
      .pipe(switchMap(() => this.checkOnce()))
      .subscribe({
        error: (error) => {
          this.log.error("Updater stream failed", { error: String(error) });
        }
      });
  }

  private async checkOnce(): Promise<void> {
    const sourceDir = join(this.config.installDir, "source");
    try {
      const sourceReady = await ensureSourceClone(this.config, sourceDir);
      if (!sourceReady) {
        this.log.warn("Update source is not available yet; skipping update check");
        return;
      }
      await requireSuccess("git", ["fetch", "origin", this.config.branch], { cwd: sourceDir, timeoutMs: 120_000 });
      const remote = (await requireSuccess("git", ["rev-parse", `origin/${this.config.branch}`], { cwd: sourceDir })).stdout.trim();
      const deployed = readDeployedRevision(this.config.installDir);

      if (deployed === remote) {
        this.log.debug("No update available", { deployed });
        return;
      }

      this.notifier.send("RaphiiWinUtils", "Update found. Building new version.");
      this.log.info("Update available", { deployed, remote });
      await requireSuccess("git", ["reset", "--hard", `origin/${this.config.branch}`], { cwd: sourceDir, timeoutMs: 60_000 });
      await requireSuccess("bun", ["install", "--frozen-lockfile"], { cwd: sourceDir, timeoutMs: 120_000 });
      await requireSuccess("bun", ["run", "build:all"], { cwd: sourceDir, timeoutMs: 180_000 });

      await stageAndRestart(sourceDir, this.config.installDir, remote);
    } catch (error) {
      this.log.error("Update check failed", { error: String(error) });
      this.notifier.send("RaphiiWinUtils update failed", String(error).slice(0, 180));
    }
  }
}

function isInstalledRuntime(installDir: string): boolean {
  return normalize(getRuntimeRoot()) === normalize(installDir);
}

function normalize(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

async function ensureSourceClone(config: UpdaterConfig, sourceDir: string): Promise<boolean> {
  if (existsSync(join(sourceDir, ".git"))) return true;

  if (existsSync(sourceDir)) {
    rmSync(sourceDir, { recursive: true, force: true });
  }

  mkdirSync(config.installDir, { recursive: true });
  const result = await runCommand("git", ["clone", "--branch", config.branch, config.repoUrl, sourceDir], {
    timeoutMs: 120_000
  });
  if (result.code !== 0) {
    return false;
  }

  return true;
}

function readDeployedRevision(installDir: string): string | undefined {
  const marker = join(installDir, ".deployed-revision");
  if (!existsSync(marker)) return undefined;
  const revision = readFileSync(marker, "utf8").trim();
  return revision || undefined;
}

async function stageAndRestart(sourceDir: string, installDir: string, revision: string): Promise<void> {
  const distDir = join(sourceDir, "dist");
  const scriptPath = join(installDir, "apply-update.ps1");
  const logPath = join(
    process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"),
    "RaphiiWinUtils",
    "logs",
    `update-${new Date().toISOString().slice(0, 10)}.log`
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$pidToWait = ${process.pid}`,
    `$dist = "${ps(distDir)}"`,
    `$install = "${ps(installDir)}"`,
    `$revision = "${ps(revision)}"`,
    `$logPath = "${ps(logPath)}"`,
    "New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null",
    "function Write-UpdateLog([string]$message) { Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString('o') + ' ' + $message) }",
    "try {",
    "  Write-UpdateLog \"Waiting for process $pidToWait\"",
    "  Wait-Process -Id $pidToWait -Timeout 30 -ErrorAction SilentlyContinue",
    "  Start-Sleep -Milliseconds 500",
    "  Write-UpdateLog 'Copying executable'",
    "  Copy-Item -LiteralPath (Join-Path $dist 'RaphiiWinUtils.exe') -Destination (Join-Path $install 'RaphiiWinUtils.exe') -Force",
    "  $helpers = Join-Path $install 'helpers'",
    "  Write-UpdateLog 'Copying helpers'",
    "  if (Test-Path -LiteralPath $helpers) { Remove-Item -LiteralPath $helpers -Recurse -Force }",
    "  Copy-Item -LiteralPath (Join-Path $dist 'helpers') -Destination $helpers -Recurse -Force",
    "  Set-Content -LiteralPath (Join-Path $install '.deployed-revision') -Value $revision -Encoding UTF8",
    "  Write-UpdateLog \"Starting updated service at revision $revision\"",
    "  Start-Process -FilePath (Join-Path $install 'RaphiiWinUtils.exe') -WorkingDirectory $install -WindowStyle Hidden",
    "  Write-UpdateLog 'Update handoff complete'",
    "} catch {",
    "  Write-UpdateLog ('Update handoff failed: ' + $_.Exception.ToString())",
    "  throw",
    "}"
  ].join("\n");

  writeFileSync(scriptPath, script, "utf8");

  const launchCommand = [
    "$ErrorActionPreference = 'Stop'",
    `$scriptPath = "${ps(scriptPath)}"`,
    "$args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath)",
    "Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden"
  ].join("; ");

  const launch = Bun.spawnSync([
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    launchCommand
  ], {
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (launch.exitCode !== 0) {
    const stderr = new TextDecoder().decode(launch.stderr);
    const stdout = new TextDecoder().decode(launch.stdout);
    throw new Error(`Failed to launch update handoff: ${stdout}\n${stderr}`.trim());
  }

  process.exit(0);
}

function ps(value: string): string {
  return value.replace(/`/g, "``").replace(/"/g, "`\"");
}
