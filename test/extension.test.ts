import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runBoundedCommand } from "../extensions/ghostty-theme/catalog.js";
import {
  type GhosttyTheme,
  parseGhosttyTheme,
  parseThemeList,
  resetSequence,
  themeSequence,
} from "../extensions/ghostty-theme/ghostty.js";
import {
  createExtension,
  type Host,
  inactiveReason,
} from "../extensions/ghostty-theme/index.js";
import {
  loadSelectionFile,
  saveSelectionFile,
} from "../extensions/ghostty-theme/storage.js";
import { X11_COLORS } from "../extensions/ghostty-theme/x11-colors.js";

const COLORS = [
  "#2d2a2e",
  "#ff6188",
  "#a9dc76",
  "#ffd866",
  "#fc9867",
  "#ab9df2",
  "#78dce8",
  "#fcfcfa",
  "#727072",
  "#ff6188",
  "#a9dc76",
  "#ffd866",
  "#fc9867",
  "#ab9df2",
  "#78dce8",
  "#fcfcfa",
];

function themeText(overrides: string[] = []): string {
  return [
    ...COLORS.map((color, index) => `palette = ${index}=${color}`),
    "background = #2d2a2e",
    "foreground = #fcfcfa",
    "cursor-color = #c1c0c0",
    ...overrides,
  ].join("\n");
}

const sourceList = [
  "Black Metal (Bathory) (resources) /themes/Black Metal (Bathory)",
  "Monokai Pro (resources) /themes/Monokai Pro",
].join("\n");

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function hasTerminalControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f)
    );
  });
}

function nativeTheme(name = "Monokai Pro"): GhosttyTheme {
  return parseGhosttyTheme(name, themeText());
}

interface Fixture {
  host: Host;
  selection?: string;
  saves: Array<string | undefined>;
  writes: string[];
  diagnostics: string[];
  files: Map<string, string>;
}

