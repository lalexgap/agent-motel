import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real picker renders partial during chat input and in the committed search state", () => {
  const root = mkdtempSync(join(tmpdir(), "am-search-picker-"));
  try {
    const fixture = `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { pick } from ${JSON.stringify(join(import.meta.dir, "../src/picker.ts"))};
      import { writeAgent } from ${JSON.stringify(join(import.meta.dir, "../src/state.ts"))};
      const root = process.env.AGENTMGR_HOME;
      const file = join(root, "chat.jsonl");
      writeFileSync(file, JSON.stringify({ type: "user", message: { content: "x".repeat(1024 * 1024 + 1) } }) + "\\n" + JSON.stringify({ type: "user", message: { content: "needle visible fixture" } }) + "\\n");
      writeAgent({ name: "fixture", status: "exited", dir: root, tmuxSession: "fixture", transcriptPath: file,
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      process.stdin.setRawMode = () => process.stdin;
      process.stdin.resume = () => process.stdin;
      process.stdin.pause = () => process.stdin;
      Object.defineProperty(process.stdout, "columns", { value: 120 });
      Object.defineProperty(process.stdout, "rows", { value: 24 });
      let output = "";
      process.stdout.write = (chunk) => { output += chunk.toString(); return true; };
      const done = pick(() => [{ name: "fixture", label: "fixture", search: "fixture", meta: ["isolated search fixture"] }]);
      process.stdin.emit("data", Buffer.from("/"));
      process.stdin.emit("data", Buffer.from("needle"));
      const typing = output.split("\\x1b[H").at(-1);
      process.stdin.emit("data", Buffer.from("\\r"));
      const committed = output.split("\\x1b[H").at(-1);
      process.stdin.emit("data", Buffer.from("\\x03"));
      await done;
      writeFileSync(join(root, "capture.json"), JSON.stringify({ typing, committed, output }));
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", fixture], {
      env: { ...process.env, AGENTMGR_HOME: root }, stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    expect(child.exitCode).toBe(0);
    const capture = JSON.parse(require("node:fs").readFileSync(join(root, "capture.json"), "utf8"));
    const plain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(plain(capture.typing)).toContain("search chats  needle · partial");
    expect(plain(capture.committed)).toContain("search: needle · 1 matches · partial · esc clears");
    expect(plain(capture.committed)).toContain("needle visible fixture");
    if (process.env.AM_SEARCH_EVIDENCE_DIR) {
      for (const phase of ["typing", "committed"]) {
        writeFileSync(join(process.env.AM_SEARCH_EVIDENCE_DIR, `picker-${phase}.ansi`), capture[phase]);
        writeFileSync(join(process.env.AM_SEARCH_EVIDENCE_DIR, `picker-${phase}.txt`), plain(capture[phase]));
      }
      writeFileSync(join(process.env.AM_SEARCH_EVIDENCE_DIR, "picker-session.ansi"), capture.output);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
