/**
 * main.ts
 *
 * Entry point for the Obsidian Seamless Git Backup plugin.
 *
 * This file is responsible for the plugin lifecycle (onload / onunload) and
 * orchestrates the high-level backup flow. Low-level concerns (Git commands,
 * settings data, UI feedback) are intentionally delegated to their respective
 * modules so this file stays readable and easy to reason about.
 *
 * Architecture overview:
 *
 *   main.ts          ← orchestration & lifecycle
 *     ├── gitHandler.ts    ← Git subprocess logic
 *     ├── settings.ts      ← settings model & tab UI
 *     └── uiHandlers.ts    ← notices & modals
 */

import { Plugin, Platform, Notice } from "obsidian";
import { GitHandler } from "./gitHandler";
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  SeamlessGitBackupSettingTab,
  resolveCommitMessage,
} from "./settings";
import {
  showBackupInProgressNotice,
  showBackupSuccessNotice,
  showNoChangesNotice,
  showBackupErrorNotice,
  showWarningNotice,
} from "./uiHandlers";

/**
 * SeamlessGitBackupPlugin is the root class Obsidian instantiates.
 *
 * The `default export` at the bottom of this file is what Obsidian looks for
 * when it loads the plugin bundle. The class name is arbitrary but should
 * match the plugin's purpose for clarity.
 */
export default class SeamlessGitBackupPlugin extends Plugin {
  /** Runtime copy of the persisted settings, kept in sync with `data.json`. */
  settings!: PluginSettings;

  /**
   * Git engine instance.
   * Initialised in `onload()` after we have access to the vault path.
   * Declared with `!` because TypeScript can't know it's assigned in onload.
   */
  private gitHandler!: GitHandler;

  /**
   * Track whether a backup is currently in progress to prevent concurrent
   * executions if the user clicks the ribbon button multiple times quickly.
   */
  private isBackupRunning = false;

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Called by Obsidian when the plugin is loaded (on startup or after enable).
   *
   * All setup — settings loading, UI registration, command palette, etc. —
   * happens here. Obsidian expects `onload()` to return quickly; async
   * operations (like loading settings from disk) are awaited inside.
   */
  async onload(): Promise<void> {
    // ── Desktop Guard ───────────────────────────────────────────────────
    // `child_process` is a Node.js built-in. It does not exist in the mobile
    // Capacitor runtime. Attempting to call it on mobile would throw at
    // runtime. `Platform.isDesktop` is the canonical Obsidian API check.
    //
    // Note: `manifest.json` already sets `isDesktopOnly: true`, which means
    // Obsidian will not show the plugin in the mobile Community Plugins list.
    // This guard is a belt-and-suspenders safety net in case someone side-
    // loads the plugin onto mobile, or Obsidian's own guard is bypassed.
    if (!Platform.isDesktop) {
      new Notice(
        "Seamless Git Backup requires desktop Obsidian. " +
          "It uses system Git via Node.js and cannot run on mobile.",
        10000
      );
      console.warn("[Seamless Git Backup] Plugin disabled: not running on desktop.");
      return; // Abort load — do not register any UI elements
    }

    // ── Settings ────────────────────────────────────────────────────────
    await this.loadSettings();

    // ── Git Handler ─────────────────────────────────────────────────────
    // `this.app.vault.adapter.getBasePath()` is the Obsidian API to get the
    // absolute filesystem path to the vault root. We pass it to GitHandler
    // so every Git command runs with the correct working directory.
    //
    // Type assertion: We know we are on desktop (checked above), so the
    // adapter is a `FileSystemAdapter` which exposes `getBasePath()`.
    // The obsidian types expose this via `(this.app.vault.adapter as any)` —
    // a necessary concession until the official types export it fully.
    const vaultPath = (
      this.app.vault.adapter as unknown as { getBasePath: () => string }
    ).getBasePath();

    this.gitHandler = new GitHandler(vaultPath);

    // ── Ribbon Icon ─────────────────────────────────────────────────────
    // The ribbon is the left-hand icon strip. We add a git-commit icon
    // (from the bundled Lucide icon set) as a one-click backup trigger.
    // The aria-label becomes the tooltip text shown on hover.
    this.addRibbonIcon(
      "git-commit-horizontal", // Lucide icon name bundled with Obsidian
      "Seamless Git Backup: Perform backup now",
      (_event: MouseEvent) => {
        // Fire-and-forget: we use void to silence the "unhandled promise"
        // lint warning. Errors are caught inside executeBackup().
        void this.executeBackup();
      }
    );

    // ── Command Palette ─────────────────────────────────────────────────
    // Registers an entry in Obsidian's command palette (Ctrl/Cmd+P).
    // Users can also bind this to a hotkey in Settings → Hotkeys.
    this.addCommand({
      id: "trigger-backup",
      name: "Perform Git Backup",
      // `callback` (not `checkCallback`) because this command is always
      // available on desktop — no context check needed.
      callback: () => {
        void this.executeBackup();
      },
    });

    // ── Settings Tab ────────────────────────────────────────────────────
    // Registers our custom settings panel under Settings → Plugin Options.
    this.addSettingTab(new SeamlessGitBackupSettingTab(this.app, this));

    console.log("[Seamless Git Backup] Plugin loaded successfully.");
  }

