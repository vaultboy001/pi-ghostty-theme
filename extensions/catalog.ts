import { spawn } from "node:child_process";

const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_CATALOG_DIAGNOSTIC_BYTES = 8 * 1024;
const CATALOG_TIMEOUT_MS = 5000;
const FORCE_KILL_DELAY_MS = 250;

export interface BoundedCommandOptions {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface BoundedCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  signal: NodeJS.Signals | null;
}

export type ThemeCatalogLoader = () => Promise<string>;

function validateBound(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

export function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  validateBound("timeoutMs", options.timeoutMs);
  validateBound("maxStdoutBytes", options.maxStdoutBytes);
  validateBound("maxStderrBytes", options.maxStderrBytes);

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    const terminate = (error: Error): void => {
      if (failure) return;
      failure = error;
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, FORCE_KILL_DELAY_MS);
    };

    const append = (
      chunk: Buffer | string,
      output: "stdout" | "stderr",
    ): void => {
      if (failure) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const current = output === "stdout" ? stdoutBytes : stderrBytes;
      const maximum =
        output === "stdout" ? options.maxStdoutBytes : options.maxStderrBytes;
      if (buffer.length > maximum - current) {
        terminate(new Error(`${command} ${output} exceeded ${maximum} bytes`));
        return;
      }
      if (output === "stdout") {
        stdoutBytes += buffer.length;
        stdoutChunks.push(buffer);
      } else {
        stderrBytes += buffer.length;
        stderrChunks.push(buffer);
      }
    };

    const timeoutTimer = setTimeout(() => {
      terminate(
        new Error(`${command} timed out after ${options.timeoutMs} ms`),
      );
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) =>
      append(chunk, "stdout"),
    );
    child.stderr.on("data", (chunk: Buffer | string) =>
      append(chunk, "stderr"),
    );
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(
        failure ?? new Error(`failed to start ${command}: ${error.message}`),
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (failure) {
        reject(failure);
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
        code: code ?? 1,
        signal,
      });
    });
  });
}

export async function loadGhosttyThemeCatalog(): Promise<string> {
  const result = await runBoundedCommand(
    "ghostty",
    ["+list-themes", "--plain", "--path"],
    {
      timeoutMs: CATALOG_TIMEOUT_MS,
      maxStdoutBytes: MAX_CATALOG_BYTES,
      maxStderrBytes: MAX_CATALOG_DIAGNOSTIC_BYTES,
    },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "ghostty +list-themes failed");
  }
  return result.stdout;
}