function fixture(selection?: string): Fixture {
  const value: Fixture = {
    selection,
    saves: [],
    writes: [],
    diagnostics: [],
    files: new Map([
      ["/themes/Monokai Pro", themeText()],
      ["/themes/Black Metal (Bathory)", themeText()],
    ]),
    host: undefined as unknown as Host,
  };
  value.host = {
    env: () => ({ TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" }),
    tty: () => true,
    readTheme: async (path) => {
      const content = value.files.get(path);
      if (!content) throw new Error("missing fixture theme");
      return content;
    },
    writeTerminal: (output) => value.writes.push(output),
    writeDiagnostic: (output) => value.diagnostics.push(output),
    loadSelection: async () => value.selection,
    saveSelection: async (name) => {
      value.selection = name;
      value.saves.push(name);
    },
  };
  return value;
}

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
type Command = {
  handler(args: string, ctx: ExtensionContext): Promise<void>;
  getArgumentCompletions?(
    prefix: string,
  ): Array<{ value: string; label: string }> | null;
};

function piTheme(name = "Baseline", accent = "#8abeb7"): Theme {
  const ansi = (hex: string): string => {
    const channels = [1, 3, 5].map((offset) =>
      Number.parseInt(hex.slice(offset, offset + 2), 16),
    );
    return `\u001b[38;2;${channels.join(";")}m`;
  };
  const foregrounds = new Map<string, string>([
    ["accent", ansi(accent)],
    ["muted", ansi("#808080")],
    ["dim", ansi("#606060")],
    ["warning", ansi("#f0c674")],
  ]);
  const defaultForeground = ansi("#c5c8c6");
  const defaultBackground = "\u001b[48;2;29;31;33m";

  return {
    name: `Pi · ${name}`,
    fg: (color: string, text: string) =>
      `${foregrounds.get(color) ?? defaultForeground}${text}\u001b[39m`,
    bg: (_color: string, text: string) =>
      `${defaultBackground}${text}\u001b[49m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    getFgAnsi: (color: string) => foregrounds.get(color) ?? defaultForeground,
    getBgAnsi: () => defaultBackground,
  } as unknown as Theme;
}

function baselineTheme(): Theme {
  return piTheme();
}

interface PickerComponent {
  render?(width: number): string[];
  invalidate?(): void;
  handleInput?(data: string): void;
}

type PickerFactory = (
  tui: { requestRender(): void },
  theme: Theme,
  keybindings: object,
  done: (value: string | null) => void,
) => PickerComponent;

interface ContextOptions {
  customSelection?: string | null;
  simulatePicker?: boolean;
  mode?: ExtensionContext["mode"];
  hasUI?: boolean;
  runPicker?: (
    component: PickerComponent,
    done: (value: string | null) => void,
  ) => Promise<void> | void;
}

function context(options: ContextOptions = {}) {
  let currentTheme = baselineTheme();
  const baseline = currentTheme;
  const mode = options.mode ?? "tui";
  let hasUI = options.hasUI ?? (mode === "tui" || mode === "rpc");
  const notifications: Array<{ message: string; level?: string }> = [];
  const setThemeCalls: Array<string | Theme> = [];
  const runCustom = async (
    factory: unknown,
  ): Promise<string | null | undefined> => {
    if (!options.simulatePicker && !options.runPicker) {
      return options.customSelection;
    }
    let finish: (value: string | null) => void = () => undefined;
    const result = new Promise<string | null>((resolve) => {
      finish = resolve;
    });
    const component = (factory as PickerFactory)(
      { requestRender: () => undefined },
      currentTheme,
      {},
      finish,
    );
    if (options.runPicker) {
      await options.runPicker(component, finish);
    } else {
      component.handleInput?.("\x1b[B");
      await new Promise<void>((resolve) => setImmediate(resolve));
      component.handleInput?.("\r");
    }
    return result;
  };
  const ctx = {
    mode,
    hasUI,
    ui: {
      get theme() {
        return currentTheme;
      },
      setTheme: (next: string | Theme) => {
        setThemeCalls.push(next);
        if (typeof next !== "string") currentTheme = next;
        return { success: true };
      },
      notify: (message: string, level?: string) => {
        if (hasUI) notifications.push({ message, level });
      },
      custom: runCustom,
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    baseline,
    notifications,
    setThemeCalls,
    get currentTheme() {
      return currentTheme;
    },
    setCurrentTheme(next: Theme) {
      currentTheme = next;
    },
    setMode(next: ExtensionContext["mode"]) {
      (ctx as unknown as { mode: ExtensionContext["mode"] }).mode = next;
      hasUI = next === "tui" || next === "rpc";
      (ctx as unknown as { hasUI: boolean }).hasUI = hasUI;
    },
  };
}

interface HarnessOptions {
  loadCatalog?: () => Promise<string>;
}

function harness(state: Fixture, options: HarnessOptions = {}) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  let catalogCalls = 0;
  const loadCatalog = async (): Promise<string> => {
    catalogCalls += 1;
    return options.loadCatalog ? options.loadCatalog() : sourceList;
  };
  const pi = {
    registerCommand: (name: string, command: Command) =>
      commands.set(name, command),
    on: (event: string, handler: Handler) => events.set(event, handler),
  } as unknown as ExtensionAPI;
  createExtension(state.host, loadCatalog)(pi);
  const start = events.get("session_start");
  const shutdown = events.get("session_shutdown");
  assert.ok(start);
  assert.ok(shutdown);
  return {
    start,
    shutdown,
    commands,
    get catalogCalls() {
      return catalogCalls;
    },
  };
}

function registered(app: ReturnType<typeof harness>, name: string): Command {
  const command = app.commands.get(name);
  assert.ok(command);
  return command;
}

test("activates only in a direct Ghostty TUI", () => {
  const ghostty = { TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" };
  assert.equal(inactiveReason("tui", true, ghostty), undefined);
  assert.match(inactiveReason("rpc", true, ghostty) ?? "", /TUI/);
  assert.match(inactiveReason("tui", false, ghostty) ?? "", /TTY/);
  assert.match(
    inactiveReason("tui", true, { ...ghostty, TMUX: "1" }) ?? "",
    /tmux/,
  );
  assert.match(
    inactiveReason("tui", true, { ...ghostty, STY: "1" }) ?? "",
    /screen/,
  );
  assert.match(
    inactiveReason("tui", true, { TERM: "xterm-256color" }) ?? "",
    /not Ghostty/,
  );
});

test("bounded process capture returns stdout, stderr, and exit metadata", async () => {
  const result = await runBoundedCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write('catalog'); process.stderr.write('diagnostic')",
    ],
    { timeoutMs: 1000, maxStdoutBytes: 64, maxStderrBytes: 64 },
  );

  assert.deepEqual(result, {
    stdout: "catalog",
    stderr: "diagnostic",
    code: 0,
    signal: null,
  });
});

test("bounded process capture rejects oversized stdout and stderr", async () => {
  await assert.rejects(
    runBoundedCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096))"],
      { timeoutMs: 1000, maxStdoutBytes: 64, maxStderrBytes: 64 },
    ),
    /stdout exceeded 64 bytes/,
  );
  await assert.rejects(
    runBoundedCommand(
      process.execPath,
      ["-e", "process.stderr.write('x'.repeat(4096))"],
      { timeoutMs: 1000, maxStdoutBytes: 64, maxStderrBytes: 64 },
    ),
    /stderr exceeded 64 bytes/,
  );
});

test("bounded process capture times out and force-kills an uncooperative child", async () => {
  const started = Date.now();
  await assert.rejects(
    runBoundedCommand(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMs: 50, maxStdoutBytes: 64, maxStderrBytes: 64 },
    ),
    /timed out after 50 ms/,
  );
  assert.ok(Date.now() - started < 2000);
});

test("bounded process timeout is not extended by a descendant holding pipes", async () => {
  const descendant = "setTimeout(() => {}, 1200)";
  const parent = [
    "const { spawn } = require('node:child_process')",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2] })`,
    "setInterval(() => {}, 1000)",
  ].join(";");
  const started = Date.now();

  await assert.rejects(
    runBoundedCommand(process.execPath, ["-e", parent], {
      timeoutMs: 50,
      maxStdoutBytes: 64,
      maxStderrBytes: 64,
    }),
    /timed out after 50 ms/,
  );
  assert.ok(
    Date.now() - started < 700,
    "a descendant-held pipe delayed timeout settlement",
  );
});

test("bounded process capture reports spawn failures without hanging", async () => {
  await assert.rejects(
    runBoundedCommand(
      `missing-ghostty-${process.pid}-${Date.now()}`,
      ["+list-themes"],
      { timeoutMs: 1000, maxStdoutBytes: 64, maxStderrBytes: 64 },
    ),
    /failed to start missing-ghostty/,
  );
});

test("parses Ghostty theme discovery output without breaking parenthesized names", () => {
  assert.deepEqual(parseThemeList(sourceList), [
    {
      name: "Black Metal (Bathory)",
      origin: "resources",
      path: "/themes/Black Metal (Bathory)",
    },
    {
      name: "Monokai Pro",
      origin: "resources",
      path: "/themes/Monokai Pro",
    },
  ]);
});

test("parses the Ghostty colors supported by the runtime protocol", () => {
  assert.deepEqual(nativeTheme(), {
    name: "Monokai Pro",
    background: "#2d2a2e",
    foreground: "#fcfcfa",
    cursor: "#c1c0c0",
    palette: COLORS,
  });
});

test("parses Ghostty named X11 colors into canonical RGB", () => {
  const parsed = parseGhosttyTheme(
    "named",
    themeText([
      "background = black",
      "foreground = Alice Blue",
      "palette = 0=gray42",
      "palette = 1=red",
      "cursor-color = rebeccapurple",
    ]),
  );

  assert.equal(parsed.background, "#000000");
  assert.equal(parsed.foreground, "#f0f8ff");
  assert.equal(parsed.palette[0], "#6b6b6b");
  assert.equal(parsed.palette[1], "#ff0000");
  assert.equal(parsed.cursor, "#663399");
});

test("the complete bundled X11 table stays canonical and parseable", () => {
  assert.equal(X11_COLORS.size, 666);
  for (const [name, expected] of X11_COLORS) {
    assert.match(name, /^[a-z0-9]+$/);
    assert.match(expected, /^#[0-9a-f]{6}$/);
    const parsed = parseGhosttyTheme(
      "named",
      themeText([`background = ${name}`]),
    );
    assert.equal(parsed.background, expected, name);
  }
});

test("rejects incomplete or unsupported native themes", () => {
  assert.throws(
    () => parseGhosttyTheme("bad", themeText(["background = not-a-color"])),
    /background and foreground/,
  );
  assert.throws(
    () =>
      parseGhosttyTheme(
        "bad",
        themeText().replace("palette = 15=#fcfcfa", "palette = 15=rgb(0 0 0)"),
      ),
    /palette colors 0 through 15/,
  );
  assert.throws(
    () => parseGhosttyTheme("bad", themeText(["foreground = red\u001b"])),
    /background and foreground/,
  );
});

test("builds one-shot full palette, foreground, background, and cursor OSC", () => {
  const sequence = themeSequence(nativeTheme());
  const esc = String.fromCharCode(27);
  assert.ok(sequence.startsWith(`${esc}]4;0;rgb:2d/2a/2e;`));
  assert.ok(sequence.includes(`15;rgb:fc/fc/fa${esc}\\`));
  assert.ok(sequence.includes(`${esc}]10;rgb:fc/fc/fa${esc}\\`));
  assert.ok(sequence.includes(`${esc}]11;rgb:2d/2a/2e${esc}\\`));
  assert.ok(sequence.endsWith(`${esc}]12;rgb:c1/c0/c0${esc}\\`));
  assert.equal(sequence.split(`${esc}]4;`).length - 1, 1);
});

test("resets only color overrides owned by the extension", () => {
  assert.equal(
    resetSequence(),
    "\x1b]104;0;1;2;3;4;5;6;7;8;9;10;11;12;13;14;15\x1b\\\x1b]110\x1b\\\x1b]111\x1b\\\x1b]112\x1b\\",
  );
});

test("applies a saved Ghostty theme without changing the Pi theme", async () => {
  const state = fixture("Monokai Pro");
  const app = harness(state);
  const view = context();
  const baseline = view.currentTheme;

  await app.start({}, view.ctx);

  assert.deepEqual(state.writes, [themeSequence(nativeTheme())]);
  assert.equal(view.currentTheme, baseline);
  assert.deepEqual(view.setThemeCalls, []);

  await app.shutdown({}, view.ctx);
  assert.equal(state.writes.at(-1), resetSequence());
  assert.equal(view.currentTheme, baseline);
});

test("reload resets and reapplies only the Ghostty terminal theme", async () => {
  const state = fixture("Monokai Pro");
  const app = harness(state);
  const view = context();
  const baseline = view.currentTheme;

  await app.start({ reason: "startup" }, view.ctx);
  await app.shutdown({ reason: "reload" }, view.ctx);
  await app.start({ reason: "reload" }, view.ctx);

  assert.deepEqual(state.writes, [
    themeSequence(nativeTheme()),
    resetSequence(),
    themeSequence(nativeTheme()),
  ]);
  assert.equal(view.currentTheme, baseline);
  assert.deepEqual(view.setThemeCalls, []);
});

test("shutdown invalidates an in-flight startup theme read", async () => {
  const state = fixture("Monokai Pro");
  let release: ((content: string) => void) | undefined;
  state.host.readTheme = () =>
    new Promise<string>((resolve) => {
      release = resolve;
    });
  const app = harness(state);
  const view = context();
  const baseline = view.currentTheme;
  const starting = app.start({}, view.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await app.shutdown({}, view.ctx);
  assert.ok(release);
  release(themeText());
  await starting;

  assert.deepEqual(state.writes, []);
  assert.equal(view.currentTheme, baseline);
});

test("direct command applies and persists a named theme", async () => {
  const state = fixture();
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);

  await registered(app, "ghostty-theme").handler("Monokai Pro", view.ctx);
  assert.equal(state.selection, "Monokai Pro");
  assert.deepEqual(state.saves, ["Monokai Pro"]);
  assert.equal(state.writes.at(-1), themeSequence(nativeTheme()));
  assert.match(
    view.notifications.at(-1)?.message ?? "",
    /now uses Monokai Pro/,
  );

  const completions = registered(app, "ghostty-theme").getArgumentCompletions?.(
    "mono",
  );
  assert.equal(completions?.[0]?.value, "Monokai Pro");
});

test("newer direct apply wins over an older delayed apply", async () => {
  const state = fixture();
  const readStarted = deferred<void>();
  const releaseRead = deferred<string>();
  state.host.readTheme = async (path) => {
    if (path.endsWith("Monokai Pro")) {
      readStarted.resolve(undefined);
      return releaseRead.promise;
    }
    const content = state.files.get(path);
    if (!content) throw new Error("missing fixture theme");
    return content;
  };
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);
  const command = registered(app, "ghostty-theme");

  const older = command.handler("Monokai Pro", view.ctx);
  await readStarted.promise;
  await command.handler("Black Metal (Bathory)", view.ctx);
  releaseRead.resolve(themeText());
  await older;

  assert.equal(state.selection, "Black Metal (Bathory)");
  assert.deepEqual(state.saves, ["Black Metal (Bathory)"]);
  assert.equal(state.writes.length, 1);
  assert.equal(view.currentTheme, view.baseline);
  assert.deepEqual(view.setThemeCalls, []);
});

test("reset invalidates an older apply still reading its theme", async () => {
  const state = fixture();
  const readStarted = deferred<void>();
  const releaseRead = deferred<string>();
  state.host.readTheme = async (path) => {
    if (path.endsWith("Monokai Pro")) {
      readStarted.resolve(undefined);
      return releaseRead.promise;
    }
    const content = state.files.get(path);
    if (!content) throw new Error("missing fixture theme");
    return content;
  };
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);
  const command = registered(app, "ghostty-theme");

  const applying = command.handler("Monokai Pro", view.ctx);
  await readStarted.promise;
  await command.handler("reset", view.ctx);
  releaseRead.resolve(themeText());
  await applying;

  assert.equal(state.selection, undefined);
  assert.deepEqual(state.saves, [undefined]);
  assert.deepEqual(state.writes, []);
  assert.equal(view.currentTheme, view.baseline);
});

