import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadGhosttyThemeCatalog, type ThemeCatalogLoader } from "./catalog.js";
import {
  escapeTerminalControls,
  type GhosttyTheme,
  parseGhosttyTheme,
  parseThemeList,
  quoteForUi,
  resetSequence,
  type ThemeSource,
  themeSequence,
} from "./ghostty.js";
import { showThemePicker } from "./picker.js";
import {
  loadSavedSelection,
  readThemeFile,
  saveSavedSelection,
  writeToTerminal,
} from "./storage.js";

export interface Host {
  env(): NodeJS.ProcessEnv;
  tty(): boolean;
  readTheme(path: string): Promise<string>;
  writeTerminal(value: string): void;
  writeDiagnostic?(value: string): void;
  loadSelection(): Promise<string | undefined>;
  saveSelection(name: string | undefined): Promise<void>;
}

const defaultHost: Host = {
  env: () => process.env,
  tty: () => process.stdout.isTTY === true,
  readTheme: readThemeFile,
  writeTerminal: writeToTerminal,
  writeDiagnostic: (value) => process.stderr.write(value),
  loadSelection: loadSavedSelection,
  saveSelection: saveSavedSelection,
};

export function inactiveReason(
  mode: string,
  tty: boolean,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (mode !== "tui") return "outside Pi TUI mode";
  if (!tty) return "stdout is not a TTY";
  if (env.TMUX?.trim()) return "tmux is unsupported";
  if (env.STY?.trim()) return "GNU screen is unsupported";
  const program = env.TERM_PROGRAM?.trim().toLowerCase();
  const term = env.TERM?.trim().toLowerCase();
  if (program !== "ghostty" && term !== "xterm-ghostty" && term !== "ghostty") {
    return "the terminal is not Ghostty";
  }
  return undefined;
}

type NoticeLevel = "info" | "warning" | "error";

interface MutationToken {
  lifecycle: number;
  mutation: number;
}

type CommitResult<T> = { committed: false } | { committed: true; value: T };

