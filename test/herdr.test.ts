import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseGhosttyTheme } from "../extensions/ghostty.js";
import {
  applyChromeColors,
  chromeColorsFromTheme,
  herdrConfigPath,
  herdrHostTtyDevices,
  isHerdrClientCommand,
  mixHex,
  parseHerdrClients,
  readSectionValue,
  removeSectionKey,
  restoreChromeColors,
  snapshotManagedChrome,
  syncHerdrChrome,
  ttyDevicePath,
  upsertSectionValue,
} from "../extensions/herdr.js";

const listing = [
  "?? /Users/brandon/.local/bin/herdr server TERM_PROGRAM=ghostty",
  "ttys000 herdr TERM_PROGRAM=ghostty TERM=xterm-ghostty",
  "ttys008 /Users/brandon/.local/bin/herdr TERM=xterm-256color",
  "?? /opt/homebrew/bin/ttyd /Users/brandon/.local/bin/herdr TERM_PROGRAM=ghostty",
].join("\n");

function sampleTheme() {
  const colors = [
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
  return parseGhosttyTheme(
    "Monokai Pro",
    [
      ...colors.map((color, index) => `palette = ${index}=${color}`),
      "background = #2d2a2e",
      "foreground = #fcfcfa",
      "cursor-color = #c1c0c0",
    ].join("\n"),
  );
}

test("identifies herdr clients and skips server subcommands", () => {
  assert.equal(isHerdrClientCommand("herdr"), true);
  assert.equal(isHerdrClientCommand("/Users/brandon/.local/bin/herdr"), true);
  assert.equal(isHerdrClientCommand("herdr --remote studio"), true);
  assert.equal(isHerdrClientCommand("herdr TERM_PROGRAM=ghostty"), true);
  assert.equal(isHerdrClientCommand("herdr server"), false);
  assert.equal(isHerdrClientCommand("herdr api snapshot"), false);
  assert.equal(isHerdrClientCommand("ttyd herdr"), false);
});

test("parses herdr client ttys from a ps listing", () => {
  assert.deepEqual(parseHerdrClients(listing), [
    { tty: "ttys000", ghostty: true },
    { tty: "ttys008", ghostty: false },
  ]);
  assert.deepEqual(herdrHostTtyDevices(listing), ["/dev/ttys000"]);
  assert.equal(ttyDevicePath("ttys000"), "/dev/ttys000");
  assert.equal(ttyDevicePath("pts/0"), "/dev/pts/0");
  assert.equal(ttyDevicePath("/dev/ttys001"), "/dev/ttys001");
});

test("maps a Ghostty theme onto Herdr chrome tokens", () => {
  const colors = chromeColorsFromTheme(sampleTheme());
  assert.equal(colors.panel_bg, "#2d2a2e");
  assert.equal(colors.sidebar_bg, "#2d2a2e");
  assert.equal(colors.text, "#fcfcfa");
  assert.equal(colors.red, "#ff6188");
  assert.equal(colors.green, "#a9dc76");
  assert.equal(colors.accent, "#fc9867");
  assert.equal(colors.blue, "#fc9867");
  assert.equal(colors.overlay0, "#727072");
  assert.equal(colors.active_row_bg, mixHex("#2d2a2e", "#fcfcfa", 0.08));
});

test("upserts theme.custom without touching nested tables", () => {
  const original = `[theme]
name = "catppuccin"
auto_switch = false

[theme.custom]
accent = "#111111"

[theme.custom.light]
accent = "#ffffff"

[ui]
show_agent_labels_on_pane_borders = false
`;
  const updated = upsertSectionValue(
    original,
    "theme.custom",
    "panel_bg",
    '"#2d2a2e"',
  );
  const replaced = upsertSectionValue(
    updated,
    "theme.custom",
    "accent",
    '"#fc9867"',
  );
  assert.equal(
    readSectionValue(replaced, "theme.custom", "panel_bg"),
    '"#2d2a2e"',
  );
  assert.equal(
    readSectionValue(replaced, "theme.custom", "accent"),
    '"#fc9867"',
  );
  assert.equal(
    readSectionValue(replaced, "theme.custom.light", "accent"),
    '"#ffffff"',
  );
  assert.match(replaced, /name = "catppuccin"/);
});

test("creates theme.custom when the section is missing", () => {
  const original = `[theme]
name = "catppuccin"
`;
  const updated = upsertSectionValue(
    original,
    "theme.custom",
    "text",
    '"#fcfcfa"',
  );
  assert.match(updated, /\[theme\.custom\]\ntext = "#fcfcfa"/);
});

test("restores managed chrome keys to the original snapshot", () => {
  const original = `[theme]
name = "catppuccin"

[theme.custom]
accent = "#111111"
`;
  const colored = applyChromeColors(
    original,
    chromeColorsFromTheme(sampleTheme()),
  );
  const restored = restoreChromeColors(
    colored,
    snapshotManagedChrome(original),
  );
  assert.equal(
    readSectionValue(restored, "theme.custom", "accent"),
    '"#111111"',
  );
  assert.equal(
    readSectionValue(restored, "theme.custom", "panel_bg"),
    undefined,
  );
  assert.equal(readSectionValue(restored, "theme", "name"), '"catppuccin"');
});

test("removeSectionKey deletes only the requested assignment", () => {
  const content = `[theme.custom]
accent = "#111"
panel_bg = "#222"
`;
  const next = removeSectionKey(content, "theme.custom", "panel_bg");
  assert.equal(readSectionValue(next, "theme.custom", "accent"), '"#111"');
  assert.equal(readSectionValue(next, "theme.custom", "panel_bg"), undefined);
});

test("herdrConfigPath honors HERDR_CONFIG_PATH and XDG_CONFIG_HOME", () => {
  assert.equal(
    herdrConfigPath({ HERDR_CONFIG_PATH: "/tmp/custom.toml" }),
    "/tmp/custom.toml",
  );
  assert.equal(
    herdrConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg", HOME: "/tmp/home" }),
    join("/tmp/xdg", "herdr", "config.toml"),
  );
});

test("syncHerdrChrome live-recolors then restores Herdr config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ghostty-herdr-"));
  const configPath = join(root, "config.toml");
  const backupPath = join(root, "backup.json");
  await mkdir(root, { recursive: true });
  await writeFile(
    configPath,
    `[theme]\nname = "catppuccin"\nauto_switch = false\n`,
  );
  const reloads: Array<string | undefined> = [];

  const host = {
    env: () => ({ HERDR_ENV: "1" }),
    configPath: () => configPath,
    backupPath: () => backupPath,
    reload: async () => {
      reloads.push("apply");
    },
  };

  await syncHerdrChrome(sampleTheme(), host);
  const applied = await readFile(configPath, "utf8");
  assert.match(applied, /name = "catppuccin"/);
  assert.equal(
    readSectionValue(applied, "theme.custom", "panel_bg"),
    '"#2d2a2e"',
  );
  assert.equal(readSectionValue(applied, "theme.custom", "text"), '"#fcfcfa"');
  assert.equal(reloads.length, 1);

  await syncHerdrChrome(undefined, host);
  const restored = await readFile(configPath, "utf8");
  assert.equal(
    readSectionValue(restored, "theme.custom", "panel_bg"),
    undefined,
  );
  assert.match(restored, /name = "catppuccin"/);
  assert.equal(reloads.length, 2);
});