test("reset follows an apply whose persistence commit is already running", async () => {
  const state = fixture();
  const saveStarted = deferred<void>();
  const releaseSave = deferred<void>();
  state.host.saveSelection = async (name) => {
    if (name === "Monokai Pro") {
      saveStarted.resolve(undefined);
      await releaseSave.promise;
    }
    state.selection = name;
    state.saves.push(name);
  };
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);
  const command = registered(app, "ghostty-theme");

  const applying = command.handler("Monokai Pro", view.ctx);
  await saveStarted.promise;
  const resetting = command.handler("reset", view.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseSave.resolve(undefined);
  await Promise.all([applying, resetting]);

  assert.equal(state.selection, undefined);
  assert.deepEqual(state.saves, ["Monokai Pro", undefined]);
  assert.equal(view.currentTheme, view.baseline);
  assert.equal(state.writes.at(-1), resetSequence());
});

test("newer apply follows a reset whose persistence deletion is running", async () => {
  const state = fixture("Monokai Pro");
  const deleteStarted = deferred<void>();
  const releaseDelete = deferred<void>();
  const originalSave = state.host.saveSelection;
  state.host.saveSelection = async (name) => {
    if (name === undefined) {
      deleteStarted.resolve(undefined);
      await releaseDelete.promise;
    }
    await originalSave(name);
  };
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);
  state.saves.length = 0;
  const command = registered(app, "ghostty-theme");

  const resetting = command.handler("reset", view.ctx);
  await deleteStarted.promise;
  const applying = command.handler("Black Metal (Bathory)", view.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseDelete.resolve(undefined);
  await Promise.all([resetting, applying]);

  assert.equal(state.selection, "Black Metal (Bathory)");
  assert.deepEqual(state.saves, [undefined, "Black Metal (Bathory)"]);
  assert.equal(view.currentTheme, view.baseline);
  assert.deepEqual(view.setThemeCalls, []);
});

