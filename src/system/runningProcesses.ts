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

export async function stopProcesses(processNames: string[]): Promise<void> {
  if (processNames.length === 0) return;

  const elevatedVrProcesses = processNames.some((name) =>
    ["vrmonitor", "vrserver"].includes(name.toLowerCase())
  );
  const originalProcessIds = elevatedVrProcesses
    ? await getRunningProcessIds(processNames)
    : new Set<number>();
  const names = processNames.map(toPowerShellString).join(", ");
  const result = await runCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        `$names = @(${names})`,
        "$failures = @()",
        "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in $names } | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { $failures += $_ } }",
        "Start-Sleep -Milliseconds 500",
        "$remaining = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in $names } | ForEach-Object ProcessName)",
        "if ($remaining.Count -gt 0) { $details = ($failures | ForEach-Object { $_.Exception.Message }) -join '; '; Write-Error ('Could not stop: ' + ($remaining -join ', ') + $(if ($details) { '. ' + $details } else { '' })); exit 1 }"
      ].join("; ")
    ],
    { timeoutMs: 10_000 }
  );

  if (result.code !== 0) {
    if (elevatedVrProcesses) {
      const cleanup = await runCommand(
        "schtasks.exe",
        ["/Run", "/TN", "RaphiiWinUtils VR Cleanup"],
        { timeoutMs: 10_000 }
      );
      if (cleanup.code === 0) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const remainingProcessIds = await getRunningProcessIds(processNames);
          if (![...originalProcessIds].some((id) => remainingProcessIds.has(id))) return;
        }
      }
    }
    throw new Error(`Windows process stop failed: ${result.stderr.trim() || result.code}`);
  }
}

async function getRunningProcessIds(processNames: string[]): Promise<Set<number>> {
  const names = processNames.map(toPowerShellString).join(", ");
  const result = await runCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @(${names}) } | ForEach-Object Id`
    ],
    { timeoutMs: 10_000 }
  );
  if (result.code !== 0)
    throw new Error(`Windows process query failed: ${result.stderr.trim() || result.code}`);
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map(Number)
      .filter(Number.isInteger)
  );
}

function toPowerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
