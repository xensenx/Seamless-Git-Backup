/**
 * uiHandlers.ts
 *
 * User Interface feedback layer for Obsidian Seamless Git Backup.
 *
 * This module translates low-level GitHandler results and errors into
 * user-friendly Obsidian UI elements. By centralising all UI feedback here,
 * `main.ts` stays clean and every user-visible string lives in one place —
 * making it easy to audit, localise, or update copy in the future.
 *
 * Design decisions:
 *  - Notices are the primary feedback channel because they are non-blocking
 *    and native to Obsidian. Users see them without losing focus.
 *  - A Modal is used only for the error detail view, because errors deserve
 *    the user's full attention and may contain actionable multi-line content.
 *  - Notice durations are tuned: info notices auto-dismiss quickly (they are
 *    transient state indicators), while error notices persist until dismissed
 *    so the user has time to read them.
 */

import { Notice, Modal, App } from "obsidian";
import { GitError, GitErrorCode } from "./gitHandler";

// ─── Notice Duration Constants ────────────────────────────────────────────────

/**
 * Duration (ms) for informational / transient notices.
 * Short enough not to be annoying for repeated backups.
 */
const NOTICE_DURATION_INFO = 3000;

/**
 * Duration (ms) for success and warning notices.
 * Slightly longer so the user has time to read before it fades.
 */
const NOTICE_DURATION_NORMAL = 5000;

/**
 * Duration (ms) for error notices.
 * Long enough to read; 0 would mean "never auto-dismiss" which can be
 * overwhelming if there are repeated errors, so we cap at 10 s.
 */
const NOTICE_DURATION_ERROR = 10000;

// ─── Notice Helpers ───────────────────────────────────────────────────────────

/**
 * Shows a transient "Backup in progress..." notice.
 *
 * Returns the Notice object so the caller can dismiss it programmatically
 * once the operation completes (success or failure).
 *
 * @returns The active Notice instance.
 */
export function showBackupInProgressNotice(): Notice {
  return new Notice("⏳ Backup in progress…", NOTICE_DURATION_INFO);
}

/**
 * Shows a success notice confirming the backup completed.
 */
export function showBackupSuccessNotice(): void {
  new Notice("✅ Backup complete! Changes pushed to remote.", NOTICE_DURATION_NORMAL);
}

/**
 * Shows a notice informing the user the vault is already up-to-date.
 * Only called when `notifyOnNoChanges` is enabled in settings.
 */
export function showNoChangesNotice(): void {
  new Notice("ℹ️ No changes to backup — vault is already up-to-date.", NOTICE_DURATION_NORMAL);
}

/**
 * Translates a `GitError` (or any unexpected `Error`) into a user-friendly
 * Notice with a clear, actionable message.
 *
 * We deliberately map each `GitErrorCode` to a distinct human-readable
 * string so users get precise guidance rather than a generic "something
 * went wrong" message.
 *
 * @param error - The error caught during the backup process.
 * @param app   - The Obsidian App instance, used to open the detail Modal.
 */
export function showBackupErrorNotice(error: unknown, app: App): void {
  const { userMessage, technicalDetail } = resolveErrorContent(error);

  // Show a brief top-level notice; include a "Details" cue if there's more
  const noticeText = technicalDetail
    ? `❌ ${userMessage}\n(Click for details)`
    : `❌ ${userMessage}`;

  const notice = new Notice(noticeText, NOTICE_DURATION_ERROR);

  // Clicking the notice opens the full detail Modal.
  // This pattern keeps the notice compact while still offering depth.
  if (technicalDetail) {
    notice.noticeEl.addEventListener("click", () => {
      new GitErrorModal(app, userMessage, technicalDetail).open();
    });
    // Style the notice as clickable so the user knows it's interactive
    notice.noticeEl.addClass("sgb-notice-clickable");
  }
}

/**
 * Shows a generic warning notice (used for pre-flight check failures that
 * are not Git errors, e.g. running on mobile accidentally).
 *
 * @param message - The warning text to display.
 */
export function showWarningNotice(message: string): void {
  new Notice(`⚠️ ${message}`, NOTICE_DURATION_NORMAL);
}

// ─── Error Content Resolution ─────────────────────────────────────────────────

/**
 * Maps a caught error value to a user-friendly message and an optional
 * technical detail string.
 *
 * The `userMessage` is suitable for display in the UI.
 * The `technicalDetail` is the raw error message, shown in the Modal for
 * advanced users who want to diagnose the problem themselves.
 */