test("picker navigation live-previews before applying the selection", async () => {
  const state = fixture();
  const app = harness(state);
  const view = context({ simulatePicker: true });
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("", view.ctx);

  assert.equal(state.selection, "Monokai Pro");
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes[0], themeSequence(nativeTheme()));
  assert.equal(state.writes[1], themeSequence(nativeTheme()));
  assert.equal(view.currentTheme, view.baseline);
  assert.deepEqual(view.setThemeCalls, []);
});

test("picker selection applies and persists while cancel leaves state unchanged", async () => {
  const selected = fixture();
  const selectedApp = harness(selected);
  const selectedView = context({
    customSelection: "Black Metal (Bathory)",
  });
  await selectedApp.start({}, selectedView.ctx);
  await registered(selectedApp, "ghostty-theme").handler("", selectedView.ctx);
  assert.equal(selected.selection, "Black Metal (Bathory)");
  assert.equal(selectedView.currentTheme, selectedView.baseline);
  assert.deepEqual(selectedView.setThemeCalls, []);

  const cancelled = fixture();
  const cancelledApp = harness(cancelled);
  const cancelledView = context({ customSelection: null });
  await cancelledApp.start({}, cancelledView.ctx);
  await registered(cancelledApp, "ghostty-theme").handler(
    "",
    cancelledView.ctx,
  );
  assert.equal(cancelled.selection, undefined);
  assert.deepEqual(cancelled.saves, []);
});

