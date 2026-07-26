import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
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
import { createPiTheme, type ThemeConstructor } from "./pi-theme.js";
import { showThemePicker } from "./picker.js";
import {
  loadSavedSelection,
  readThemeFile,
  saveSavedSelection,
  writeToTerminal,
} from "./storage.js";

type DeferredTask = () => Promise<void> | void;

const POST_RELOAD_SETTLE_MS = 250;

function deferTask(task: DeferredTask, delayMs = 0): void {
  if (delayMs > 0) {
    const timer = setTimeout(() => void task(), delayMs);
    timer.unref();
    return;
  }
  setImmediate(() => void task());
}

export interface Host {
  env(): NodeJS.ProcessEnv;
  tty(): boolean;
  readTheme(path: string): Promise<string>;
  writeTerminal(value: string): void;
  writeDiagnostic?(value: string): void;
  loadSelection(): Promise<string | undefined>;
  saveSelection(name: string | undefined): Promise<void>;
  defer?(task: DeferredTask, delayMs?: number): void;
}

const defaultHost: Host = {
  env: () => process.env,
  tty: () => process.stdout.isTTY === true,
  readTheme: readThemeFile,
  writeTerminal: writeToTerminal,
  writeDiagnostic: (value) => process.stderr.write(value),
  loadSelection: loadSavedSelection,
  saveSelection: saveSavedSelection,
  defer: deferTask,
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
    let baselinePiTheme: Theme | undefined;
    let ownedPiTheme: Theme | undefined;
    let terminalOwned = false;
    let terminalOwnedName: string | undefined;
    let activation = "not started";
    let lastIssue: string | undefined;
    let previewGeneration = 0;
    let lifecycleGeneration = 0;
    let mutationGeneration = 0;
    let commitTail: Promise<void> = Promise.resolve();
    let running = false;
    let pendingReloadReassertion:
      | { name: string; token: MutationToken }
      | undefined;
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
        source.path,
        await host.readTheme(source.path),
      );
      cache.set(source.path, parsed);
      return parsed;
    };

    const prepare = async (name: string, ctx: ExtensionContext) => {
      const source = findSource(name);
      if (!source) {
        throw new Error(`Ghostty theme ${quoteForUi(name)} was not found`);
      }
      const native = await loadNativeTheme(source);
      const ThemeClass = ctx.ui.theme.constructor as ThemeConstructor;
      return { native, piTheme: createPiTheme(native, ThemeClass) };
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

    const captureBaseline = (ctx: ExtensionContext): void => {
      if (ownedPiTheme && ctx.ui.theme === ownedPiTheme) return;
      ownedPiTheme = undefined;
      baselinePiTheme = ctx.ui.theme;
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

    const restoreBaseline = (ctx: ExtensionContext): string | undefined => {
      if (!ownedPiTheme) {
        baselinePiTheme = undefined;
        return undefined;
      }
      if (ctx.ui.theme !== ownedPiTheme) {
        ownedPiTheme = undefined;
        baselinePiTheme = undefined;
        return undefined;
      }
      if (!baselinePiTheme) return "the original Pi theme is unavailable";

      try {
        const result = ctx.ui.setTheme(baselinePiTheme);
        if (!result.success) {
          return escapeTerminalControls(
            result.error ?? "Pi rejected the original theme",
          );
        }
      } catch (error) {
        return describeError(error);
      }

      ownedPiTheme = undefined;
      baselinePiTheme = undefined;
      return undefined;
    };

    const applyPrepared = (
      prepared: Awaited<ReturnType<typeof prepare>>,
      ctx: ExtensionContext,
      options: { writeTerminal?: boolean } = {},
    ): void => {
      const reason = inactiveReason(ctx.mode, host.tty(), host.env());
      if (reason) {
        activation = `inactive because ${reason}`;
        throw new Error(`theme application cancelled because ${reason}`);
      }
      captureBaseline(ctx);
      const wroteTerminal = options.writeTerminal !== false;
      if (wroteTerminal) {
        host.writeTerminal(themeSequence(prepared.native));
        terminalOwned = true;
        terminalOwnedName = prepared.native.name;
      }

      let result: ReturnType<ExtensionContext["ui"]["setTheme"]>;
      try {
        result = ctx.ui.setTheme(prepared.piTheme);
      } catch (error) {
        const terminalError = wroteTerminal ? restoreTerminal(ctx) : undefined;
        const suffix = terminalError
          ? `; terminal rollback failed: ${terminalError}`
          : "";
        throw new Error(`${describeError(error)}${suffix}`);
      }
      if (!result.success) {
        const terminalError = wroteTerminal ? restoreTerminal(ctx) : undefined;
        const suffix = terminalError
          ? `; terminal rollback failed: ${terminalError}`
          : "";
        throw new Error(
          `${escapeTerminalControls(result.error ?? "Pi rejected the derived theme")}${suffix}`,
        );
      }

      ownedPiTheme = prepared.piTheme;
      lastIssue = undefined;
    };

    const applyName = async (
      name: string,
      ctx: ExtensionContext,
      token: MutationToken,
      options: {
        persist?: boolean;
        setActive?: boolean;
        writeTerminal?: boolean;
      } = {},
    ): Promise<boolean> => {
      const prepared = await prepare(name, ctx);
      if (!isMutationCurrent(token)) return false;
      const committed = await commitMutation(token, async () => {
        applyPrepared(prepared, ctx, {
          writeTerminal: options.writeTerminal,
        });
        if (options.setActive !== false) activeName = name;
        if (options.persist) await host.saveSelection(name);
      });
      return committed.committed;
    };

    const deferReloadReassertion = (ctx: ExtensionContext): void => {
      const pending = pendingReloadReassertion;
      pendingReloadReassertion = undefined;
      if (!pending) return;

      const reassertIfDisplaced = async (): Promise<void> => {
        if (!isMutationCurrent(pending.token)) return;
        if (ownedPiTheme && ctx.ui.theme === ownedPiTheme) return;
        try {
          await applyName(pending.name, ctx, pending.token, {
            setActive: false,
            writeTerminal: false,
          });
        } catch (error) {
          if (!isMutationCurrent(pending.token)) return;
          lastIssue = `post-reload reapply failed: ${describeError(error)}`;
          report(ctx, `Ghostty theme: ${lastIssue}.`, "warning");
        }
      };

      const defer = host.defer ?? deferTask;
      defer(reassertIfDisplaced);
      // Pi's auto/default theme paths can spend 100 ms detecting terminal
      // appearance after resource discovery. This bounded guard catches that
      // later takeover without polling or writing another terminal OSC batch.
      defer(reassertIfDisplaced, POST_RELOAD_SETTLE_MS);
    };

    interface ResetOutcome {
      persistenceError?: string;
      terminalError?: string;
      piThemeError?: string;
    }

    const resetIssues = (outcome: ResetOutcome): string[] => {
      const issues: string[] = [];
      if (outcome.terminalError) {
        issues.push(`terminal restoration failed: ${outcome.terminalError}`);
      }
      if (outcome.piThemeError) {
        issues.push(`Pi restoration failed: ${outcome.piThemeError}`);
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
        piThemeError: restoreBaseline(ctx),
      };

      try {
        await host.saveSelection(undefined);
      } catch (error) {
        outcome.persistenceError = describeError(error);
      }

      activeName = terminalOwned || ownedPiTheme ? previousName : undefined;
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
      description: "Choose and live-preview a synchronized Ghostty/Pi theme",
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
              committed.value.terminalError || committed.value.piThemeError
                ? "error"
                : "warning",
            );
          } else {
            report(
              ctx,
              "Ghostty theme reset to terminal and Pi defaults.",
              "info",
            );
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
            cache.clear();
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
              report(ctx, `Ghostty and Pi now use ${activeName}.`, "info");
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
            void prepare(name, ctx)
              .then(async (prepared) => {
                if (
                  !pickerOpen ||
                  !isMutationCurrent(token) ||
                  generation !== previewGeneration
                ) {
                  return;
                }
                await commitMutation(token, () => applyPrepared(prepared, ctx));
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
                const piThemeError = restoreBaseline(ctx);
                const issues = resetIssues({ terminalError, piThemeError });
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
            report(ctx, `Ghostty and Pi now use ${activeName}.`, "info");
          }
        } catch (error) {
          if (!isMutationCurrent(token)) return;
          lastIssue = describeError(error);
          report(ctx, `Ghostty theme: ${lastIssue}.`, "error");
        }
      },
    });

    pi.on("session_start", async (event, ctx) => {
      running = false;
      lifecycleGeneration += 1;
      invalidateMutations();
      pendingReloadReassertion = undefined;
      await commitTail;

      const previousName = activeName;
      const startupCleanupIssues = resetIssues({
        terminalError: restoreTerminal(ctx),
        piThemeError: restoreBaseline(ctx),
      });
      running = true;
      sources = [];
      cache.clear();
      activeName = terminalOwned || ownedPiTheme ? previousName : undefined;
      if (!ownedPiTheme) baselinePiTheme = undefined;
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
        cache.clear();
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
        const applied = await applyName(savedSource.name, ctx, token);
        if (applied && event.reason === "reload" && isMutationCurrent(token)) {
          pendingReloadReassertion = {
            name: savedSource.name,
            token,
          };
        }
      } catch (error) {
        if (!isMutationCurrent(token)) return;
        lastIssue = describeError(error);
        report(ctx, `Ghostty theme: ${lastIssue}.`, "warning");
      }
    });

    pi.on("resources_discover", (event, ctx) => {
      if (event.reason === "reload") deferReloadReassertion(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      running = false;
      lifecycleGeneration += 1;
      invalidateMutations();
      pendingReloadReassertion = undefined;
      await commitTail;
      restoreTerminal(ctx);
      restoreBaseline(ctx);
    });
  };
}

export default createExtension();
