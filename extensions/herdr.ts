import { execFileSync } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runBoundedCommand } from "./catalog.js";
import type { GhosttyTheme } from "./ghostty.js";

const HERDR_DETECTION_CACHE_MS = 30_000;
const HERDR_RELOAD_TIMEOUT_MS = 3_000;
const CHROME_BACKUP_FILE = "ghostty-herdr-chrome.json";
const MANAGED_CHROME_KEYS = [
  "accent",
  "panel_bg",
  "sidebar_bg",
  "active_row_bg",
  "selection_bg",
  "surface0",
  "surface1",
  "surface_dim",
  "overlay0",
  "overlay1",
  "text",
  "subtext0",
  "mauve",
  "green",
  "yellow",
  "red",
  "blue",
  "teal",
  "peach",
] as const;

export type ManagedChromeKey = (typeof MANAGED_CHROME_KEYS)[number];
export type ChromeColors = Record<ManagedChromeKey, string>;
export type ChromeBackup = Partial<Record<ManagedChromeKey, string>>;

export interface HerdrClientInfo {
  tty: string | undefined;
  ghostty: boolean;
}

interface DetectionCache {
  at: number;
  listing: string;
}

let detectionCache: DetectionCache | undefined;

export function isHerdrClientCommand(line: string): boolean {
  const tokens = line.trim().split(/\s+/);
  const [binary, next] = tokens;
  if (!binary || !/(^|\/)herdr$/.test(binary)) return false;
  // A bare word after the binary is a subcommand ("server", "api", ...);
  // the client runs as just "herdr" with optional flags.
  if (next && !next.startsWith("-") && !next.includes("=")) return false;
  return true;
}

function isGhosttyEnv(args: string): boolean {
  const program = /(?:^|\s)TERM_PROGRAM=([^\s]+)/.exec(args)?.[1];
  const term = /(?:^|\s)TERM=([^\s]+)/.exec(args)?.[1];
  return (
    program?.trim().toLowerCase() === "ghostty" ||
    term?.trim().toLowerCase() === "xterm-ghostty" ||
    term?.trim().toLowerCase() === "ghostty"
  );
}

export function parseHerdrClients(listing: string): HerdrClientInfo[] {
  const clients: HerdrClientInfo[] = [];
  for (const rawLine of listing.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const split = /^(\S+)\s+(.*)$/.exec(line);
    if (!split) continue;
    const [, ttyToken, args] = split;
    if (!args || !isHerdrClientCommand(args)) continue;
    clients.push({
      tty: ttyToken === "??" || ttyToken === "?" ? undefined : ttyToken,
      ghostty: isGhosttyEnv(args),
    });
  }
  return clients;
}

export function ttyDevicePath(tty: string): string {
  if (tty.startsWith("/")) return tty;
  return `/dev/${tty}`;
}