test("reset clears persisted state and restores terminal defaults", async () => {
  const state = fixture("Monokai Pro");
  const app = harness(state);
  const view = context();
  const baseline = view.currentTheme;
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("reset", view.ctx);

  assert.equal(state.selection, undefined);
  assert.equal(state.writes.at(-1), resetSequence());
  assert.equal(view.currentTheme, baseline);
});

test("status reports the current theme without changing colors", async () => {
  const state = fixture();
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);

  await registered(app, "ghostty-theme").handler("status", view.ctx);
  assert.match(view.notifications.at(-1)?.message ?? "", /Ghostty default/);
  assert.deepEqual(state.writes, []);
});

test("status and reset do not require theme discovery", async () => {
  const state = fixture("Monokai Pro");
  const app = harness(state, {
    loadCatalog: async () => {
      throw new Error("catalog unavailable");
    },
  });
  const view = context();
  await app.start({}, view.ctx);
  assert.equal(app.catalogCalls, 1);

  await registered(app, "ghostty-theme").handler("status", view.ctx);
  assert.equal(app.catalogCalls, 1);
  assert.match(view.notifications.at(-1)?.message ?? "", /catalog unavailable/);

  await registered(app, "ghostty-theme").handler("reset", view.ctx);
  assert.equal(app.catalogCalls, 1);
  assert.equal(state.selection, undefined);
  assert.deepEqual(state.writes, []);
});

test("discovery diagnostics escape terminal controls", async () => {
  const state = fixture();
  const app = harness(state, {
    loadCatalog: async () => {
      throw new Error("catalog failed\u001b\u007f\u009b\nsecond line");
    },
  });
  const view = context();
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("status", view.ctx);

  for (const { message } of view.notifications) {
    assert.equal(hasTerminalControl(message), false);
  }
  assert.match(view.notifications.at(-1)?.message ?? "", /\\u009b/);
});

test("inactive reset clears saved state without discovery or OSC", async () => {
  const state = fixture("Monokai Pro");
  state.host.tty = () => false;
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);

  await registered(app, "ghostty-theme").handler("off", view.ctx);
  assert.equal(state.selection, undefined);
  assert.deepEqual(state.writes, []);
  assert.equal(app.catalogCalls, 0);
});

test("reset in non-TUI output modes emits no OSC", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const state = fixture("Monokai Pro");
    const app = harness(state);
    const view = context({ mode });
    await app.start({}, view.ctx);
    await registered(app, "ghostty-theme").handler("reset", view.ctx);

    assert.equal(state.selection, undefined, mode);
    assert.deepEqual(state.writes, [], mode);
    assert.equal(app.catalogCalls, 0, mode);
  }
});

