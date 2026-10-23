import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { baseDir } from "./paths";
import { loadConfig } from "./config";
import { withFileLock } from "./filelock";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";

// Claude Code records folder trust as projects[<key>].hasTrustDialogAccepted
// in its global config, keyed by the canonical git root (the main checkout,
// even from a linked worktree) or the dir itself outside git. Claude's default
// project entry carries an explicit false, so am leaves any false alone rather
// than guess whether the user declined.

// Same resolution as Claude Code: CLAUDE_CONFIG_DIR or ~, with the legacy
// ~/.claude/.config.json winning when it is a non-empty file.
export function claudeGlobalConfigFile(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const legacy = join(configDir || join(process.env.HOME || homedir(), ".claude"), ".config.json");
  try {
    const stat = statSync(legacy);
    if (stat.isFile() && stat.size > 0) return legacy;
  } catch {
    // no legacy file
  }
  const suffix = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
  return join(configDir || process.env.HOME || homedir(), `.claude${suffix}.json`);
}

function git(dir: string, ...args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

export function claudeTrustKey(dir: string): string {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return resolve(dir);
  }
  const common = git(real, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common && basename(common) === ".git") return realpathSync(dirname(common));
  return git(real, "rev-parse", "--show-toplevel") ?? real;
}

// Trust entries am wrote (key -> when). Only gc removes them, and only once the
// folder is gone: the user may rely on trust am granted, and a worktree agent's
// key is the user's main checkout.
export function claudeTrustLedgerFile(): string {
  return join(baseDir(), "claude-trusted-dirs.json");
}

export function readClaudeTrustLedger(): Record<string, string> {
  return readJsonOrNull<Record<string, string>>(claudeTrustLedgerFile()) ?? {};
}

function withLedger<T>(fn: (ledger: Record<string, string>) => T): T {
  mkdirSync(baseDir(), { recursive: true });
  return withFileLock(`${claudeTrustLedgerFile()}.lock`, () => {
    const ledger = readClaudeTrustLedger();
    const before = JSON.stringify(ledger);
    const result = fn(ledger);
    if (JSON.stringify(ledger) !== before) writeJsonAtomic(claudeTrustLedgerFile(), ledger);
    return result;
  });
}

// Claude Code's proper-lockfile convention: mkdir <config>.lock, stale after
// 10s without an mtime refresh.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

function withClaudeConfigLock<T>(file: string, fn: () => T): T | undefined {
  const lock = `${file}.lock`;
  const giveUp = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      try {
        const stat = lstatSync(lock);
        if (!stat.isDirectory()) return undefined;
        if (stat.mtimeMs < Date.now() - LOCK_STALE_MS) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        // released between mkdir and lstat, or a rival broke it first
      }
      if (Date.now() >= giveUp) return undefined;
      Bun.sleepSync(Math.min(20 * 2 ** attempt, 200) * (1 + Math.random()));
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // already gone
    }
  }
}

// Re-reads under the lock and rewrites the file only when fn changed it.
// Undefined when the config is missing, unparseable, a symlink, owned by
// someone else, or the lock is held past LOCK_WAIT_MS. Claude Code's
// exit-time flushes write without the lock, so a write landing in the same
// few milliseconds can still be lost either way; Claude's own sessions race
// each other the same way.
function editClaudeConfig<T>(fn: (config: Record<string, any>) => { result: T; changed: boolean }): T | undefined {
  const file = claudeGlobalConfigFile();
  if (!existsSync(file)) return undefined;
  return withClaudeConfigLock(file, () => {
    let config: Record<string, any>;
    let mode: number;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.uid !== process.getuid?.()) return undefined;
      mode = stat.mode & 0o777;
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
    const { result, changed } = fn(config);
    if (!changed) return result;
    const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
      const fd = openSync(tmp, "wx", mode);
      try {
        fchmodSync(fd, mode);
        writeFileSync(fd, JSON.stringify(config, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    } catch {
      rmSync(tmp, { force: true });
      return undefined;
    }
    return result;
  });
}

function projectEntry(config: Record<string, any>, key: string): Record<string, unknown> | undefined {
  const entry = config.projects?.[key];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : undefined;
}

// What Claude Code itself writes for a project it has no entry for.
const DEFAULT_PROJECT = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

// Claude Code keeps trust for ~ to the session, and an untrusted folder
// outside git inherits trust from any ancestor, so ~ and above stay prompted.
function trustsBeyondFolder(key: string): boolean {
  let home: string;
  try {
    home = realpathSync(process.env.HOME || homedir());
  } catch {
    home = resolve(process.env.HOME || homedir());
  }
  const rel = relative(key, home);
  return rel === "" || !rel.startsWith("..") || dirname(key) === key;
}

// Only with skip-permissions on: with it off, the trust dialog is the user's
// gate on the folder's hooks and helpers.
export function pretrustClaudeAgentDir(dir: string): void {
  const config = loadConfig();
  if (!config.pretrustClaudeDirs || !config.skipPermissions) return;
  const key = claudeTrustKey(dir);
  if (!trustsBeyondFolder(key)) pretrustClaudeDir(key);
}

// Trusts key unless it already has an answer, recording it when am wrote it.
export function pretrustClaudeDir(key: string): void {
  withLedger((ledger) => {
    const written = editClaudeConfig((config) => {
      const projects = config.projects;
      if (projects !== undefined && (!projects || typeof projects !== "object" || Array.isArray(projects))) {
        return { result: false, changed: false };
      }
      const entry = projectEntry(config, key);
      if (entry && "hasTrustDialogAccepted" in entry) return { result: false, changed: false };
      config.projects = { ...projects, [key]: { ...(entry ?? DEFAULT_PROJECT), hasTrustDialogAccepted: true } };
      return { result: true, changed: true };
    });
    if (written) ledger[key] = new Date().toISOString();
  });
}

// Drops am's trust for key. False keeps it in the ledger for gc to retry.
export function forgetClaudeTrust(key: string): boolean {
  return withLedger((ledger) => {
    if (!ledger[key]) return true;
    const done = editClaudeConfig((config) => {
      const entry = projectEntry(config, key);
      if (entry?.hasTrustDialogAccepted !== true) return { result: true, changed: false };
      delete entry.hasTrustDialogAccepted;
      return { result: true, changed: true };
    });
    if (!done && existsSync(claudeGlobalConfigFile())) return false;
    delete ledger[key];
    return true;
  });
}

const TRUST_PROMPT_PATTERNS = [
  /Yes, I trust this folder/,
  /Is this a (project|directory) you created or one you trust\?/i,
  /Do you trust the files in this folder\?/i,
];

export const CLAUDE_TRUST_PROMPT_REASON = "Claude is asking to trust this folder";

export function paneShowsClaudeTrustPrompt(lines: string[]): boolean {
  return lines.some((line) => TRUST_PROMPT_PATTERNS.some((re) => re.test(line)));
}
