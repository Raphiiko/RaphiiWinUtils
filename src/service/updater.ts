import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { exhaustMap, from, Subject, Subscription, timer } from "rxjs";
import type { UpdaterConfig } from "../config/schema.ts";
import { Logger } from "../system/logger.ts";
import { getNodeExecutablePath, getNpmCliPath, getRuntimeRoot } from "../system/paths.ts";
import { requireSuccess, runCommand } from "../system/process.ts";
import type { Notifier } from "../system/notify.ts";
import { writeLauncherScript } from "./installer.ts";

interface UpdateCheckRequest {
  reason: string;
}

export class Updater {
  private readonly log: Logger;
  private readonly config: UpdaterConfig;
  private readonly notifier: Notifier;
  private readonly checkRequests$ = new Subject<UpdateCheckRequest>();
  private readonly subscriptions = new Subscription();
  private active = false;
  private checkInProgress = false;
  private lastCheckStartedAt?: string;
  private lastCheckFinishedAt?: string;
  private lastCheckReason?: string;
  private lastCheckResult?: string;

  constructor(config: UpdaterConfig, notifier: Notifier, logger: Logger) {
    this.config = config;
    this.notifier = notifier;
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

    this.active = true;
    const everyMs = Math.max(1, this.config.checkEveryMinutes) * 60_000;
    this.subscriptions.add(
      this.checkRequests$
        .pipe(exhaustMap((request) => from(this.checkOnce(request.reason))))
        .subscribe({
          error: (error) => {
            this.log.error("Updater stream failed", { error: String(error) });
          }
        })
    );

    this.subscriptions.add(
      timer(0, everyMs).subscribe(() => {
        this.requestCheck("timer");
      })
    );
  }

  stop(): void {
    this.subscriptions.unsubscribe();
    this.active = false;
  }

  requestCheck(reason: string): boolean {
    if (!this.active) {
      this.log.debug("Update check request ignored because updater is inactive", { reason });
      return false;
    }

    if (this.checkInProgress) {
      this.log.info("Update check request ignored because a check is already running", {
        reason,
        currentReason: this.lastCheckReason
      });
      return false;
    }

    this.checkInProgress = true;
    this.checkRequests$.next({ reason });
    return true;
  }

  getStatus(): Record<string, unknown> {
    return {
      active: this.active,
      checkInProgress: this.checkInProgress,
      lastCheckReason: this.lastCheckReason,
      lastCheckStartedAt: this.lastCheckStartedAt,
      lastCheckFinishedAt: this.lastCheckFinishedAt,
      lastCheckResult: this.lastCheckResult
    };
  }

  private async checkOnce(reason: string): Promise<void> {
    this.lastCheckReason = reason;
    this.lastCheckStartedAt = new Date().toISOString();
    this.lastCheckFinishedAt = undefined;
    this.lastCheckResult = undefined;
    this.log.info("Update check started", { reason });

    const sourceDir = join(this.config.installDir, "source");
    try {
      const sourceReady = await ensureSourceClone(this.config, sourceDir);
      if (!sourceReady) {
        this.lastCheckResult = "source-unavailable";
        this.log.warn("Update source is not available yet; skipping update check");
        return;
      }
      await requireSuccess("git", ["fetch", "--prune", "origin"], {
        cwd: sourceDir,
        timeoutMs: 120_000
      });
      const remote = (
        await requireSuccess("git", ["rev-parse", `origin/${this.config.branch}`], {
          cwd: sourceDir
        })
      ).stdout.trim();
      const deployed = readDeployedRevision(this.config.installDir);

      if (deployed === remote) {
        this.lastCheckResult = "no-update";
        this.log.debug("No update available", { deployed });
        return;
      }

      this.lastCheckResult = "update-available";
      this.notifier.send("RaphiiWinUtils", "Update found. Building new version.");
      this.log.info("Update available", { deployed, remote });
      await requireSuccess("git", ["reset", "--hard", `origin/${this.config.branch}`], {
        cwd: sourceDir,
        timeoutMs: 60_000
      });
      const nodePath = getNodeExecutablePath();
      const npmCli = getNpmCliPath();
      await requireSuccess(nodePath, [npmCli, "ci"], {
        cwd: sourceDir,
        timeoutMs: 120_000
      });
      await requireSuccess(nodePath, [npmCli, "run", "build:all"], {
        cwd: sourceDir,
        timeoutMs: 180_000
      });

      stageAndRestart(sourceDir, this.config.installDir, remote);
    } catch (error) {
      this.lastCheckResult = "failed";
      this.log.error("Update check failed", { error: String(error) });
      this.notifier.send("RaphiiWinUtils update failed", String(error).slice(0, 180));
    } finally {
      this.lastCheckFinishedAt = new Date().toISOString();
      this.checkInProgress = false;
    }
  }
}