test("print and JSON management commands report through diagnostics", async () => {
  for (const mode of ["json", "print"] as const) {
    const state = fixture("Monokai Pro");
    const app = harness(state);
    const view = context({ mode });
    await app.start({}, view.ctx);

    await registered(app, "ghostty-theme").handler("status", view.ctx);
    assert.match(state.diagnostics.at(-1) ?? "", /outside Pi TUI mode/);
    assert.match(state.diagnostics.at(-1) ?? "", /Ghostty theme/);
    await registered(app, "ghostty-theme").handler("reset", view.ctx);

    assert.equal(state.selection, undefined, mode);
    assert.match(state.diagnostics.at(-1) ?? "", /reset to terminal/i);
    assert.deepEqual(view.notifications, [], mode);
    assert.deepEqual(state.writes, [], mode);
    for (const diagnostic of state.diagnostics) {
      assert.ok(diagnostic.endsWith("\n"), mode);
      assert.equal(hasTerminalControl(diagnostic.slice(0, -1)), false, mode);
    }
  }
});

test("print mode reports partial reset failures through diagnostics", async () => {
  const state = fixture("Monokai Pro");
  state.host.saveSelection = async () => {
    throw Object.assign(new Error("state deletion denied"), {
      code: "EACCES",
    });
  };
  const app = harness(state);
  const view = context({ mode: "print" });
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("reset", view.ctx);

  assert.match(state.diagnostics.at(-1) ?? "", /saved selection.*not cleared/i);
  assert.deepEqual(view.notifications, []);
  assert.equal(state.selection, "Monokai Pro");
  assert.deepEqual(state.writes, []);
});

test("RPC management commands keep using UI notifications", async () => {
  const state = fixture("Monokai Pro");
  const app = harness(state);
  const view = context({ mode: "rpc" });
  await app.start({}, view.ctx);

  await registered(app, "ghostty-theme").handler("status", view.ctx);
  await registered(app, "ghostty-theme").handler("reset", view.ctx);

  assert.equal(state.selection, undefined);
  assert.match(view.notifications.at(-1)?.message ?? "", /reset to terminal/i);
  assert.deepEqual(state.diagnostics, []);
  assert.deepEqual(state.writes, []);
});

test("owned terminal reset is deferred outside a direct Ghostty TUI", async () => {
  let tty = true;
  const state = fixture();
  state.host.tty = () => tty;
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("Monokai Pro", view.ctx);
  assert.equal(state.writes.length, 1);

  tty = false;
  view.setMode("json");
  await registered(app, "ghostty-theme").handler("reset", view.ctx);
  assert.equal(state.writes.length, 1);
  assert.equal(state.selection, undefined);
  assert.equal(view.currentTheme, view.baseline);
  assert.match(state.diagnostics.at(-1) ?? "", /deferred.*TUI/i);

  await registered(app, "ghostty-theme").handler("status", view.ctx);
  assert.match(state.diagnostics.at(-1) ?? "", /Monokai Pro/);

  tty = true;
  view.setMode("tui");
  await app.shutdown({}, view.ctx);
  assert.equal(state.writes.at(-1), resetSequence());
});

test("inactive session restart defers OSC and retains owned theme status", async () => {
  let tty = true;
  const state = fixture();
  state.host.tty = () => tty;
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("Monokai Pro", view.ctx);
  assert.equal(state.writes.length, 1);

  tty = false;
  view.setMode("json");
  await app.start({}, view.ctx);
  assert.equal(state.writes.length, 1);
  await registered(app, "ghostty-theme").handler("status", view.ctx);
  assert.match(state.diagnostics.at(-1) ?? "", /Monokai Pro/);
  assert.match(state.diagnostics.at(-1) ?? "", /deferred.*TUI/i);

  tty = true;
  view.setMode("tui");
  await app.shutdown({}, view.ctx);
  assert.equal(state.writes.at(-1), resetSequence());
});

test("async apply rechecks direct Ghostty gating before OSC", async () => {
  const state = fixture();
  const app = harness(state);
  const view = context();
  let switchModeDuringRead = false;
  state.host.readTheme = async (path) => {
    const content = state.files.get(path);
    if (!content) throw new Error("missing fixture theme");
    if (switchModeDuringRead) view.setMode("json");
    return content;
  };
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("Monokai Pro", view.ctx);
  assert.equal(state.writes.length, 1);

  switchModeDuringRead = true;
  await registered(app, "ghostty-theme").handler(
    "Black Metal (Bathory)",
    view.ctx,
  );
  assert.equal(state.writes.length, 1);
  assert.equal(state.selection, "Monokai Pro");
  assert.equal(view.currentTheme, view.baseline);
  assert.deepEqual(view.setThemeCalls, []);
  assert.match(state.diagnostics.at(-1) ?? "", /cancelled.*TUI/i);

  view.setMode("tui");
  await app.shutdown({}, view.ctx);
  assert.equal(state.writes.at(-1), resetSequence());
});

