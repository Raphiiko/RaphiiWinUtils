import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config/schema";
import { Logger } from "../system/logger";
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
    await requireSuccess("git", ["clone", "--branch", config.updater.branch, config.updater.repoUrl, sourceDir], {
      timeoutMs: 120_000
    }).catch((error) => {
      log.warn("Could not clone update source yet; install still deployed current build", { error: String(error) });
    });
  }

  createStartupShortcut(installDir, config.notifications.appName);
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

function createStartupShortcut(installDir: string, appName: string): void {
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
  const shortcutPath = join(startupDir, `${appName}.lnk`);
  const exePath = join(installDir, "RaphiiWinUtils.exe");
  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut("${ps(shortcutPath)}")`,
    `$shortcut.TargetPath = "${ps(exePath)}"`,
    `$shortcut.WorkingDirectory = "${ps(installDir)}"`,
    "$shortcut.Save()"
  ].join("; ");

  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create startup shortcut: ${new TextDecoder().decode(result.stderr)}`);
  }
}

async function writeDeployedRevision(installDir: string, log: Logger): Promise<void> {
  try {
    const revision = (await requireSuccess("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim();
    writeFileSync(join(installDir, ".deployed-revision"), `${revision}\n`, "utf8");
  } catch (error) {
    log.warn("Could not write deployed revision marker", { error: String(error) });
  }
}

function ps(value: string): string {
  return value.replace(/`/g, "``").replace(/"/g, "`\"");
}
