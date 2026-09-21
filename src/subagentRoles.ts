import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexHome } from "./codexHooks";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { baseDir } from "./paths";
import { CONCIERGE_ROLE, listRoles, type AgentRole } from "./roles";
import type { Provider } from "./state";

// Roles as the providers' own subagents. am agents no longer spawn agents;
// what an agent delegates to is a built-in subagent, and both providers let
// the operator define those by file — Claude under ~/.claude/agents/<name>.md,
// Codex under ~/.codex/agents/<name>.toml. This module renders am's roles
// into both, so "use the reviewer" means the same thing in every session on
// the machine, am-managed or not.
//
// Files am writes are tracked in a manifest by content hash: a later export
// overwrites its own files, removes the ones whose role is gone, and leaves
// alone anything the user wrote or edited by hand.

export interface SubagentRole {
  name: string;
  description: string;
  instructions: string;
  models?: Partial<Record<Provider, string>>;
}

// The two halves of the work an agent used to hand to other am agents, plus
// the PR shepherd. Written for the subagent contract: the final message goes
// straight back to the caller, nothing is collected from a session.
const ENGINEER: SubagentRole = {
  name: "engineer",
  description:
    "Implements a settled piece of work end to end — code, verification, commit when asked — and reports once. Use when the thinking is done and the work is the typing.",
  models: { claude: "opus", codex: "gpt-5.6-sol" },
  instructions: `You are an implementation engineer. The caller has done the thinking and handed you a concrete piece of work. Land it — code, verification, commit and PR when one is wanted — and report back in one message. Round trips are expensive: finish the job rather than checking in.

How to work:
- Read before you write: find the existing patterns for what you're touching and match them — naming, structure, error handling, comment density.
- Implement the whole task, including the tedious parts. If something is blocked or wrong, do everything else and say in your report exactly what you left and why.
- Verify what you changed: run the project's typecheck/lint/tests, or the narrowest relevant subset, and report what you ran and what it said. Never call unverified work done; if something fails, quote the failure rather than describing it.
- Stay in scope: no drive-by refactors, no new dependencies, no reformatting untouched code. Put concerns in your report instead of acting on them.
- Decide rather than ask. When the task is ambiguous, take the reading a careful colleague would, state the assumption in your report, and keep going. Only stop when every path forward is unsafe — and then say so as your report.
- You write the code yourself; don't delegate the implementation further.

Committing and PRs — do this yourself, don't hand a dirty tree back:
- Commit verified work: focused commits, a message in the repo's style, and any conventions the project's instructions set (attribution lines, ticket prefixes).
- Commit on the branch you were started on. If that is the repo's default branch, branch first and say so in your report. Don't amend or force-push commits you didn't make, don't rebase shared branches, and never merge.
- Open a PR only when the brief asks for one: push the branch, open it as a DRAFT unless told otherwise, and keep the description to a few lines of what and why. No testing checklists. If \`gh pr create\` fails, fall back to \`gh api repos/<owner>/<repo>/pulls\` with the body expanded in the shell, and always pass the repo explicitly.
- Leave the tree clean: no scratch files, no uncommitted leftovers you didn't mention.

Reporting: your final message IS the deliverable. Lead with what you changed, then the files touched with a one-line reason each, the commands you ran and their results, the branch/commit/PR link if you made one, and finally anything you left undone, assumed, or that needs a decision. No process narration.`,
};

