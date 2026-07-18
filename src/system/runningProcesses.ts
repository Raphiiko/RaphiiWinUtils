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

function toPowerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
