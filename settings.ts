/**
 * settings.ts
 *
 * Settings data model and Settings Tab UI for Obsidian Seamless Git Backup.
 *
 * Obsidian's settings system has two distinct layers:
 *  1. The DATA layer: a plain object (PluginSettings) serialised to/from
 *     `data.json` inside the plugin folder. This is what `loadData()` and
 *     `saveData()` operate on.
 *  2. The UI layer: a `PluginSettingTab` subclass whose `display()` method
 *     renders interactive controls inside Obsidian's Settings window.
 *
 * Keeping both in this file avoids circular imports while logically grouping
 * related concerns.
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type SeamlessGitBackupPlugin from "./main";

// ─── Settings Data Model ─────────────────────────────────────────────────────

/**
 * The shape of the persisted settings object.
 *
 * Every field MUST have a corresponding default in `DEFAULT_SETTINGS` so that
 * newly installed instances of the plugin start with sane values even before
 * the user opens the settings panel.
 */
export interface PluginSettings {
  /**
   * Commit message template. Supports two placeholders:
   *  - `{{date}}` → replaced with the current date in YYYY-MM-DD format
   *  - `{{time}}` → replaced with the current time in HH:MM:SS format
   *
   * Example result: "Vault backup: 2025-06-15 at 14:30:00"
   */
  commitMessageTemplate: string;

  /**
   * When true, show a `Notice` if the user triggers a backup but there are
   * no changes to commit. Some users find this feedback helpful; others find
   * it noisy when they habitually press the backup button. Hence the toggle.
   */
  notifyOnNoChanges: boolean;
}

/**
 * Factory defaults applied on first install or when a setting key is missing
 * (e.g. after a plugin update that adds a new setting field).
 *
 * Using `Object.assign({}, DEFAULT_SETTINGS, loadedData)` in `main.ts`
 * ensures forward-compatibility: existing persisted settings override
 * defaults, and new settings fall back to defaults gracefully.
 */
export const DEFAULT_SETTINGS: PluginSettings = {
  commitMessageTemplate: "Vault backup: {{date}} at {{time}}",
  notifyOnNoChanges: true,
};

// ─── Commit Message Resolution ────────────────────────────────────────────────

/**
 * Resolves a commit message template by replacing `{{date}}` and `{{time}}`
 * placeholders with the current local date/time.
 *
 * Why is this here instead of main.ts?
 * It's a pure transformation of settings data, so it belongs alongside the
 * settings types rather than in the plugin lifecycle file.
 *
 * @param template - The raw template string from settings.
 * @returns The fully resolved commit message string.
 *
 * @example
 * resolveCommitMessage("Backup {{date}} {{time}}")
 * // → "Backup 2025-06-15 14:30:00"
 */
export function resolveCommitMessage(template: string): string {
  const now = new Date();

  // YYYY-MM-DD format — unambiguous and sorts lexicographically
  const date = now.toISOString().split("T")[0];

  // HH:MM:SS in local time — matches what users see on their system clock
  const time = now.toTimeString().split(" ")[0];

  return template
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{time\}\}/g, time);
}

// ─── Settings Tab UI ──────────────────────────────────────────────────────────

/**
 * SeamlessGitBackupSettingTab renders the plugin's settings panel inside
 * Obsidian's native Settings window.
 *
 * Obsidian calls `display()` every time the user navigates to this plugin's
 * settings section, so it is safe (and idiomatic) to rebuild the DOM from
 * scratch each time rather than trying to maintain a stateful component tree.
 */
export class SeamlessGitBackupSettingTab extends PluginSettingTab {
  /**
   * @param app    - The Obsidian App singleton (required by PluginSettingTab).
   * @param plugin - Our plugin instance, used to read and persist settings.
   */
  constructor(app: App, private readonly plugin: SeamlessGitBackupPlugin) {
    super(app, plugin);
  }

  /**
   * Builds the settings UI.
   *
   * The `containerEl` property is provided by Obsidian. We clear it first
   * to avoid duplicate controls if `display()` is called multiple times.
   *
   * Each `Setting` uses method chaining to attach a name, description, and
   * interactive control. Obsidian handles the underlying DOM creation,
   * accessibility attributes, and theming automatically.
   */
  display(): void {
    const { containerEl } = this;

    // Clear any previously rendered content
    containerEl.empty();

    // ── Section Header ──────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Seamless Git Backup" });

    containerEl.createEl("p", {
      text: "Configure how your vault is committed and pushed to your Git remote.",
      cls: "setting-item-description",
    });

    // ── Commit Message Template ─────────────────────────────────────────
    new Setting(containerEl)
      .setName("Commit message template")
      .setDesc(
        createFragment((frag) => {
          frag.appendText(
            "Template for the Git commit message. Supported placeholders:"
          );
          frag.createEl("br");
          // Show the placeholders as inline code for clarity
          frag.createEl("code", { text: "{{date}}" });
          frag.appendText(" → current date (YYYY-MM-DD),  ");
          frag.createEl("code", { text: "{{time}}" });
          frag.appendText(" → current time (HH:MM:SS)");
          frag.createEl("br");
          frag.createEl("em", {
            text: `Preview: "${resolveCommitMessage(
              this.plugin.settings.commitMessageTemplate
            )}"`,
            cls: "sgb-preview-text",
          });
        })
      )
      .addText((text) =>
        text
          .setPlaceholder("Vault backup: {{date}} at {{time}}")
          .setValue(this.plugin.settings.commitMessageTemplate)
          .onChange(async (value) => {
            // Persist the new template immediately on every keystroke.
            // Obsidian's settings system is designed for this pattern.
            this.plugin.settings.commitMessageTemplate =
              value.trim() || DEFAULT_SETTINGS.commitMessageTemplate;
            await this.plugin.saveSettings();

            // Re-render the tab so the preview text updates live
            this.display();
          })
      );

    // ── Notify on No Changes Toggle ─────────────────────────────────────
    new Setting(containerEl)
      .setName("Notify when vault is already up-to-date")
      .setDesc(
        "Show a notice when you trigger a backup but there are no new changes to commit. " +
          "Disable this if you find the notification distracting."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.notifyOnNoChanges)
          .onChange(async (value) => {
            this.plugin.settings.notifyOnNoChanges = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Help & Tips ─────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Requirements & Setup" });

    const infoList = containerEl.createEl("ul", { cls: "sgb-info-list" });

    const requirements = [
      "Git must be installed and available on your system PATH.",
      "Your vault folder must be a Git repository (run `git init` inside it).",
      "A remote must be configured (e.g. `git remote add origin <url>`).",
      "Authentication (SSH key or HTTPS token) must be pre-configured — this plugin does not handle credentials.",
    ];

    for (const req of requirements) {
      infoList.createEl("li", { text: req });
    }
  }
}

/**
 * Helper: creates a DocumentFragment using a builder callback.
 * Obsidian's `setDesc()` accepts either a string or a DocumentFragment,
 * allowing rich HTML content in descriptions.
 *
 * @param builder - Function that receives an empty fragment and populates it.
 * @returns The populated DocumentFragment.
 */
function createFragment(builder: (frag: DocumentFragment) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  builder(frag);
  return frag;
}