export function createExtension(
  host: Host = defaultHost,
  loadCatalog: ThemeCatalogLoader = loadGhosttyThemeCatalog,
) {
  return function ghosttyTheme(pi: ExtensionAPI): void {
    let sources: ThemeSource[] = [];
    let activeName: string | undefined;
    let terminalOwned = false;
    let terminalOwnedName: string | undefined;
    let activation = "not started";
    let lastIssue: string | undefined;
    let previewGeneration = 0;
    let lifecycleGeneration = 0;
    let mutationGeneration = 0;
    let commitTail: Promise<void> = Promise.resolve();
    let running = false;
    const cache = new Map<string, GhosttyTheme>();

    const findSource = (name: string): ThemeSource | undefined => {
      const exact = sources.find((source) => source.name === name);
      if (exact) return exact;
      const normalized = name.toLowerCase();
      return sources.find((source) => source.name.toLowerCase() === normalized);
    };

    const isCurrent = (generation: number): boolean =>
      running && generation === lifecycleGeneration;

    const beginMutation = (): MutationToken => {
      mutationGeneration += 1;
      previewGeneration += 1;
      return {
        lifecycle: lifecycleGeneration,
        mutation: mutationGeneration,
      };
    };

    const invalidateMutations = (): void => {
      mutationGeneration += 1;
      previewGeneration += 1;
    };

    const isMutationCurrent = (token: MutationToken): boolean =>
      isCurrent(token.lifecycle) && token.mutation === mutationGeneration;

    const commitMutation = <T>(
      token: MutationToken,
      action: () => Promise<T> | T,
    ): Promise<CommitResult<T>> => {
      const task = commitTail.then(async (): Promise<CommitResult<T>> => {
        if (!isMutationCurrent(token)) return { committed: false };
        return { committed: true, value: await action() };
      });
      commitTail = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    };

    const discoverSources = async (): Promise<ThemeSource[]> => {
      const discovered = parseThemeList(await loadCatalog());
      if (!discovered.length) throw new Error("Ghostty reported no themes");
      return discovered;
    };

    const loadNativeTheme = async (
      source: ThemeSource,
    ): Promise<GhosttyTheme> => {
      const cached = cache.get(source.path);
      if (cached) return cached;
      const parsed = parseGhosttyTheme(
        source.name,
        await host.readTheme(source.path),
      );
      cache.set(source.path, parsed);
      return parsed;
    };

    const loadThemeByName = async (name: string): Promise<GhosttyTheme> => {
      const source = findSource(name);
      if (!source) {
        throw new Error(`Ghostty theme ${quoteForUi(name)} was not found`);
      }
      return loadNativeTheme(source);
    };

    const describeError = (error: unknown): string =>
      escapeTerminalControls(
        error instanceof Error ? error.message : String(error),
      );

    const report = (
      ctx: ExtensionContext,
      message: string,
      level: NoticeLevel,
    ): void => {
      const safe = escapeTerminalControls(message);
      if (ctx.hasUI) {
        ctx.ui.notify(safe, level);
        return;
      }
      try {
        host.writeDiagnostic?.(`${safe}\n`);
      } catch {
        // Diagnostics must never break command or lifecycle cleanup.
      }
    };

    const statusMessage = (): string => {
      const issue = lastIssue ? `; issue: ${lastIssue}` : "";
      const displayedName =
        terminalOwnedName ?? activeName ?? "Ghostty default";
      return `Ghostty theme: ${activation}; theme ${quoteForUi(displayedName)}${issue}.`;
    };

    const restoreTerminal = (ctx: ExtensionContext): string | undefined => {
      previewGeneration += 1;
      if (!terminalOwned) {
        terminalOwnedName = undefined;
        return undefined;
      }
      const reason = inactiveReason(ctx.mode, host.tty(), host.env());
      if (reason) return `restoration deferred because ${reason}`;
      try {
        host.writeTerminal(resetSequence());
        terminalOwned = false;
        terminalOwnedName = undefined;
        return undefined;
      } catch (error) {
        return describeError(error);
      }
    };

    const applyTheme = (theme: GhosttyTheme, ctx: ExtensionContext): void => {
      const reason = inactiveReason(ctx.mode, host.tty(), host.env());
      if (reason) {
        activation = `inactive because ${reason}`;
        throw new Error(`theme application cancelled because ${reason}`);
      }
      host.writeTerminal(themeSequence(theme));
      terminalOwned = true;
      terminalOwnedName = theme.name;
      lastIssue = undefined;
    };

    const applyName = async (
      name: string,
      ctx: ExtensionContext,
      token: MutationToken,
      options: { persist?: boolean } = {},
    ): Promise<boolean> => {
      const theme = await loadThemeByName(name);
      if (!isMutationCurrent(token)) return false;
      const committed = await commitMutation(token, async () => {
        applyTheme(theme, ctx);
        activeName = name;
        if (options.persist) await host.saveSelection(name);
      });
      return committed.committed;
    };

    interface ResetOutcome {
      persistenceError?: string;
      terminalError?: string;
    }

    const resetIssues = (outcome: ResetOutcome): string[] => {
      const issues: string[] = [];
      if (outcome.terminalError) {
        issues.push(`terminal restoration failed: ${outcome.terminalError}`);
      }
      if (outcome.persistenceError) {
        issues.push(
          `saved selection was not cleared and may reapply next startup: ${outcome.persistenceError}`,
        );
      }
      return issues;
    };

    const reset = async (ctx: ExtensionContext): Promise<ResetOutcome> => {
      const previousName = activeName;
      const outcome: ResetOutcome = {
        terminalError: restoreTerminal(ctx),
      };

      try {
        await host.saveSelection(undefined);
      } catch (error) {
        outcome.persistenceError = describeError(error);
      }

      activeName = terminalOwned ? previousName : undefined;
      const issues = resetIssues(outcome);
      lastIssue = issues.length
        ? `reset incomplete: ${issues.join("; ")}`
        : undefined;
      return outcome;
    };

    const ensureActive = (ctx: ExtensionContext): boolean => {
      const reason = inactiveReason(ctx.mode, host.tty(), host.env());
      if (!reason) return true;
      activation = `inactive because ${reason}`;
      report(ctx, `Ghostty theme is ${activation}.`, "warning");
      return false;
    };

    pi.registerCommand("ghostty-theme", {
      description: "Choose and live-preview a Ghostty terminal theme",
      getArgumentCompletions: (prefix) => {
        const query = prefix.trim().toLowerCase();
        const matches = sources.filter((source) =>
          source.name.toLowerCase().includes(query),
        );
        return matches.length
          ? matches.slice(0, 50).map((source) => ({
              value: source.name,
              label: source.name,
              description: source.origin,
            }))
          : null;
      },
      handler: async (args, ctx) => {
        const run = lifecycleGeneration;
        if (!isCurrent(run)) return;
        const requested = args.trim();

        if (requested === "status") {
          report(ctx, statusMessage(), "info");
          return;
        }
        if (requested === "reset" || requested === "off") {
          const token = beginMutation();
          const committed = await commitMutation(token, () => reset(ctx));
          if (!committed.committed || !isMutationCurrent(token)) return;
          const issues = resetIssues(committed.value);
          if (issues.length) {
            report(
              ctx,
              `Ghostty theme reset incomplete: ${issues.join("; ")}.`,
              committed.value.terminalError ? "error" : "warning",
            );
          } else {
            report(ctx, "Ghostty theme reset to terminal defaults.", "info");
          }
          return;
        }

        if (!ensureActive(ctx)) return;
        const token = beginMutation();
        if (!sources.length) {
          try {
            const discovered = await discoverSources();
            if (!isMutationCurrent(token)) return;
            sources = discovered;
          } catch (error) {
            if (!isMutationCurrent(token)) return;
            lastIssue = describeError(error);
            report(ctx, `Ghostty theme: ${lastIssue}.`, "error");
            return;
          }
        }

        if (requested) {
          const source = findSource(requested);
          if (!source) {
            report(
              ctx,
              `Unknown Ghostty theme ${quoteForUi(requested)}. Run /ghostty-theme to search.`,
              "warning",
            );
            return;
          }
          try {
            if (
              !(await applyName(source.name, ctx, token, { persist: true }))
            ) {
              return;
            }
            if (isMutationCurrent(token)) {
              report(ctx, `Ghostty now uses ${activeName}.`, "info");
            }
          } catch (error) {
            if (!isMutationCurrent(token)) return;
            lastIssue = describeError(error);
            report(ctx, `Ghostty theme: ${lastIssue}.`, "error");
          }
          return;
        }

        const originalName = activeName;
        let pickerOpen = true;
        const result = await showThemePicker(
          ctx,
          sources,
          activeName,
          (name) => {
            const generation = ++previewGeneration;
            void loadThemeByName(name)
              .then(async (theme) => {
                if (
                  !pickerOpen ||
                  !isMutationCurrent(token) ||
                  generation !== previewGeneration
                ) {
                  return;
                }
                await commitMutation(token, () => applyTheme(theme, ctx));
              })
              .catch((error) => {
                if (
                  pickerOpen &&
                  isMutationCurrent(token) &&
                  generation === previewGeneration
                ) {
                  lastIssue = describeError(error);
                }
              });
          },
        );
        pickerOpen = false;
        previewGeneration += 1;
        if (!isMutationCurrent(token)) return;

        try {
          if (!result) {
            if (originalName) {
              await applyName(originalName, ctx, token);
            } else {
              const committed = await commitMutation(token, () => {
                const terminalError = restoreTerminal(ctx);
                const issues = resetIssues({ terminalError });
                if (issues.length) {
                  throw new Error(
                    `cancel cleanup incomplete: ${issues.join("; ")}`,
                  );
                }
                lastIssue = undefined;
              });
              if (!committed.committed) return;
            }
            return;
          }
          if (!(await applyName(result, ctx, token, { persist: true }))) {
            return;
          }
          if (isMutationCurrent(token)) {
            report(ctx, `Ghostty now uses ${activeName}.`, "info");
          }
        } catch (error) {
          if (!isMutationCurrent(token)) return;
          lastIssue = describeError(error);
          report(ctx, `Ghostty theme: ${lastIssue}.`, "error");
        }
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      running = false;
      lifecycleGeneration += 1;
      invalidateMutations();
      await commitTail;

      const previousName = activeName;
      const startupCleanupIssues = resetIssues({
        terminalError: restoreTerminal(ctx),
      });
      running = true;
      sources = [];
      cache.clear();
      activeName = terminalOwned ? previousName : undefined;
      lastIssue = startupCleanupIssues.length
        ? `startup cleanup incomplete: ${startupCleanupIssues.join("; ")}`
        : undefined;
      const reason = inactiveReason(ctx.mode, host.tty(), host.env());
      activation = reason
        ? `inactive because ${reason}`
        : "active in the current Ghostty surface";
      if (reason) return;

      const token = beginMutation();
      try {
        const discovered = await discoverSources();
        if (!isMutationCurrent(token)) return;
        sources = discovered;
        const saved = await host.loadSelection();
        if (!isMutationCurrent(token) || !saved) return;
        const savedSource = findSource(saved);
        if (!savedSource) {
          const issue = `saved theme ${quoteForUi(saved)} is no longer available`;
          await commitMutation(token, async () => {
            lastIssue = issue;
            try {
              await host.saveSelection(undefined);
            } catch (error) {
              lastIssue += `; saved selection was not cleared and may reapply next startup: ${describeError(error)}`;
            }
          });
          return;
        }
        await applyName(savedSource.name, ctx, token);
      } catch (error) {
        if (!isMutationCurrent(token)) return;
        lastIssue = describeError(error);
        report(ctx, `Ghostty theme: ${lastIssue}.`, "warning");
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      running = false;
      lifecycleGeneration += 1;
      invalidateMutations();
      await commitTail;
      restoreTerminal(ctx);
    });
  };
}

export default createExtension();