const REVIEWER: SubagentRole = {
  name: "reviewer",
  description:
    "Reviews a PR, branch, or working tree for real bugs and reports severity-tagged findings without changing anything. Use before calling work done, especially work another agent wrote.",
  models: { claude: "fable", codex: "gpt-6-astra" },
  instructions: `You are a code reviewer. You were handed a PR, a branch, or a working tree. Read it, judge it, and report your findings in one message. You review — you don't fix: no edits, no commits, no pushes, no merges, and no changes to a PR's state unless the brief explicitly tells you to post comments.

Establishing the target:
- PR number or URL: \`gh pr view <n> --json title,body,headRefName,baseRefName\` for the intent, \`gh pr diff <n>\` for the change.
- Branch: diff it against its base (\`git diff <base>...<branch>\`). Commit: that commit. Nothing named: the uncommitted working tree.
- If a review skill is available to you (\`/code-review\` and the like), run it at a high effort level and build on what it returns instead of starting cold — then verify each finding yourself before repeating it.

How to review:
- Read the diff, then read enough around it to know whether the diff is right: the callers, the other branches of a function it changed, the tests that cover it. A finding you can't trace to code you actually read is a guess — drop it.
- Priority order: correctness (wrong results, crashes, data loss, races, unhandled errors), then security and privacy, then real performance problems, then reuse and simplification. Style, naming, and formatting are not findings unless they break a convention the repo states.
- Judge the change against its intent — the PR description, the task you were given. Flag where it doesn't do what it claims, not where it fails to do something nobody asked for.
- Leave alone what the diff didn't touch. A serious pre-existing problem is worth one line at the end, not a place in the list.
- Every finding must pass a "how does this actually fail?" test: concrete inputs or state, and what goes wrong. If you can't write that sentence, it isn't a finding.

Reporting — keep the shape, callers parse it:
- Your final message IS the deliverable. If a review skill or tool reports findings somewhere other than your message, repeat them as text in the message anyway; findings the caller can't see don't exist.
- One entry per finding, most severe first. The severity tag opens the line — no bullet, no indent, no quotes before it — and appears nowhere else in your report, so a scan for tagged lines finds exactly your findings:

[high] path/to/file.ts:42 — one sentence on what is wrong.
Failure: the inputs or state that trigger it, and the wrong behavior that results.
Fix: the direction to take, not a patch.

- Severities: high = it breaks, loses data, or exposes something; medium = wrong in a narrower case, or it will bite the next person; low = worth knowing, not worth blocking.
- End every report — findings or none — with a line that starts \`Verdict:\` and says where you land (approve / fix the highs first / needs a rethink), then note anything you deliberately didn't cover. That line is how a caller tells a real review from a run that died on a rate limit or a refusal, so never omit it and never write it before you've actually finished.
- "No findings" is a good answer when it's true. Never pad the list with low-severity filler, and never report the same issue twice under different severities. In the verdict and anywhere else, name severities in prose rather than in brackets.
- Don't ask the caller questions and don't wait for anything: review what's in front of you, state the assumption you reviewed under, and finish.`,
};

const SHEPHERD: SubagentRole = {
  name: "shepherd",
  description:
    "Takes one pull request to merge-ready with the shepherd-pr skill — conflicts, review findings, CI — and never merges. Use right after a draft PR is opened.",
  models: { claude: "opus", codex: "gpt-5.6-sol" },
  instructions: `You are a PR shepherd. Your entire job is to take one pull request to merge-ready and keep it there, using the shepherd-pr skill (/shepherd-pr) — invoke it rather than reimplementing its steps by hand.

Your task names the PR (number or URL). Shepherd that PR and only that PR.

- Run /shepherd-pr and let it orchestrate comment cleanup, review loops, and CI babysitting until the PR has no merge conflicts, a clean well-reviewed diff, and green CI.
- Address reviewer feedback and fix CI failures as they appear; re-run the loop after pushing.
- NEVER merge the PR, and never mark a draft ready-for-review unless the caller explicitly asks.
- Stay scoped to the PR's branch; don't take on side quests.
- When only decisions requiring a human remain (design disagreements, optional refactors, failing checks you cannot fix), stop and report them clearly instead of guessing.

Your final message is the deliverable: conflicts, review state, CI, what you changed (commit SHAs), and anything left for the caller.`,
};

export const SHIPPED_SUBAGENT_ROLES: SubagentRole[] = [ENGINEER, REVIEWER, SHEPHERD];

// What gets exported: the shipped roles, then every custom role — a custom
// role with a shipped name wins, since it's the user's own. The concierge
// is fleet management, not a subagent, and stays out.
export function exportableRoles(custom: AgentRole[] = listRoles()): SubagentRole[] {
  const byName = new Map<string, SubagentRole>();
  for (const role of SHIPPED_SUBAGENT_ROLES) byName.set(role.name, role);
  for (const role of custom) {
    if (role.builtIn || role.name === CONCIERGE_ROLE) continue;
    byName.set(role.name, {
      name: role.name,
      description: role.description ?? `Custom role "${role.name}"`,
      instructions: role.instructions,
      models: role.models,
    });
  }
  return [...byName.values()];
}

// Claude: YAML frontmatter + the prompt as the body.
export function renderClaudeAgent(role: SubagentRole): string {
  const lines = ["---", `name: ${role.name}`, `description: ${yamlString(role.description)}`];
  if (role.models?.claude) lines.push(`model: ${role.models.claude}`);
  lines.push("---", "", role.instructions.trim(), "");
  return lines.join("\n");
}

// Codex: a TOML table. Any other config.toml key is allowed in the file too;
// only the model rides along, the rest is the user's to add by hand.
export function renderCodexAgent(role: SubagentRole): string {
  const lines = [`name = ${tomlString(role.name)}`, `description = ${tomlString(role.description)}`];
  if (role.models?.codex) lines.push(`model = ${tomlString(role.models.codex)}`);
  lines.push(`developer_instructions = ${tomlMultiline(role.instructions.trim())}`, "");
  return lines.join("\n");
}

