import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { GhosttyTheme } from "./ghostty.js";

type ThemeBackground =
  | "selectedBg"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

export type ThemeConstructor = new (
  foregrounds: Record<ThemeColor, string | number>,
  backgrounds: Record<ThemeBackground, string | number>,
  mode: "truecolor" | "256color",
  options?: { name?: string; sourcePath?: string },
) => Theme;

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function mix(base: string, tint: string, amount: number): string {
  const [baseRed, baseGreen, baseBlue] = channels(base);
  const [tintRed, tintGreen, tintBlue] = channels(tint);
  const value = [
    Math.round(baseRed * (1 - amount) + tintRed * amount),
    Math.round(baseGreen * (1 - amount) + tintGreen * amount),
    Math.round(baseBlue * (1 - amount) + tintBlue * amount),
  ];
  return `#${value.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function createPiTheme(
  native: GhosttyTheme,
  ThemeClass: ThemeConstructor,
): Theme {
  const [, red, green, yellow, blue, magenta, cyan, , , brightRed] =
    native.palette;
  const muted = mix(native.foreground, native.background, 0.45);
  const dim = mix(native.foreground, native.background, 0.62);
  const foregrounds: Record<ThemeColor, string> = {
    accent: blue,
    border: muted,
    borderAccent: cyan,
    borderMuted: dim,
    success: green,
    error: red,
    warning: yellow,
    muted,
    dim,
    text: native.foreground,
    thinkingText: magenta,
    userMessageText: native.foreground,
    customMessageText: native.foreground,
    customMessageLabel: magenta,
    toolTitle: blue,
    toolOutput: native.foreground,
    mdHeading: yellow,
    mdLink: cyan,
    mdLinkUrl: muted,
    mdCode: blue,
    mdCodeBlock: native.foreground,
    mdCodeBlockBorder: muted,
    mdQuote: muted,
    mdQuoteBorder: magenta,
    mdHr: dim,
    mdListBullet: cyan,
    toolDiffAdded: green,
    toolDiffRemoved: red,
    toolDiffContext: muted,
    syntaxComment: muted,
    syntaxKeyword: magenta,
    syntaxFunction: green,
    syntaxVariable: native.foreground,
    syntaxString: yellow,
    syntaxNumber: magenta,
    syntaxType: cyan,
    syntaxOperator: red,
    syntaxPunctuation: muted,
    thinkingOff: dim,
    thinkingMinimal: muted,
    thinkingLow: cyan,
    thinkingMedium: blue,
    thinkingHigh: magenta,
    thinkingXhigh: red,
    thinkingMax: brightRed,
    bashMode: green,
  };
  const backgrounds: Record<ThemeBackground, string> = {
    selectedBg: native.selectionBackground,
    userMessageBg: mix(native.background, blue, 0.11),
    customMessageBg: mix(native.background, magenta, 0.1),
    toolPendingBg: mix(native.background, blue, 0.08),
    toolSuccessBg: mix(native.background, green, 0.1),
    toolErrorBg: mix(native.background, red, 0.1),
  };
  return new ThemeClass(foregrounds, backgrounds, "truecolor", {
    name: `Ghostty · ${native.name}`,
  });
}
