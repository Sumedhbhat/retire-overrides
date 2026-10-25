import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandFailedError extends Error {
  readonly result: RunResult;
  readonly command: string;
  constructor(command: string, result: RunResult) {
    super(`\`${command}\` exited with ${result.code}: ${tail(result.stderr || result.stdout)}`);
    this.command = command;
    this.result = result;
  }
}

export function tail(text: string, lines = 12): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  input?: string;
  /** Resolve with the result instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
  timeoutMs?: number;
}

export function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 10 * 60_000);
    timer.unref();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new CommandFailedError([command, ...args].join(" "), result));
      } else {
        resolve(result);
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}
