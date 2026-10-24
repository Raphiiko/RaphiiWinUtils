import { runCommand } from "./process.ts";

export async function getRunningProcessNames(processNames: string[]): Promise<Set<string>> {
  if (processNames.length === 0) return new Set();

  const names = processNames.map(toPowerShellString).join(", ");
  const result = await runCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-Process | Where-Object { $_.ProcessName -in @(${names}) } | ForEach-Object ProcessName`
    ],
    { timeoutMs: 10_000 }
  );

  if (result.code !== 0) {
    throw new Error(`Windows process query failed: ${result.stderr.trim() || result.code}`);
  }

  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Force-stops every process that is running under one of the names when the call starts, along
 * with its child processes. A process that a supervisor starts again under the same name gets a
 * new ID, so it does not count as a failed stop.
 */
export async function stopProcesses(processNames: string[]): Promise<void> {
  if (processNames.length === 0) return;
  const targets = await getRunningProcesses(processNames);
  if (targets.size === 0) return;

  try {
    await runCommand(
      "taskkill.exe",
      ["/F", "/T", ...[...targets.keys()].flatMap((id) => ["/PID", String(id)])],
      { timeoutMs: 10_000 }
    );
  } catch {
    // The exit check below decides whether the stop worked.
  }
  if (await waitForExit(targets, 5_000)) return;

  const elevatedVrProcesses = [...targets.values()].some((name) =>
    ["vrmonitor", "vrserver"].includes(name.toLowerCase())
  );
  if (elevatedVrProcesses) {
    const cleanup = await runCommand(
      "schtasks.exe",
      ["/Run", "/TN", "RaphiiWinUtils VR Cleanup"],
      { timeoutMs: 10_000 }
    );
    if (cleanup.code === 0 && (await waitForExit(targets, 30_000))) return;
  }

  const remaining = await survivingTargets(targets);
  throw new Error(
    `Windows process stop failed; still running: ${[...new Set(remaining.values())].join(", ") || "unknown"}`
  );
}

async function waitForExit(targets: Map<number, string>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await survivingTargets(targets)).size === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function survivingTargets(targets: Map<number, string>): Promise<Map<number, string>> {
  const running = await getRunningProcesses([...new Set(targets.values())]);
  return new Map(
    [...targets].filter(([id, name]) => running.get(id)?.toLowerCase() === name.toLowerCase())
  );
}

export async function getRunningProcessIds(processNames: string[]): Promise<Set<number>> {
  return new Set((await getRunningProcesses(processNames)).keys());
}

async function getRunningProcesses(processNames: string[]): Promise<Map<number, string>> {
  const names = processNames.map(toPowerShellString).join(", ");
  const result = await runCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @(${names}) } | ForEach-Object { "$($_.Id) $($_.ProcessName)" }`
    ],
    { timeoutMs: 10_000 }
  );
  if (result.code !== 0)
    throw new Error(`Windows process query failed: ${result.stderr.trim() || result.code}`);
  const processes = new Map<number, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^(\d+) (.+)$/.exec(line.trim());
    if (match) processes.set(Number(match[1]), match[2]);
  }
  return processes;
}

function toPowerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
