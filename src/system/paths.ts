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
  const runtimeHelper = join(getRuntimeRoot(), "helpers", "AudioEndpointWatcher", "AudioEndpointWatcher.exe");
  if (existsSync(runtimeHelper)) return runtimeHelper;

  const devHelper = join(process.cwd(), "dist", "helpers", "AudioEndpointWatcher", "AudioEndpointWatcher.exe");
  if (existsSync(devHelper)) return devHelper;

  return runtimeHelper;
}
