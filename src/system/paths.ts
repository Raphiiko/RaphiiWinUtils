import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function getRuntimeRoot(): string {
  if (process.env.RAPHII_WIN_UTILS_ROOT) return process.env.RAPHII_WIN_UTILS_ROOT;

  const execPath = process.execPath;
  if (execPath.toLowerCase().endsWith("raphiiwinutils.exe")) {
    return dirname(execPath);
  }

  return process.cwd();
}

export function getHelperPath(): string {
  return getRuntimeHelperPath("AudioEndpointWatcher", "AudioEndpointWatcher.exe");
}

export function getClipboardHelperPath(): string {
  return getRuntimeHelperPath("ClipboardWatcher", "ClipboardWatcher.exe");
}

function getRuntimeHelperPath(helperDirName: string, exeName: string): string {
  const runtimeHelper = join(getRuntimeRoot(), "helpers", helperDirName, exeName);
  if (existsSync(runtimeHelper)) return runtimeHelper;

  const devHelper = join(process.cwd(), "dist", "helpers", helperDirName, exeName);
  if (existsSync(devHelper)) return devHelper;

  return runtimeHelper;
}

export function getSnoreToastPath(): string {
  const runtimeHelper = join(getRuntimeRoot(), "helpers", "SnoreToast", "snoretoast.exe");
  if (existsSync(runtimeHelper)) return runtimeHelper;

  const devHelper = join(process.cwd(), "dist", "helpers", "SnoreToast", "snoretoast.exe");
  if (existsSync(devHelper)) return devHelper;

  return runtimeHelper;
}