  /**
   * Called by Obsidian when the plugin is disabled or Obsidian quits.
   *
   * We do not need to explicitly unregister the ribbon icon, commands, or
   * settings tab — Obsidian handles that cleanup automatically. This hook
   * exists for future use (e.g. cancelling in-flight operations, clearing
   * intervals, or cleaning up event listeners added with `.registerEvent()`).
   */
  onunload(): void {
    console.log("[Seamless Git Backup] Plugin unloaded.");
  }

  // ─── Settings Persistence ──────────────────────────────────────────────────

  /**
   * Loads persisted settings from Obsidian's `data.json` and merges them
   * with `DEFAULT_SETTINGS`.
   *
   * The `Object.assign` merge pattern ensures:
   *  1. Default values are applied for any keys missing from `data.json`
   *     (e.g. after a plugin update that adds a new setting).
   *  2. User values override defaults for all existing keys.
   *  3. We never mutate `DEFAULT_SETTINGS` itself.
   */
  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    ) as PluginSettings;
  }

  /**
   * Persists the current `settings` object to `data.json`.
   * Called by the settings tab whenever a control value changes.
   */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ─── Backup Execution ──────────────────────────────────────────────────────

  /**
   * Orchestrates the full backup flow: pre-flight checks → status → backup.
   *
   * This method is the single entry point called by both the ribbon icon and
   * the command palette. It:
   *  1. Guards against concurrent executions.
   *  2. Runs pre-flight checks (git installed, vault is a repo).
   *  3. Checks for uncommitted changes.
   *  4. Stages, commits, and pushes if changes exist.
   *  5. Handles all errors via `uiHandlers` for a consistent UX.
   */
  private async executeBackup(): Promise<void> {
    // ── Concurrency Guard ───────────────────────────────────────────────
    // Git operations are not safe to run concurrently in the same repo.
    // If the user double-clicks the ribbon, we silently ignore the second click.
    if (this.isBackupRunning) {
      showWarningNotice("A backup is already in progress. Please wait.");
      return;
    }
    this.isBackupRunning = true;

    // Show an in-progress notice and keep a reference so we can dismiss it.
    const progressNotice = showBackupInProgressNotice();

    try {
      // ── Pre-flight: Git Installed ─────────────────────────────────────
      // Run this first so users get an immediate, clear error if Git is
      // missing rather than a cryptic "not a repo" error later.
      await this.gitHandler.checkGitInstallation();

      // ── Pre-flight: Vault is a Git Repo ───────────────────────────────
      await this.gitHandler.checkIfRepo();

      // ── Check for Changes ─────────────────────────────────────────────
      const status = await this.gitHandler.getGitStatus();

      if (!status.hasChanges) {
        // Dismiss in-progress notice before showing the no-changes one
        progressNotice.hide();

        if (this.settings.notifyOnNoChanges) {
          showNoChangesNotice();
        }
        return; // Nothing to do — exit cleanly
      }

      // ── Resolve Commit Message ────────────────────────────────────────
      // Replace `{{date}}` and `{{time}}` placeholders with current values.
      // We do this immediately before committing so the timestamp is accurate.
      const commitMessage = resolveCommitMessage(
        this.settings.commitMessageTemplate
      );

      // ── Perform Backup ────────────────────────────────────────────────
      await this.gitHandler.performBackup(commitMessage);

      // Success: dismiss progress notice and show confirmation
      progressNotice.hide();
      showBackupSuccessNotice();

      console.log(`[Seamless Git Backup] Backup complete. Commit: "${commitMessage}"`);
    } catch (error: unknown) {
      // ── Error Handling ────────────────────────────────────────────────
      // Dismiss the in-progress notice so it doesn't linger alongside the
      // error notice, which would be confusing.
      progressNotice.hide();

      // Translate the error into a user-friendly notice (+ optional modal)
      showBackupErrorNotice(error, this.app);

      // Always log the raw error for users who consult the developer console
      console.error("[Seamless Git Backup] Backup failed:", error);
    } finally {
      // ── Reset Concurrency Flag ────────────────────────────────────────
      // `finally` guarantees this runs whether we succeeded, errored, or
      // returned early — so the guard is always released.
      this.isBackupRunning = false;
    }
  }
}