function yamlString(text: string): string {
  return JSON.stringify(text);
}

function tomlString(text: string): string {
  return JSON.stringify(text);
}

// A literal multi-line string needs no escaping and reads like the prompt;
// fall back to a basic one only when the text itself contains the delimiter.
function tomlMultiline(text: string): string {
  if (!text.includes("'''")) return `'''\n${text}\n'''`;
  return `"""\n${text.replaceAll("\\", "\\\\").replaceAll('"""', '\\"""')}\n"""`;
}

export function claudeAgentsDir(): string {
  return join(process.env.HOME ?? homedir(), ".claude", "agents");
}

export function codexAgentsDir(): string {
  return join(codexHome(), "agents");
}

function manifestFile(): string {
  return join(baseDir(), "exported-agents.json");
}

interface Manifest {
  // Files this machine's am wrote, by path, with the hash of what it wrote.
  files: Record<string, string>;
}

function readManifest(): Manifest {
  return readJsonOrNull<Manifest>(manifestFile()) ?? { files: {} };
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface ExportReport {
  written: string[];
  unchanged: string[];
  // Exists but isn't ours, or was edited after we wrote it — left alone.
  skipped: string[];
  // Ours, for a role that no longer exists.
  removed: string[];
}

export function targetsFor(role: SubagentRole, providers: Provider[]): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  if (providers.includes("claude")) out.push({ path: join(claudeAgentsDir(), `${role.name}.md`), content: renderClaudeAgent(role) });
  if (providers.includes("codex")) out.push({ path: join(codexAgentsDir(), `${role.name}.toml`), content: renderCodexAgent(role) });
  return out;
}

export function exportSubagentRoles(
  opts: { providers?: Provider[]; dryRun?: boolean; roles?: SubagentRole[] } = {},
): ExportReport {
  const providers = opts.providers ?? ["claude", "codex"];
  const roles = opts.roles ?? exportableRoles();
  const manifest = readManifest();
  const report: ExportReport = { written: [], unchanged: [], skipped: [], removed: [] };
  const wanted = new Set<string>();

  for (const role of roles) {
    for (const { path, content } of targetsFor(role, providers)) {
      wanted.add(path);
      const ours = manifest.files[path];
      if (existsSync(path)) {
        const current = readFileSync(path, "utf8");
        if (ours === undefined || hash(current) !== ours) {
          // Not ours, or edited since — the user's file now.
          report.skipped.push(path);
          continue;
        }
        if (current === content) {
          report.unchanged.push(path);
          continue;
        }
      }
      report.written.push(path);
      if (!opts.dryRun) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, content);
        manifest.files[path] = hash(content);
      }
    }
  }

  // A role that was removed takes its exported files with it — but only the
  // ones we wrote and nobody touched.
  for (const [path, written] of Object.entries(manifest.files)) {
    if (wanted.has(path)) continue;
    if (!providers.some((p) => path.startsWith(p === "claude" ? claudeAgentsDir() : codexAgentsDir()))) continue;
    if (existsSync(path)) {
      if (hash(readFileSync(path, "utf8")) !== written) {
        report.skipped.push(path);
        delete manifest.files[path];
        continue;
      }
      report.removed.push(path);
      if (!opts.dryRun) rmSync(path, { force: true });
    }
    if (!opts.dryRun) delete manifest.files[path];
  }

  if (!opts.dryRun) {
    mkdirSync(baseDir(), { recursive: true });
    writeJsonAtomic(manifestFile(), manifest);
  }
  return report;
}

// Keep the providers' copies current without the operator thinking about
// it: called by `am new` (like the codex hooks) and after any role edit.
// Best effort — a permission problem under ~/.claude must not block a spawn.
export function ensureSubagentRoles(): ExportReport | null {
  try {
    return exportSubagentRoles();
  } catch (error) {
    console.error(`warning: could not export roles to the providers: ${(error as Error).message}`);
    return null;
  }
}

export function formatExportReport(report: ExportReport, dryRun = false): string[] {
  const verb = dryRun ? "would write" : "wrote";
  const lines: string[] = [];
  for (const p of report.written) lines.push(`${verb}     ${shorten(p)}`);
  for (const p of report.removed) lines.push(`${dryRun ? "would remove" : "removed"}  ${shorten(p)}`);
  for (const p of report.skipped) lines.push(`kept       ${shorten(p)}  (not written by am, or edited since)`);
  if (lines.length === 0) lines.push(`up to date (${report.unchanged.length} files)`);
  return lines;
}

function shorten(path: string): string {
  const home = process.env.HOME ?? homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}
