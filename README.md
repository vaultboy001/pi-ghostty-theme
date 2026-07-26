# pi-ghostty-theme

<p align="center">
  <img src="https://raw.githubusercontent.com/vaultboy001/pi-ghostty-theme/main/assets/banner.svg" alt="pi-ghostty-theme" width="100%" />
</p>

[![npm version](https://img.shields.io/npm/v/pi-ghostty-theme)](https://www.npmjs.com/package/pi-ghostty-theme)
[![pi.dev gallery](https://img.shields.io/badge/pi.dev-package-7aa2f7)](https://pi.dev/packages/pi-ghostty-theme)
[![license: MIT](https://img.shields.io/badge/license-MIT-9ece6a)](LICENSE)

Choose and live-preview native Ghostty themes from inside Pi without replacing Pi's own `dark`, `light`, or custom theme.

<p align="center">
  <img src="https://raw.githubusercontent.com/vaultboy001/pi-ghostty-theme/main/assets/demo.gif" alt="Live demo of the /ghostty-theme picker" width="100%" />
</p>

## Requirements

- Pi `0.82.0` or a newer compatible release
- Node.js `>=22.19.0`
- Ghostty `>=1.2.0`
- A direct Ghostty TTY; tmux and GNU screen are intentionally unsupported

## Install

```bash
pi install npm:pi-ghostty-theme
```

Restart Pi or run `/reload`. To try it without installing:

```bash
pi -e npm:pi-ghostty-theme
```

## Use

Open the searchable picker:

```text
/ghostty-theme
```

- Type to search Ghostty's installed themes.
- Use `↑` / `↓` for live terminal preview.
- Press `Enter` to save the choice.
- Press `Esc` to restore the previous Ghostty choice.

Apply a theme directly:

```text
/ghostty-theme Monokai Pro
```

Other commands:

```text
/ghostty-theme status
/ghostty-theme reset
/ghostty-theme off
```

`status`, `reset`, and `off` do not require successful theme-catalog discovery. `reset` and `off` clear the saved choice and restore only terminal color state still owned by this extension. They never change Pi's theme.

If terminal cleanup is requested from an inactive or non-TUI context, it is deferred and reported instead of sending OSC to that output stream. TUI and RPC report through Pi notifications; JSON and print modes write plain diagnostics to stderr so stdout remains protocol-safe. A saved choice that could not be cleared may apply again the next time Pi starts.

## Pi and Ghostty themes stay independent

Ghostty controls the terminal surface: its default background and foreground, ANSI colors 0–15, and cursor color. Pi separately controls application-level semantic colors such as accents, borders, Markdown, tool output, and status colors.

This extension changes only the Ghostty layer. Pi's `/settings` Theme menu continues to preview and save `dark`, `light`, automatic light/dark pairs, and custom Pi themes normally. In automatic mode, Pi may choose its light or dark branch from the background reported by the currently applied Ghostty theme; the extension still does not call Pi's theme API.

A Ghostty change can also affect terminal defaults used by Pi—for example the base background, a Pi token configured as the default color (`""`), or ANSI palette colors. Explicit RGB colors from the active Pi theme remain Pi-controlled.

## How it works

1. Ghostty supplies the theme catalog through `ghostty +list-themes --plain --path`. The fixed-argument subprocess has a five-second timeout, captures at most 1 MiB of stdout and 8 KiB of stderr, and is force-killed if it ignores termination.
2. The selected native theme file supplies background, foreground, cursor, and ANSI colors 0–15 as six-digit RGB values or Ghostty-supported named X11 colors. Named colors are normalized to RGB before OSC generation.
3. The extension sends one OSC batch to the current Ghostty surface. It does not call Pi's theme API.
4. The selected name is stored in `~/.pi/agent/ghostty-theme.json` and reapplied when Pi starts or reloads. A missing file is normal; corrupt, oversized, non-regular, or unreadable state is reported and skipped.
5. Shutdown waits for mutations already committing, invalidates pending reads and previews, and resets the terminal color overrides.

There is no polling loop, periodic reassertion, copied theme catalog, Pi settings rewrite, or Ghostty config rewrite.

## Scope and limitations

- Changes apply to the Ghostty tab or pane running Pi, not every Ghostty window.
- Ghostty's runtime color protocol covers background, foreground, cursor, and the ANSI palette. It does not expose a per-surface native-theme command, so selection colors, opacity, images, padding, fonts, and window chrome are not changed.
- Pi themes remain independent. Selecting or previewing a Pi theme does not change the saved Ghostty theme, and selecting a Ghostty theme does not change Pi's theme.
- Theme names containing C0, DEL, or C1 terminal-control characters are ignored. The catalog parser also requires the displayed name to match the source filename, preventing newline-based record injection.
- Theme colors accept six-digit RGB and Ghostty's named X11 colors. CSS color functions, dynamic values such as `cell-foreground`, and unknown names are rejected.
- OSC overrides are terminal state. A crash or `SIGKILL` can prevent cleanup; closing the surface or reloading Ghostty configuration restores configured defaults.
- The extension stays inactive outside Pi's TUI, when stdout is not a TTY, in non-Ghostty terminals, and under tmux or GNU screen. It emits no OSC bytes in JSON, RPC, or print modes.
- Custom Ghostty themes are configuration files. Only select themes you trust.

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

## License

MIT