test("syncHerdrChrome is a no-op outside Herdr", async () => {
  await syncHerdrChrome(sampleTheme(), {
    env: () => ({}),
    configPath: () => {
      throw new Error("should not read config");
    },
  });
});

test("restore reloads even when config is already clean (P1-1)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ghostty-herdr-"));
  const configPath = join(root, "config.toml");
  const backupPath = join(root, "backup.json");
  await mkdir(root, { recursive: true });
  await writeFile(
    configPath,
    `[theme]\nname = "catppuccin"\nauto_switch = false\n`,
  );
  const reloads: string[] = [];
  const host = {
    env: () => ({ HERDR_ENV: "1" }),
    configPath: () => configPath,
    backupPath: () => backupPath,
    reload: async () => {
      reloads.push("reload");
    },
  };

  // Apply, then fail the reload once, then restore twice.
  await syncHerdrChrome(sampleTheme(), host);
  assert.equal(reloads.length, 1);

  // First restore: simulated reload failure (server memory stays themed)
  const failingHost = {
    ...host,
    reload: async () => {
      reloads.push("reload");
      throw new Error("reload failed");
    },
  };
  const applied = await readFile(configPath, "utf8");
  const cleanConfig = applied; // still themed on disk
  void cleanConfig;
  await assert.rejects(
    syncHerdrChrome(undefined, failingHost),
    /reload failed/,
  );
  assert.equal(reloads.length, 2);

  // Second restore: config file already restored, but must still reload to
  // converge server memory. Backup must survive until reload succeeds.
  await syncHerdrChrome(undefined, host);
  assert.equal(reloads.length, 3);
  const restored = await readFile(configPath, "utf8");
  assert.equal(
    readSectionValue(restored, "theme.custom", "panel_bg"),
    undefined,
  );
});

test("corrupt chrome backup aborts instead of silent no-op (P1-2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ghostty-herdr-"));
  const configPath = join(root, "config.toml");
  const backupPath = join(root, "backup.json");
  await mkdir(root, { recursive: true });
  await writeFile(configPath, `[theme]\nname = "catppuccin"\n`);
  await writeFile(backupPath, "{corrupt json");

  const writes: string[] = [];
  const host = {
    env: () => ({ HERDR_ENV: "1" }),
    configPath: () => configPath,
    backupPath: () => backupPath,
    reload: async () => {},
  };

  // Restore with a corrupt backup must throw, not quietly do nothing.
  await assert.rejects(
    syncHerdrChrome(undefined, host),
    /chrome backup contains invalid JSON/,
  );

  // Apply with a corrupt backup must also abort: it must NOT re-snapshot the
  // current (possibly already themed) config and overwrite the true original.
  await assert.rejects(
    syncHerdrChrome(sampleTheme(), host),
    /chrome backup contains invalid JSON/,
  );
});
