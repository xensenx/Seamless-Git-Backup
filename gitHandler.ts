/**
 * gitHandler.ts
 *
 * Core Git Engine for Obsidian Seamless Git Backup.
 *
 * Key reliability guarantees in this version:
 *  1. Uses `execFile` (not `exec`) — arguments are passed as an array, so
 *     the commit message is NEVER interpolated into a shell string. This
 *     eliminates shell-injection entirely; no quoting or escaping needed.
 *  2. Every Git command runs with a hard timeout (GIT_TIMEOUT_MS). If Git
 *     hangs (e.g. waiting for SSH passphrase with no TTY), the promise
 *     rejects cleanly instead of blocking Obsidian indefinitely.
 *  3. `performBackup` re-checks for staged changes AFTER `git add -A`.
 *     If nothing was actually staged (e.g. only .gitignored files changed),
 *     we skip the commit+push and return early — preventing empty commits.
 *  4. Each step (add, commit, push) throws with a distinct error code so
 *     the user sees precisely which operation failed.
 *  5. Pre-flight checks (git installed, vault is a repo) are separate public
 *     methods called before any mutating operation, enabling fast-fail UX.
 */

import { execFile, spawnSync } from "child_process";
import { promisify } from "util";

// execFile does NOT invoke a shell — it executes the binary directly with
// argv. This is fundamentally safer than exec() for user-supplied strings
// because there is no shell to interpret metacharacters.
const execFileAsync = promisify(execFile);

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Hard timeout for every Git subprocess (milliseconds).
 *
 * Why 60 s for push but shorter for read commands?
 * `git push` may legitimately take tens of seconds on slow connections or
 * large commits. However, we use one constant to keep things simple — 60 s
 * is plenty for any read command and a reasonable ceiling for push over a
 * residential connection.
 *
 * If Git has not exited within this window (e.g. waiting for an SSH
 * passphrase with no TTY attached), the child process is killed with SIGTERM
 * and the promise rejects with a TIMEOUT error.
 */
const GIT_TIMEOUT_MS = 60_000;

// ─── Typed Error Classes ──────────────────────────────────────────────────────

/**
 * All errors thrown by GitHandler are instances of GitError.
 * The `code` discriminant lets callers (uiHandlers.ts) map each failure mode
 * to a precise user-facing message without string-parsing.
 */
export class GitError extends Error {
  constructor(
    public readonly code: GitErrorCode,
    message: string
  ) {
    super(message);
    this.name = "GitError";
    Object.setPrototypeOf(this, GitError.prototype);
  }
}

export type GitErrorCode =
  | "GIT_NOT_INSTALLED"   // `git` binary not found on PATH
  | "NOT_A_REPO"          // vault directory is not a Git repository
  | "NO_REMOTE"           // no remote configured; push would fail
  | "AUTH_FAILED"         // SSH key or HTTPS credentials rejected
  | "NETWORK_ERROR"       // could not reach the remote host
  | "NOTHING_TO_COMMIT"   // nothing was staged after `git add -A`
  | "PUSH_REJECTED"       // remote rejected the push
  | "TIMEOUT"             // Git process exceeded GIT_TIMEOUT_MS
  | "UNKNOWN_GIT_ERROR";  // catch-all for unexpected stderr

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface GitStatusResult {
  /** True when `git status --porcelain` returns any output lines. */
  hasChanges: boolean;
  /** Raw porcelain output for debugging. */
  rawStatus: string;
}

// ─── Internal exec result ─────────────────────────────────────────────────────

interface ExecResult {
  stdout: string;
  stderr: string;
}

// ─── GitHandler ───────────────────────────────────────────────────────────────

export class GitHandler {
  constructor(private readonly vaultPath: string) {}

  // ── Private: safe subprocess runner ────────────────────────────────────────