export function notifyCompletedUpdateIfNeeded(
  config: UpdaterConfig,
  notifier: Notifier,
  logger: Logger
): void {
  const log = logger.child("updater");
  if (!isInstalledRuntime(config.installDir)) return;

  const marker = getUpdateCompletedMarkerPath(config.installDir);
  if (!existsSync(marker)) return;

  let revision: string | undefined;
  try {
    const completion = JSON.parse(readFileSync(marker, "utf8").replace(/^\uFEFF/, "")) as Partial<{
      revision: string;
    }>;
    revision = completion.revision;
  } catch (error) {
    log.warn("Could not read update completion marker", { error: String(error) });
  } finally {
    rmSync(marker, { force: true });
  }

  const shortRevision = revision?.slice(0, 7);
  notifier.send(
    "RaphiiWinUtils update complete",
    shortRevision
      ? `Updated to ${shortRevision} and restarted successfully.`
      : "Updated and restarted successfully."
  );
  log.info("Update completion notification sent", { revision });
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
  const result = await runCommand(
    "git",
    ["clone", "--branch", config.branch, config.repoUrl, sourceDir],
    {
      timeoutMs: 120_000
    }
  );
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

function getUpdateCompletedMarkerPath(installDir: string): string {
  return join(installDir, ".update-completed.json");
}

function stageAndRestart(sourceDir: string, installDir: string, revision: string): void {
  const distDir = join(sourceDir, "dist");
  const scriptPath = join(installDir, "apply-update.ps1");
  const launcherPath = writeLauncherScript(installDir);
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
    `$launcherPath = "${ps(launcherPath)}"`,
    `$logPath = "${ps(logPath)}"`,
    `$completionMarker = "${ps(getUpdateCompletedMarkerPath(installDir))}"`,
    "New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null",
    "function Write-UpdateLog([string]$message) { Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString('o') + ' ' + $message) }",
    "try {",
    '  Write-UpdateLog "Waiting for process $pidToWait"',
    "  Wait-Process -Id $pidToWait -Timeout 30 -ErrorAction SilentlyContinue",
    "  Start-Sleep -Milliseconds 500",
    "  $app = Join-Path $install 'app'",
    "  Write-UpdateLog 'Copying Node application'",
    "  if (Test-Path -LiteralPath $app) { Remove-Item -LiteralPath $app -Recurse -Force }",
    "  Copy-Item -LiteralPath (Join-Path $dist 'app') -Destination $app -Recurse -Force",
    "  $helpers = Join-Path $install 'helpers'",
    "  Write-UpdateLog 'Copying helpers'",
    "  if (Test-Path -LiteralPath $helpers) { Remove-Item -LiteralPath $helpers -Recurse -Force }",
    "  Copy-Item -LiteralPath (Join-Path $dist 'helpers') -Destination $helpers -Recurse -Force",
    "  Set-Content -LiteralPath (Join-Path $install '.deployed-revision') -Value $revision -Encoding UTF8",
    "  @{ revision = $revision; completedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $completionMarker -Encoding UTF8",
    '  Write-UpdateLog "Starting updated service at revision $revision"',
    "  Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', '//Nologo', $launcherPath) -WorkingDirectory $install -WindowStyle Hidden",
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

  const launch = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", launchCommand],
    { windowsHide: true, encoding: "utf8" }
  );

  if (launch.status !== 0) {
    throw new Error(`Failed to launch update handoff: ${launch.stdout}\n${launch.stderr}`.trim());
  }

  process.exit(0);
}

function ps(value: string): string {
  return value.replace(/`/g, "``").replace(/"/g, '`"');
}