function listHerdrProcesses(): string {
  const now = Date.now();
  if (detectionCache && now - detectionCache.at < HERDR_DETECTION_CACHE_MS) {
    return detectionCache.listing;
  }
  let listing = "";
  try {
    listing = execFileSync("ps", ["eww", "-A", "-o", "tty=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    });
  } catch {
    listing = "";
  }
  detectionCache = { at: now, listing };
  return listing;
}

export function herdrClientUsesGhostty(): boolean {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return false;
  }
  return parseHerdrClients(listHerdrProcesses()).some(
    (client) => client.ghostty,
  );
}

export function herdrHostTtyDevices(listing: string): string[] {
  const devices: string[] = [];
  const seen = new Set<string>();
  for (const client of parseHerdrClients(listing)) {
    if (!client.ghostty || !client.tty) continue;
    const device = ttyDevicePath(client.tty);
    if (seen.has(device)) continue;
    seen.add(device);
    devices.push(device);
  }
  return devices;
}

export function writeToTtyDevice(device: string, value: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(device, "r+");
    writeSync(fd, value);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeToHerdrHostTerminals(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!env.HERDR_ENV?.trim()) return;
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  for (const device of herdrHostTtyDevices(listHerdrProcesses())) {
    try {
      writeToTtyDevice(device, value);
    } catch {
      // Host OSC must never break pane application.
    }
  }
}

function parseHex(color: string): [number, number, number] {
  const value = color.replace(/^#/, "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function formatHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0"),
    )
    .join("")}`;
}

export function mixHex(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return formatHex(
    Math.round(ar + (br - ar) * amount),
    Math.round(ag + (bg - ag) * amount),
    Math.round(ab + (bb - ab) * amount),
  );
}

export function chromeColorsFromTheme(theme: GhosttyTheme): ChromeColors {
  const background = theme.background;
  const foreground = theme.foreground;
  const red = theme.palette[1];
  const green = theme.palette[2];
  const yellow = theme.palette[3];
  const blue = theme.palette[4];
  const magenta = theme.palette[5];
  const cyan = theme.palette[6];
  const brightBlack = theme.palette[8];
  const brightRed = theme.palette[9];
  const brightBlue = theme.palette[12];
  return {
    accent: brightBlue,
    panel_bg: background,
    sidebar_bg: background,
    active_row_bg: mixHex(background, foreground, 0.08),
    selection_bg: mixHex(background, blue, 0.28),
    surface0: mixHex(background, foreground, 0.12),
    surface1: mixHex(background, foreground, 0.2),
    surface_dim: mixHex(background, foreground, 0.06),
    overlay0: brightBlack,
    overlay1: mixHex(brightBlack, foreground, 0.35),
    text: foreground,
    subtext0: mixHex(foreground, background, 0.35),
    mauve: magenta,
    green,
    yellow,
    red,
    blue,
    teal: cyan,
    peach: brightRed === red ? yellow : brightRed,
  };
}

function tableName(line: string): string | undefined {
  const trimmed = line.trim();
  if (
    !trimmed.startsWith("[") ||
    !trimmed.endsWith("]") ||
    trimmed.startsWith("[[")
  ) {
    return undefined;
  }
  return trimmed.slice(1, -1);
}

function isKeyAssignment(line: string, key: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith(`${key}=`) ||
    trimmed.startsWith(`${key} =`) ||
    trimmed.startsWith(`${key}\t`)
  );
}

export function upsertSectionValue(
  content: string,
  section: string,
  key: string,
  value: string,
): string {
  const lines = content.split("\n");
  const assignment = `${key} = ${value}`;
  const out: string[] = [];
  let inSection = false;
  let replaced = false;
  let sawSection = false;

  const flushInsert = (): void => {
    if (inSection && !replaced) {
      while (out.length && out[out.length - 1] === "") out.pop();
      out.push(assignment);
      replaced = true;
    }
  };

  for (const line of lines) {
    const table = tableName(line);
    if (table !== undefined) {
      flushInsert();
      inSection = table === section;
      if (inSection) sawSection = true;
      out.push(line);
      continue;
    }
    if (inSection && isKeyAssignment(line, key)) {
      out.push(assignment);
      replaced = true;
      continue;
    }
    out.push(line);
  }
  flushInsert();

  if (!sawSection) {
    while (out.length && out[out.length - 1] === "") out.pop();
    if (out.length) out.push("");
    out.push(`[${section}]`);
    out.push(assignment);
  }

  let next = out.join("\n");
  if (!next.endsWith("\n")) next += "\n";
  return next;
}

export function removeSectionKey(
  content: string,
  section: string,
  key: string,
): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const table = tableName(line);
    if (table !== undefined) {
      inSection = table === section;
      out.push(line);
      continue;
    }
    if (inSection && isKeyAssignment(line, key)) continue;
    out.push(line);
  }
  let next = out.join("\n");
  if (content.endsWith("\n") && !next.endsWith("\n")) next += "\n";
  return next;
}

export function readSectionValue(
  content: string,
  section: string,
  key: string,
): string | undefined {
  let inSection = false;
  for (const line of content.split("\n")) {
    const table = tableName(line);
    if (table !== undefined) {
      inSection = table === section;
      continue;
    }
    if (!inSection || !isKeyAssignment(line, key)) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    return line.slice(separator + 1).trim();
  }
  return undefined;
}

export function snapshotManagedChrome(content: string): ChromeBackup {
  const backup: ChromeBackup = {};
  for (const key of MANAGED_CHROME_KEYS) {
    const value = readSectionValue(content, "theme.custom", key);
    if (value !== undefined) backup[key] = value;
  }
  return backup;
}

export function applyChromeColors(
  content: string,
  colors: ChromeColors,
): string {
  let next = content;
  for (const key of MANAGED_CHROME_KEYS) {
    next = upsertSectionValue(next, "theme.custom", key, `"${colors[key]}"`);
  }
  return next;
}

export function restoreChromeColors(
  content: string,
  backup: ChromeBackup,
): string {
  let next = content;
  for (const key of MANAGED_CHROME_KEYS) {
    const original = backup[key];
    next =
      original === undefined
        ? removeSectionKey(next, "theme.custom", key)
        : upsertSectionValue(next, "theme.custom", key, original);
  }
  return next;
}

export function herdrConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_CONFIG_PATH?.trim()) return env.HERDR_CONFIG_PATH.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "herdr", "config.toml");
  return join(env.HOME?.trim() || homedir(), ".config", "herdr", "config.toml");
}

export function chromeBackupPath(): string {
  return join(getAgentDir(), CHROME_BACKUP_FILE);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadChromeBackup(
  path: string,
): Promise<ChromeBackup | undefined> {
  const content = await readText(path);
  if (!content?.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const backup: ChromeBackup = {};
  for (const key of MANAGED_CHROME_KEYS) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry === "string") backup[key] = entry;
  }
  return backup;
}

async function saveChromeBackup(
  path: string,
  backup: ChromeBackup,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(backup, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function reloadHerdrConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = env.HERDR_BIN_PATH?.trim() || "herdr";
  const result = await runBoundedCommand(command, ["server", "reload-config"], {
    timeoutMs: HERDR_RELOAD_TIMEOUT_MS,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 8 * 1024,
  });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || "herdr server reload-config failed",
    );
  }
}

export interface HerdrChromeHost {
  env(): NodeJS.ProcessEnv;
  configPath?(): string;
  backupPath?(): string;
  reload?(): Promise<void>;
}

export async function syncHerdrChrome(
  theme: GhosttyTheme | undefined,
  host: HerdrChromeHost = { env: () => process.env },
): Promise<void> {
  const env = host.env();
  if (!env.HERDR_ENV?.trim()) return;

  const configPath = host.configPath?.() ?? herdrConfigPath(env);
  const backupPath = host.backupPath?.() ?? chromeBackupPath();
  const original = await readText(configPath);
  if (original === undefined) return;

  const existingBackup = await loadChromeBackup(backupPath);
  let next: string;

  if (theme) {
    if (!existingBackup) {
      await saveChromeBackup(backupPath, snapshotManagedChrome(original));
    }
    next = applyChromeColors(original, chromeColorsFromTheme(theme));
  } else {
    if (!existingBackup) return;
    next = restoreChromeColors(original, existingBackup);
  }

  if (next !== original) {
    await writeFile(configPath, next);
    await (host.reload?.() ?? reloadHerdrConfig(env));
  }

  if (!theme) {
    try {
      await unlink(backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
