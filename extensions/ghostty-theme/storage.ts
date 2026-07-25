import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MAX_THEME_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 8 * 1024;
const STATE_FILE = "ghostty-theme.json";

function statePath(): string {
  return join(getAgentDir(), STATE_FILE);
}

export async function readThemeFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("theme source is not a regular file");
  if (info.size > MAX_THEME_BYTES) {
    throw new Error(`theme source exceeds ${MAX_THEME_BYTES} bytes`);
  }
  const value = await readFile(path, "utf8");
  if (Buffer.byteLength(value) > MAX_THEME_BYTES) {
    throw new Error(`theme source exceeds ${MAX_THEME_BYTES} bytes`);
  }
  return value;
}

export function writeToTerminal(value: string): void {
  process.stdout.write(value);
}

function errnoSuffix(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
    ? ` (${code})`
    : "";
}

class StateFileError extends Error {
  override readonly name = "StateFileError";
}

export async function loadSelectionFile(
  path: string,
): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new StateFileError(
      `saved theme state could not be opened${errnoSuffix(error)}`,
    );
  }

  try {
    const info = await file.stat();
    if (!info.isFile()) {
      throw new StateFileError("saved theme state is not a regular file");
    }
    if (info.size > MAX_STATE_BYTES) {
      throw new StateFileError(
        `saved theme state exceeds ${MAX_STATE_BYTES} bytes`,
      );
    }

    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_STATE_BYTES) {
      throw new StateFileError(
        `saved theme state exceeds ${MAX_STATE_BYTES} bytes`,
      );
    }

    const content = buffer.subarray(0, bytesRead).toString("utf8");
    if (!content.trim()) return undefined;

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new StateFileError("saved theme state contains invalid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new StateFileError("saved theme state has an unsupported format");
    }
    const theme = (value as { theme?: unknown }).theme;
    if (typeof theme !== "string" || !theme.trim()) {
      throw new StateFileError("saved theme state has an unsupported format");
    }
    return theme.trim();
  } catch (error) {
    if (error instanceof StateFileError) throw error;
    throw new StateFileError(
      `saved theme state could not be read${errnoSuffix(error)}`,
    );
  } finally {
    await file.close().catch(() => undefined);
  }
}

export async function saveSelectionFile(
  path: string,
  name: string | undefined,
): Promise<void> {
  if (!name) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new StateFileError(
          `saved theme state could not be cleared${errnoSuffix(error)}`,
        );
      }
    }
    return;
  }

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    throw new StateFileError(
      `saved theme state directory could not be created${errnoSuffix(error)}`,
    );
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ theme: name }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, path);
    renamed = true;
  } catch (error) {
    throw new StateFileError(
      `saved theme state could not be saved${errnoSuffix(error)}`,
    );
  } finally {
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch {
        // Preserve the primary write or rename failure.
      }
    }
  }
}

export async function loadSavedSelection(): Promise<string | undefined> {
  return loadSelectionFile(statePath());
}

export async function saveSavedSelection(
  name: string | undefined,
): Promise<void> {
  return saveSelectionFile(statePath(), name);
}
