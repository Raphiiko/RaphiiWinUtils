import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; windowsHide?: boolean; input?: string } = {}
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: options.windowsHide ?? true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      // stdout and stderr are always pipes; only stdin varies, and it is used defensively below.
    }) as ChildProcessWithoutNullStreams;

    if (options.input !== undefined) {
      // Write errors surface through the exit code and stderr; a closed stdin must not throw here.
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input, "utf8");
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

// Launch a long-lived process (e.g. steam.exe, which stays resident and never
// exits) and resolve once it has spawned. Unlike runCommand, this does NOT wait
// for exit — awaiting exit on a resident GUI process always times out. Readiness
// is polled separately by the caller.
export async function launchDetached(
  command: string,
  args: string[],
  options: { cwd?: string; windowsHide?: boolean } = {}
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: options.windowsHide ?? true,
      detached: true,
      stdio: "ignore"
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

export async function requireSuccess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; windowsHide?: boolean; input?: string } = {}
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      [
        `Command failed with code ${result.code}: ${command} ${args.join(" ")}`,
        result.stdout.trim(),
        result.stderr.trim()
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return result;
}
