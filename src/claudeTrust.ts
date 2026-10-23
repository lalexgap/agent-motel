import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { baseDir } from "./paths";
import { withFileLock } from "./filelock";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { listAgents } from "./state";

// Claude Code records folder trust as projects[<key>].hasTrustDialogAccepted
// in its global config, keyed by the canonical git root (the main checkout,
// even from a linked worktree) or the dir itself outside git. Declining the
// prompt writes nothing, so an explicit false is a choice am leaves alone.

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

// Trust entries am wrote (key -> when), so cleanup never removes trust the
// user granted.
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
        if (statSync(lock).mtimeMs < Date.now() - LOCK_STALE_MS) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        continue; // released between mkdir and stat
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
// Undefined when the config is missing, unparseable, a symlink (Claude Code
// refuses to write through one too) or the lock is held past LOCK_WAIT_MS.
function editClaudeConfig<T>(fn: (config: Record<string, any>) => { result: T; changed: boolean }): T | undefined {
  const file = claudeGlobalConfigFile();
  try {
    if (lstatSync(file).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  return withClaudeConfigLock(file, () => {
    let config: Record<string, any>;
    let mode: number;
    try {
      mode = statSync(file).mode & 0o777;
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
    const { result, changed } = fn(config);
    if (!changed) return result;
    const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
      writeFileSync(tmp, JSON.stringify(config, null, 2), { mode });
      chmodSync(tmp, mode);
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

// Trusts key unless the user already decided. Returns key when the trust is
// am's to clean up (written now or by an earlier launch), else undefined.
export function pretrustClaudeDir(key: string): string | undefined {
  return withLedger((ledger) => {
    const outcome = editClaudeConfig((config) => {
      const entry = projectEntry(config, key);
      if (entry?.hasTrustDialogAccepted === true) return { result: "trusted" as const, changed: false };
      const projects = config.projects;
      const malformed = projects !== undefined && (!projects || typeof projects !== "object" || Array.isArray(projects));
      if (malformed || (entry && "hasTrustDialogAccepted" in entry)) return { result: "left" as const, changed: false };
      config.projects = { ...projects, [key]: { ...(entry ?? DEFAULT_PROJECT), hasTrustDialogAccepted: true } };
      return { result: "written" as const, changed: true };
    });
    if (outcome === "written") ledger[key] = new Date().toISOString();
    // Unknown (lock busy) still claims an entry am wrote earlier, so another
    // agent's rm can't pull it out from under this one.
    return outcome !== "left" && ledger[key] ? key : undefined;
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

// On rm: release the agent's trusted key unless another agent still uses it.
export function releaseClaudeTrust(key: string, owner: string): void {
  if (!readClaudeTrustLedger()[key]) return;
  if (listAgents().some((a) => a.name !== owner && a.claudeTrustedDir === key)) return;
  forgetClaudeTrust(key);
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