  /**
   * Runs `git <args>` in the vault directory without involving a shell.
   *
   * Passing `args` as an array to `execFile` means the OS calls git directly
   * with those arguments — no shell expansion, no quoting, no injection risk.
   *
   * A race between `execFileAsync` and a manual timeout promise ensures the
   * subprocess is always killed if it hangs, even on platforms where
   * `execFile`'s own `timeout` option has inconsistent behaviour.
   *
   * @param args   - Git subcommand and flags (e.g. ["status", "--porcelain"]).
   * @param stepCode - The GitErrorCode to use if this step fails, enabling
   *                   precise per-step error attribution.
   * @returns stdout of the git invocation (trimmed).
   * @throws GitError
   */
  private async git(
    args: string[],
    stepCode?: GitErrorCode
  ): Promise<string> {
    // Build a timeout promise that rejects after GIT_TIMEOUT_MS.
    // We keep a reference to the timer so we can clear it on success,
    // preventing the Node.js event loop from being held open.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new GitError(
            "TIMEOUT",
            `Git command timed out after ${GIT_TIMEOUT_MS / 1000}s: git ${args.join(" ")}`
          )
        );
      }, GIT_TIMEOUT_MS);
    });

    try {
      // Race: whichever settles first wins.
      const result = await Promise.race([
        execFileAsync("git", args, {
          cwd: this.vaultPath,
          maxBuffer: 10 * 1024 * 1024, // 10 MB — safe for large vaults
        }) as Promise<ExecResult>,
        timeoutPromise,
      ]);
      return result.stdout.trim();
    } catch (error: unknown) {
      // If it's already a GitError (e.g. from our timeout), re-throw directly.
      if (error instanceof GitError) throw error;
      // Otherwise parse the raw exec error, annotating it with the step code.
      throw this.parseExecError(error, stepCode);
    } finally {
      // Always clear the timer — even on success — to avoid a dangling setTimout.
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Converts a raw `execFile` rejection into a typed `GitError`.
   *
   * We prefer inspecting `stderr` over exit codes because Git's stderr
   * strings are stable across versions; exit codes vary by platform/build.
   *
   * The optional `stepCode` parameter lets the caller pin failures from
   * specific steps (add/commit/push) to their own error code rather than
   * relying solely on stderr pattern matching, which improves precision when
   * the same stderr pattern could appear in multiple steps.
   */
  private parseExecError(error: unknown, stepCode?: GitErrorCode): GitError {
    const stderr =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr: string }).stderr)
        : "";
    const message =
      error instanceof Error ? error.message : String(error);

    // ── Ordered pattern matching (specific → general) ──────────────────

    if (
      message.includes("ENOENT") ||
      message.includes("command not found") ||
      message.includes("not recognized")
    ) {
      return new GitError(
        "GIT_NOT_INSTALLED",
        "Git binary not found. Install Git and ensure it is on your PATH."
      );
    }

    if (
      stderr.includes("not a git repository") ||
      stderr.includes("fatal: not a git repo")
    ) {
      return new GitError(
        "NOT_A_REPO",
        "This vault is not a Git repository. Run `git init` inside your vault folder."
      );
    }

    if (
      stderr.includes("No configured push destination") ||
      stderr.includes("no upstream") ||
      stderr.includes("does not have an upstream branch") ||
      stderr.includes("no remote")
    ) {
      return new GitError(
        "NO_REMOTE",
        "No Git remote configured. Add one with `git remote add origin <url>`."
      );
    }

    if (
      stderr.includes("Authentication failed") ||
      stderr.includes("Permission denied (publickey)") ||
      stderr.includes("Invalid username or password") ||
      stderr.includes("could not read Username") ||
      stderr.includes("Host key verification failed")
    ) {
      return new GitError(
        "AUTH_FAILED",
        "Git authentication failed. Check your SSH key or HTTPS credentials."
      );
    }

    if (
      stderr.includes("Could not resolve host") ||
      stderr.includes("Connection refused") ||
      stderr.includes("Network is unreachable") ||
      stderr.includes("Failed to connect") ||
      stderr.includes("unable to access")
    ) {
      return new GitError(
        "NETWORK_ERROR",
        "Network error. Check your internet connection and try again."
      );
    }

    if (
      stderr.includes("nothing to commit") ||
      stderr.includes("nothing added to commit")
    ) {
      return new GitError(
        "NOTHING_TO_COMMIT",
        "Nothing to commit — the working tree is clean."
      );
    }

    if (
      stderr.includes("rejected") ||
      stderr.includes("non-fast-forward") ||
      stderr.includes("Updates were rejected")
    ) {
      return new GitError(
        "PUSH_REJECTED",
        "Push was rejected by the remote. You may need to pull first."
      );
    }

    // If the caller specified a step code, use it as the fallback so the
    // user at least knows which operation failed.
    if (stepCode) {
      return new GitError(
        stepCode,
        `Git ${args_label(stepCode)} failed: ${stderr || message}`
      );
    }

    return new GitError(
      "UNKNOWN_GIT_ERROR",
      `Unexpected Git error: ${stderr || message}`
    );
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Confirms that `git` is available on the system PATH.
   * Runs `git --version` (no side-effects) as the probe.
   *
   * @throws GitError("GIT_NOT_INSTALLED")
   */
  async checkGitInstallation(): Promise<string> {
    return this.git(["--version"]);
  }

  /**
   * Confirms the vault root is inside a Git work tree.
   * Uses `git rev-parse --is-inside-work-tree` — the canonical check.
   *
   * @throws GitError("NOT_A_REPO")
   */
  async checkIfRepo(): Promise<boolean> {
    const result = await this.git(["rev-parse", "--is-inside-work-tree"]);
    return result === "true";
  }

  /**
   * Returns the current working-tree status.
   * `--porcelain` output is machine-stable across Git versions.
   * Empty output → clean tree (no changes to back up).
   */
  async getGitStatus(): Promise<GitStatusResult> {
    const rawStatus = await this.git(["status", "--porcelain"]);
    return {
      hasChanges: rawStatus.length > 0,
      rawStatus,
    };
  }

  /**
   * Performs the full backup: add → (verify staged) → commit → push.
   *
   * Safety guarantees:
   *  - The commit message is passed as a discrete argv element — never
   *    interpolated into a shell string — so no sanitisation is needed and
   *    shell injection is structurally impossible.
   *  - After `git add -A` we re-query `git diff --cached --quiet` to confirm
   *    something is actually staged. If not (e.g. every changed file is in
   *    .gitignore), we throw NOTHING_TO_COMMIT rather than creating an empty
   *    commit.
   *  - Each step uses a distinct `stepCode` so error messages name the exact
   *    failing operation (staging failed / commit failed / push failed).
   *
   * @param commitMessage - The fully-resolved commit message (placeholders
   *                        already replaced). Passed verbatim to git; no
   *                        escaping required or applied.
   * @throws GitError on any step failure.
   */
  async performBackup(commitMessage: string): Promise<void> {
    // ── Step 1: Stage all changes ───────────────────────────────────────
    // -A stages new, modified, AND deleted files from the entire work tree.
    // Errors here indicate repo corruption or permission issues.
    await this.git(["add", "-A"], "UNKNOWN_GIT_ERROR");

    // ── Step 2: Verify something was actually staged ────────────────────
    // `git diff --cached --quiet` exits 0 (nothing staged) or 1 (staged).
    // Uses spawnSync internally to avoid the promisify exit-code ambiguity.
    const hasStagedChanges = this.checkHasStagedChanges();
    if (!hasStagedChanges) {
      // Nothing was staged — all changed files must be gitignored or the
      // working tree is already in sync with the index. Abort cleanly.
      throw new GitError(
        "NOTHING_TO_COMMIT",
        "Nothing to commit — all changes are ignored or already staged."
      );
    }

    // ── Step 3: Commit ──────────────────────────────────────────────────
    // The message is the FOURTH element in the argv array. execFile passes
    // it verbatim to git — no shell, no quoting, no injection possible.
    await this.git(["commit", "-m", commitMessage], "UNKNOWN_GIT_ERROR");

    // ── Step 4: Push ────────────────────────────────────────────────────
    // --follow-tags pushes any local tags alongside the commit.
    await this.git(["push", "--follow-tags"], "PUSH_REJECTED");
  }

  /**
   * Returns true if the Git index contains staged changes ready to commit.
   *
   * `git diff --cached --quiet` exit code semantics:
   *   0  → index is clean (nothing staged)
   *   1  → staged changes exist          ← the EXPECTED non-zero case
   *  >1  → git itself encountered an error
   *
   * WHY spawnSync instead of promisify(execFile)?
   * promisify(execFile) rejects on ANY non-zero exit and stuffs the numeric
   * exit code into `.code` on the thrown Error — but `.code` is ALSO used by
   * Node's ErrnoException for POSIX string codes like "ENOENT". There is no
   * reliable way to distinguish "exit code 1" from "ENOENT" after the fact.
   *
   * spawnSync returns a plain result object with a `.status` field that is
   * always the raw numeric exit code (or null on signal), with no ambiguity.
   * It is synchronous, but this check is instantaneous (no I/O, pure index
   * read) so blocking the JS thread for <5 ms is acceptable.
   */
  private checkHasStagedChanges(): boolean {
    const result = spawnSync("git", ["diff", "--cached", "--quiet"], {
      cwd: this.vaultPath,
      // pipe stdio so the child never blocks waiting for a TTY
      stdio: "pipe",
      // 10 s hard ceiling — this command is near-instant in any healthy repo
      timeout: 10_000,
    });

    // spawnSync sets result.error for OS-level failures (e.g. ENOENT when
    // git is not installed). This is distinct from a non-zero exit code.
    if (result.error) {
      throw this.parseExecError(result.error);
    }

    // result.status is the raw numeric exit code, or null when killed by signal.
    const exitCode = result.status;

    if (exitCode === null) {
      // Killed by signal — most likely our own 10 s timeout via SIGTERM.
      throw new GitError(
        "TIMEOUT",
        "git diff --cached timed out while checking staged changes."
      );
    }

    if (exitCode === 0) {
      return false; // Nothing staged — index is clean
    }

    if (exitCode === 1) {
      return true;  // Staged changes exist — safe to commit
    }

    // exitCode > 1: git itself failed (corrupt repo, permission error, etc.)
    const stderr = result.stderr?.toString().trim() ?? "";
    throw this.parseExecError(
      Object.assign(
        new Error(`git diff --cached --quiet exited with code ${exitCode}`),
        { stderr }
      )
    );
  }

  /** Returns the vault path this handler is bound to. */
  getVaultPath(): string {
    return this.vaultPath;
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Maps a GitErrorCode to a human-readable step label for fallback messages.
 * Keeps error attribution readable without needing a full lookup table.
 */
function args_label(code: GitErrorCode): string {
  const labels: Partial<Record<GitErrorCode, string>> = {
    PUSH_REJECTED: "push",
    NOTHING_TO_COMMIT: "commit",
  };
  return labels[code] ?? "operation";
}