test("Ghostty lifecycle preserves an independently changed Pi theme", async () => {
  const state = fixture();
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("Monokai Pro", view.ctx);

  const external = piTheme("External", "#ff00ff");
  view.setCurrentTheme(external);
  await registered(app, "ghostty-theme").handler(
    "Black Metal (Bathory)",
    view.ctx,
  );
  await registered(app, "ghostty-theme").handler("reset", view.ctx);
  await app.start({}, view.ctx);
  await app.shutdown({}, view.ctx);

  assert.equal(view.currentTheme, external);
  assert.deepEqual(view.setThemeCalls, []);
  assert.equal(state.selection, undefined);
  assert.equal(state.writes.length, 3);
  assert.equal(state.writes.at(-1), resetSequence());
});

test("persistence deletion failure still restores the terminal", async () => {
  const state = fixture("Monokai Pro");
  state.host.saveSelection = async (name) => {
    if (name === undefined) {
      throw Object.assign(new Error("state deletion denied"), {
        code: "EACCES",
      });
    }
    state.selection = name;
    state.saves.push(name);
  };
  const app = harness(state);
  const view = context();
  const baseline = view.currentTheme;
  await app.start({}, view.ctx);

  await registered(app, "ghostty-theme").handler("reset", view.ctx);

  assert.equal(state.selection, "Monokai Pro");
  assert.equal(state.writes.at(-1), resetSequence());
  assert.equal(view.currentTheme, baseline);
  assert.match(
    view.notifications.at(-1)?.message ?? "",
    /saved|persist|next startup/i,
  );
  assert.notEqual(view.notifications.at(-1)?.level, "info");
});