function resolveErrorContent(error: unknown): {
  userMessage: string;
  technicalDetail: string | null;
} {
  if (error instanceof GitError) {
    return {
      userMessage: gitErrorCodeToMessage(error.code),
      technicalDetail: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      userMessage: "An unexpected error occurred during backup.",
      technicalDetail: error.message,
    };
  }

  return {
    userMessage: "An unknown error occurred during backup.",
    technicalDetail: String(error),
  };
}

/**
 * Maps `GitErrorCode` values to concise, user-friendly English strings.
 *
 * Why not embed these in GitHandler?
 * GitHandler is a pure logic layer — it should not know about UI concerns
 * like how messages are worded for end-users. Keeping the mapping here
 * maintains the separation between domain logic and presentation.
 */
function gitErrorCodeToMessage(code: GitErrorCode): string {
  const messages: Record<GitErrorCode, string> = {
    GIT_NOT_INSTALLED:
      "Git is not installed or not on your PATH. Install Git and restart Obsidian.",
    NOT_A_REPO:
      "This vault is not a Git repository. Run `git init` inside your vault folder.",
    NO_REMOTE:
      "No Git remote configured. Add one with `git remote add origin <url>`.",
    AUTH_FAILED:
      "Git authentication failed. Check your SSH key or HTTPS credentials.",
    NETWORK_ERROR:
      "Network error. Check your internet connection and try again.",
    NOTHING_TO_COMMIT:
      "Nothing to commit — the working tree is clean.",
    PUSH_REJECTED:
      "Push was rejected by the remote. You may need to pull first.",
    TIMEOUT:
      "Git command timed out (60 s). Check your connection or SSH agent.",
    UNKNOWN_GIT_ERROR:
      "An unexpected Git error occurred. See details for more information.",
  };

  return messages[code] ?? "An unexpected Git error occurred.";
}

// ─── Error Detail Modal ───────────────────────────────────────────────────────

/**
 * GitErrorModal displays the full technical detail of a Git failure.
 *
 * It is opened when the user clicks on an error Notice, giving advanced
 * users access to the raw error output without cluttering the Notice itself.
 *
 * We extend Obsidian's `Modal` class, which handles:
 *  - Focus trapping while open
 *  - Keyboard (Escape) dismissal
 *  - Backdrop click dismissal
 *  - Theming via CSS variables
 */
export class GitErrorModal extends Modal {
  constructor(
    app: App,
    private readonly userMessage: string,
    private readonly technicalDetail: string
  ) {
    super(app);
  }

  /**
   * Builds the Modal's DOM content.
   * Called by Obsidian when the Modal is opened.
   */
  onOpen(): void {
    const { contentEl } = this;

    // ── Modal Header ────────────────────────────────────────────────────
    contentEl.createEl("h2", {
      text: "Git Backup Error",
      cls: "sgb-modal-title",
    });

    // ── User-Friendly Summary ───────────────────────────────────────────
    contentEl.createEl("p", {
      text: this.userMessage,
      cls: "sgb-modal-summary",
    });

    // ── Technical Details Section ───────────────────────────────────────
    contentEl.createEl("h3", {
      text: "Technical details",
      cls: "sgb-modal-detail-heading",
    });

    // Use a <pre> element to preserve whitespace and line breaks from stderr
    const pre = contentEl.createEl("pre", { cls: "sgb-modal-detail-pre" });
    pre.createEl("code", { text: this.technicalDetail });

    // ── Troubleshooting Tips ────────────────────────────────────────────
    contentEl.createEl("h3", {
      text: "Common fixes",
      cls: "sgb-modal-detail-heading",
    });

    const tipsList = contentEl.createEl("ul", { cls: "sgb-modal-tips" });
    const tips = [
      "Ensure Git is installed: open a terminal and run `git --version`.",
      "Check the vault is a repo: run `git status` inside your vault folder.",
      "Verify a remote exists: run `git remote -v`.",
      "Confirm authentication works: run `git push` in your terminal.",
    ];
    for (const tip of tips) {
      tipsList.createEl("li", { text: tip });
    }

    // ── Close Button ────────────────────────────────────────────────────
    // Obsidian's native modal close icon handles Escape/backdrop, but an
    // explicit button improves discoverability for new users.
    const buttonRow = contentEl.createEl("div", { cls: "sgb-modal-button-row" });
    const closeBtn = buttonRow.createEl("button", {
      text: "Close",
      cls: "mod-cta sgb-modal-close-btn",
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  /**
   * Cleans up the Modal's DOM when it is closed.
   * Obsidian calls this automatically; we just need to empty the container.
   */
  onClose(): void {
    this.contentEl.empty();
  }
}
