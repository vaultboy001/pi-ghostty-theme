import { basename } from "node:path";
import { X11_COLORS } from "./x11-colors.js";

const ST = "\x1b\\";
const HEX = /^#?[0-9a-f]{6}$/i;

function isUnsafeThemeControl(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f)
  );
}

export function hasUnsafeThemeControls(value: string): boolean {
  for (const character of value) {
    if (isUnsafeThemeControl(character.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

export function escapeTerminalControls(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    escaped += isUnsafeThemeControl(codePoint)
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
  }
  return escaped;
}

export function quoteForUi(value: string): string {
  return escapeTerminalControls(JSON.stringify(value));
}

export interface ThemeSource {
  name: string;
  path: string;
  origin: string;
}

type BasePalette = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

export interface GhosttyTheme {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  palette: BasePalette;
}

export function parseThemeList(output: string): ThemeSource[] {
  const themes = new Map<string, ThemeSource>();
  for (const rawLine of output.split(/\r?\n/)) {
    if (hasUnsafeThemeControls(rawLine)) continue;
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(.*?) \((resources|user)\) (.+)$/.exec(line);
    if (!match) continue;
    const [, name, origin, path] = match;
    if (
      !name ||
      !origin ||
      !path ||
      basename(path) !== name ||
      themes.has(name)
    ) {
      continue;
    }
    themes.set(name, { name, origin, path });
  }
  return [...themes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeGhosttyColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const unquoted = value.trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, "$1$2");
  if (hasUnsafeThemeControls(unquoted)) return undefined;
  if (HEX.test(unquoted)) {
    return `#${unquoted.replace(/^#/, "").toLowerCase()}`;
  }
  const key = unquoted.replace(/ +/g, "").toLowerCase();
  return X11_COLORS.get(key);
}

export function parseGhosttyTheme(name: string, content: string): GhosttyTheme {
  const values = new Map<string, string>();
  const palette = new Map<number, string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (key === "palette") {
      const paletteSeparator = value.indexOf("=");
      if (paletteSeparator < 0) continue;
      const index = Number(value.slice(0, paletteSeparator).trim());
      const color = normalizeGhosttyColor(value.slice(paletteSeparator + 1));
      if (Number.isInteger(index) && index >= 0 && index <= 15 && color) {
        palette.set(index, color);
      }
      continue;
    }

    values.set(key, value);
  }

  const background = normalizeGhosttyColor(values.get("background"));
  const foreground = normalizeGhosttyColor(values.get("foreground"));
  if (!background || !foreground) {
    throw new Error("theme must define exact background and foreground colors");
  }

  const colors = Array.from({ length: 16 }, (_, index) => palette.get(index));
  if (colors.some((color) => !color)) {
    throw new Error("theme must define exact palette colors 0 through 15");
  }
  const basePalette = colors as BasePalette;

  return {
    name,
    background,
    foreground,
    cursor: normalizeGhosttyColor(values.get("cursor-color")) ?? foreground,
    palette: basePalette,
  };
}

function rgbSpec(hex: string): string {
  const value = hex.slice(1);
  return `rgb:${value.slice(0, 2)}/${value.slice(2, 4)}/${value.slice(4, 6)}`;
}

export function themeSequence(theme: GhosttyTheme): string {
  const palette = theme.palette
    .map((color, index) => `${index};${rgbSpec(color)}`)
    .join(";");
  return [
    `\x1b]4;${palette}${ST}`,
    `\x1b]10;${rgbSpec(theme.foreground)}${ST}`,
    `\x1b]11;${rgbSpec(theme.background)}${ST}`,
    `\x1b]12;${rgbSpec(theme.cursor)}${ST}`,
  ].join("");
}

export function resetSequence(): string {
  const palette = Array.from({ length: 16 }, (_, index) => index).join(";");
  return `\x1b]104;${palette}${ST}\x1b]110${ST}\x1b]111${ST}\x1b]112${ST}`;
}
