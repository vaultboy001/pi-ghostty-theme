import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { hasUnsafeThemeControls, type ThemeSource } from "./ghostty.js";

function fuzzyThemes(themes: ThemeSource[], query: string): ThemeSource[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return themes;
  return themes
    .filter((theme) => {
      const name = theme.name.toLowerCase();
      return terms.every((term) => name.includes(term));
    })
    .sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const first = terms[0] ?? "";
      const aScore = aName.startsWith(first) ? 0 : aName.indexOf(first) + 1;
      const bScore = bName.startsWith(first) ? 0 : bName.indexOf(first) + 1;
      return aScore - bScore || a.name.localeCompare(b.name);
    });
}

export async function showThemePicker(
  ctx: ExtensionContext,
  themes: ThemeSource[],
  activeName: string | undefined,
  onPreview: (name: string) => void,
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, _theme, _keybindings, done) => {
    let query = "";
    let list: SelectList;
    const container = new Container();
    const heading = new Text("", 1, 0);
    const search = new Text("", 1, 0);
    const help = new Text("", 1, 0);

    const style = () => {
      const liveTheme = ctx.ui.theme;
      heading.setText(liveTheme.fg("accent", liveTheme.bold("Ghostty Theme")));
      search.setText(
        `${liveTheme.fg("muted", "Search: ")}${query || liveTheme.fg("dim", "type a theme name")}`,
      );
      help.setText(
        liveTheme.fg(
          "dim",
          "Type to search · ↑↓ live preview · Enter apply · Esc cancel",
        ),
      );
    };

    const listSlot = {
      render: (width: number) => list.render(width),
      invalidate: () => list.invalidate(),
    };

    const configureList = (preferred?: string) => {
      const filtered = fuzzyThemes(themes, query);
      const items: SelectItem[] = filtered.map((source) => ({
        value: source.name,
        label: source.name,
        description: source.origin,
      }));
      list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), {
        selectedPrefix: (text) => ctx.ui.theme.fg("accent", text),
        selectedText: (text) => ctx.ui.theme.fg("accent", text),
        description: (text) => ctx.ui.theme.fg("muted", text),
        scrollInfo: (text) => ctx.ui.theme.fg("dim", text),
        noMatch: (text) => ctx.ui.theme.fg("warning", text),
      });
      const preferredIndex = preferred
        ? filtered.findIndex((source) => source.name === preferred)
        : -1;
      if (preferredIndex >= 0) list.setSelectedIndex(preferredIndex);
      list.onSelectionChange = (item) => onPreview(item.value);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
    };

    configureList(activeName);
    style();
    container.addChild(heading);
    container.addChild(search);
    container.addChild(listSlot);
    container.addChild(help);

    return {
      render(width: number) {
        if (width <= 0) return [];
        if (width <= 2) return [" ".repeat(width)];
        style();
        return container
          .render(width)
          .map((line) => truncateToWidth(line, width, ""));
      },
      invalidate() {
        container.invalidate();
        style();
      },
      handleInput(data: string) {
        if (matchesKey(data, "backspace")) {
          query = Array.from(query).slice(0, -1).join("");
          configureList();
          const selected = list.getSelectedItem();
          if (selected) onPreview(selected.value);
        } else if (matchesKey(data, "ctrl+u")) {
          query = "";
          configureList(activeName);
          const selected = list.getSelectedItem();
          if (selected) onPreview(selected.value);
        } else if (!hasUnsafeThemeControls(data)) {
          query += data;
          configureList();
          const selected = list.getSelectedItem();
          if (selected) onPreview(selected.value);
        } else {
          list.handleInput(data);
        }
        style();
        tui.requestRender();
      },
    };
  });
}