test("persisted state loader bounds and validates the state file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ghostty-state-"));
  const path = join(directory, "state.json");
  try {
    assert.equal(await loadSelectionFile(path), undefined);

    await writeFile(path, '{"theme":"Monokai Pro"}\n');
    assert.equal(await loadSelectionFile(path), "Monokai Pro");

    await writeFile(path, "{not json");
    await assert.rejects(loadSelectionFile(path), /invalid JSON/);

    await writeFile(path, "x".repeat(8 * 1024 + 1));
    await assert.rejects(loadSelectionFile(path), /exceeds 8192 bytes/);

    await rm(path);
    await mkdir(path);
    await assert.rejects(loadSelectionFile(path), /not a regular file/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("failed atomic state replacement cleans its temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ghostty-save-"));
  const path = join(directory, "state.json");
  try {
    await mkdir(path);
    await assert.rejects(
      saveSelectionFile(path, "Monokai Pro"),
      (error: unknown) =>
        error instanceof Error &&
        /could not be saved/.test(error.message) &&
        !error.message.includes(directory),
    );
    assert.deepEqual(await readdir(directory), ["state.json"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("startup reports persisted-state errors and reset clears the issue", async () => {
  const state = fixture("Monokai Pro");
  state.host.loadSelection = async () => {
    throw new Error("saved theme state contains invalid JSON");
  };
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);

  assert.match(view.notifications.at(-1)?.message ?? "", /invalid JSON/);
  await registered(app, "ghostty-theme").handler("status", view.ctx);
  assert.match(view.notifications.at(-1)?.message ?? "", /invalid JSON/);

  await registered(app, "ghostty-theme").handler("reset", view.ctx);
  await registered(app, "ghostty-theme").handler("status", view.ctx);
  assert.doesNotMatch(view.notifications.at(-1)?.message ?? "", /issue:/);
  assert.equal(state.selection, undefined);
});

test("terminal reset failure is reported and retried at shutdown", async () => {
  const state = fixture();
  let resetAttempts = 0;
  state.host.writeTerminal = (value) => {
    if (value === resetSequence()) {
      resetAttempts += 1;
      if (resetAttempts === 1) throw new Error("terminal reset denied");
    }
    state.writes.push(value);
  };
  const app = harness(state);
  const view = context();
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("Monokai Pro", view.ctx);

  await registered(app, "ghostty-theme").handler("reset", view.ctx);
  assert.match(
    view.notifications.at(-1)?.message ?? "",
    /terminal reset denied/,
  );
  assert.equal(view.currentTheme, view.baseline);

  await app.shutdown({}, view.ctx);
  assert.equal(resetAttempts, 2);
  assert.equal(state.writes.at(-1), resetSequence());
});

test("unsafe control-character theme names are rejected", () => {
  const output = [
    "Safe Unicode 東京 (user) /themes/Safe Unicode 東京",
    "Black Metal (Bathory) (resources) /themes/Black Metal (Bathory)",
    "evil\u001b]52;c;Zm9v\u0007 (user) /themes/evil",
    "tab\tname (user) /themes/tab",
    "del\u007fname (user) /themes/del",
    "csi\u009b31mname (user) /themes/csi",
    "newline",
    "name (user) /themes/newline",
  ].join("\n");

  assert.deepEqual(
    parseThemeList(output).map((source) => source.name),
    ["Black Metal (Bathory)", "Safe Unicode 東京"],
  );
});

test("malicious saved names and arguments never reach raw UI output", async () => {
  const malicious = "evil\u001b]52;c;Zm9v\u0007\u007f\u0080\u009b";
  const state = fixture(malicious);
  const app = harness(state, {
    loadCatalog: async () => `${sourceList}\n${malicious} (user) /themes/evil`,
  });
  const view = context();
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("status", view.ctx);
  await registered(app, "ghostty-theme").handler(malicious, view.ctx);

  const completions =
    registered(app, "ghostty-theme").getArgumentCompletions?.("") ?? [];
  const rendered = [
    ...view.notifications.map(({ message }) => message),
    ...completions.flatMap(({ value, label }) => [value, label]),
  ];
  for (const value of rendered) {
    assert.equal(hasTerminalControl(value), false);
  }
  assert.equal(state.selection, undefined);
  assert.deepEqual(state.saves, [undefined]);
});

test("failed picker cancel reports the still-owned preview theme", async () => {
  const state = fixture();
  let resetAttempts = 0;
  state.host.writeTerminal = (value) => {
    if (value === resetSequence()) {
      resetAttempts += 1;
      if (resetAttempts === 1) throw new Error("preview reset denied");
    }
    state.writes.push(value);
  };
  const view = context({
    runPicker: async (component) => {
      component.handleInput?.("\x1b[B");
      await new Promise<void>((resolve) => setImmediate(resolve));
      component.handleInput?.("\x1b");
    },
  });
  const app = harness(state);
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("", view.ctx);
  await registered(app, "ghostty-theme").handler("status", view.ctx);

  assert.match(view.notifications.at(-1)?.message ?? "", /Monokai Pro/);
  assert.match(
    view.notifications.at(-1)?.message ?? "",
    /preview reset denied/,
  );
  assert.equal(state.selection, undefined);
  assert.deepEqual(state.saves, []);
  assert.equal(view.currentTheme, view.baseline);

  await app.shutdown({}, view.ctx);
  assert.equal(resetAttempts, 2);
  assert.equal(state.writes.at(-1), resetSequence());
});

test("picker styling stays on the Pi theme during Ghostty preview", async () => {
  const state = fixture();
  state.files.set(
    "/themes/Monokai Pro",
    themeText()
      .replace("palette = 3=#ffd866", "palette = 3=#040506")
      .replace("palette = 4=#fc9867", "palette = 4=#010203")
      .replace("background = #2d2a2e", "background = #101010")
      .replace("foreground = #fcfcfa", "foreground = #e0e0e0"),
  );
  let before = "";
  let after = "";
  let noMatch = "";
  const view = context({
    runPicker: async (component) => {
      before = component.render?.(80).join("\n") ?? "";
      component.handleInput?.("\x1b[B");
      await new Promise<void>((resolve) => setImmediate(resolve));
      component.invalidate?.();
      after = component.render?.(80).join("\n") ?? "";
      component.handleInput?.("zzzzzz");
      component.invalidate?.();
      noMatch = component.render?.(80).join("\n") ?? "";
      component.handleInput?.("\x1b");
    },
  });
  const app = harness(state);
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("", view.ctx);

  const initialAccent = view.baseline.getFgAnsi("accent");
  const ghosttyDerivedAccent = "\u001b[38;2;1;2;3m";
  assert.ok(before.includes(initialAccent));
  assert.ok(after.includes(initialAccent));
  assert.ok(after.split(initialAccent).length - 1 >= 2);
  assert.ok(after.includes(view.baseline.getFgAnsi("muted")));
  assert.ok(after.includes(view.baseline.getFgAnsi("dim")));
  assert.ok(noMatch.includes(view.baseline.getFgAnsi("warning")));
  assert.ok(!after.includes(ghosttyDerivedAccent));
  assert.equal(view.currentTheme, view.baseline);
  assert.deepEqual(view.setThemeCalls, []);
});

test("picker render respects widths zero through eighty", async () => {
  const widths = [0, 1, 2, 3, 5, 10, 20, 40, 80];
  const state = fixture();
  const view = context({
    runPicker: (component, done) => {
      for (const width of widths) {
        const lines = component.render?.(width) ?? [];
        if (width >= 3)
          assert.ok(lines.length > 0, `no content at width ${width}`);
        for (const line of lines) {
          assert.ok(
            visibleWidth(line) <= width,
            `line width ${visibleWidth(line)} exceeded ${width}: ${JSON.stringify(line)}`,
          );
        }
      }
      done(null);
    },
  });
  const app = harness(state);
  await app.start({}, view.ctx);
  await registered(app, "ghostty-theme").handler("", view.ctx);
});
