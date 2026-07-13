import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexConfigFile, codexHooksBlock, ensureCodexHooks, CODEX_HOOK_EVENTS } from "../src/codexHooks";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-codex-test-"));
  process.env.CODEX_HOME = home;
});

afterEach(() => {
  delete process.env.CODEX_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("ensureCodexHooks", () => {
  test("creates config.toml with the managed block when missing", () => {
    const result = ensureCodexHooks();
    expect(result.changed).toBe(true);
    const content = readFileSync(codexConfigFile(), "utf8");
    for (const event of Object.keys(CODEX_HOOK_EVENTS)) {
      expect(content).toContain(`[[hooks.${event}]]`);
    }
    expect(content).toContain("hook session-start");
    expect(content).toContain("hook permission-request");
  });

  test("is idempotent — second run reports no change", () => {
    ensureCodexHooks();
    expect(ensureCodexHooks().changed).toBe(false);
  });

  test("preserves user config and codex-written trust state outside the block", () => {
    writeFileSync(
      codexConfigFile(),
      'model = "gpt-5.5"\n\n[projects."/x"]\ntrust_level = "trusted"\n',
    );
    ensureCodexHooks();
    // Simulate codex appending trust hashes after the user approves, then a
    // block refresh (e.g. the am checkout moved, changing the hook paths).
    const withTrust =
      readFileSync(codexConfigFile(), "utf8") +
      '\n[hooks.state."x:session_start:0:0"]\ntrusted_hash = "sha256:abc"\n';
    writeFileSync(codexConfigFile(), withTrust);
    const stale = readFileSync(codexConfigFile(), "utf8").replace("hook session-start", "hook old-event");
    writeFileSync(codexConfigFile(), stale);

    expect(ensureCodexHooks().changed).toBe(true);
    const content = readFileSync(codexConfigFile(), "utf8");
    expect(content).toContain('model = "gpt-5.5"');
    expect(content).toContain('trusted_hash = "sha256:abc"');
    expect(content).toContain("hook session-start");
    expect(content).not.toContain("hook old-event");
    // Exactly one managed block.
    expect(content.split(">>> agent-manager hooks").length).toBe(2);
  });

  test("leaves the file untouched when codex writes trust state INSIDE the block", () => {
    // Regression: codex re-serializes config.toml and drops its [hooks.state]
    // trust tables between our comment markers. An exact-string compare saw
    // that as a change and rewrote the block every launch, wiping the trust and
    // re-triggering the approval prompt forever. The commands are unchanged, so
    // ensureCodexHooks must report no change and not rewrite.
    ensureCodexHooks();
    const withTrust = readFileSync(codexConfigFile(), "utf8").replace(
      "# <<< agent-manager hooks <<<",
      '[hooks.state."x:session_start:0:0"]\ntrusted_hash = "sha256:abc"\n\n# <<< agent-manager hooks <<<',
    );
    writeFileSync(codexConfigFile(), withTrust);

    expect(ensureCodexHooks().changed).toBe(false);
    // The trust record survives, byte-for-byte.
    expect(readFileSync(codexConfigFile(), "utf8")).toBe(withTrust);
  });

  test("block contains valid-looking TOML with quoted command strings", () => {
    const block = codexHooksBlock();
    expect(block).toContain('type = "command"');
    expect(block.match(/command = "/g)?.length).toBe(Object.keys(CODEX_HOOK_EVENTS).length);
  });
});
