import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUB_TITLE_FORMAT, tmuxPaneTitle } from "../src/paneTitle";

test.skipIf(!Bun.which("tmux"))("tmux preserves literal names and filters live pane title controls", () => {
  const dir = mkdtempSync(join(tmpdir(), "am-title-test-"));
  const socket = join(dir, "tmux.sock");
  const tmux = (...args: string[]) => {
    const result = Bun.spawnSync(["tmux", "-S", socket, ...args], {
      env: { ...process.env, TMUX: "" },
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trimEnd();
  };
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "fixture", "sleep 60");
    const title = "literal #{session_name}; $(ignored) ⤷ child";
    tmux("select-pane", "-t", "fixture", "-T", tmuxPaneTitle(title));
    expect(tmux("display-message", "-p", "-t", "fixture", HUB_TITLE_FORMAT)).toBe(title);
    const controls = Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).join("")
      + Array.from({ length: 33 }, (_, i) => String.fromCharCode(127 + i)).join("");
    tmux("set-option", "-t", "fixture", "@raw_title", `alpha${controls} Ω ⤷ child`);
    expect(tmux("display-message", "-p", "-t", "fixture", HUB_TITLE_FORMAT.replace(":pane_title", ":@raw_title")))
      .toBe("alpha Ω ⤷ child");
    tmux("select-pane", "-t", "fixture", "-T", "alpha\u0085\u009b Ω ⤷ child");
    expect(tmux("display-message", "-p", "-t", "fixture", HUB_TITLE_FORMAT)).toBe("alpha Ω ⤷ child");
  } finally {
    Bun.spawnSync(["tmux", "-S", socket, "kill-server"]);
    rmSync(dir, { recursive: true, force: true });
  }
});
