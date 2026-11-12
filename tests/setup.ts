import { beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hook tests run the real `am hook`, which runs an installed `decision` CLI:
// keep it off the operator's real decisions store, including after a test
// file that sets DECISIONS_HOME and deletes it again.
const sandbox = mkdtempSync(join(tmpdir(), "am-test-decisions-"));
process.env.DECISIONS_HOME = sandbox;
beforeEach(() => {
  process.env.DECISIONS_HOME ||= sandbox;
});
