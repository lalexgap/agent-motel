import { describe, expect, test } from "bun:test";
import { osc9, parseTmuxClients, pickItermClient, writeOsc9 } from "../src/notify";

describe("iTerm2 notifications", () => {
  test("parses tmux list-clients output", () => {
    expect(parseTmuxClients("/dev/ttys000\tiTerm2 3.7.7\t1794242410\t1\t0\n/dev/ttys004\t\t5\t0\t1\n\n")).toEqual([
      { tty: "/dev/ttys000", termtype: "iTerm2 3.7.7", activity: 1794242410, utf8: true, controlMode: false },
      { tty: "/dev/ttys004", termtype: "", activity: 5, utf8: false, controlMode: true },
    ]);
    expect(parseTmuxClients("no server running on /tmp/tmux-501/default\n")).toEqual([]);
  });

  test("picks the most recently active iTerm2 client only", () => {
    const clients = [
      { tty: "/dev/ttys001", termtype: "iTerm2 3.7.7", activity: 10, utf8: true, controlMode: false },
      { tty: "/dev/ttys002", termtype: "ghostty 1.2", activity: 99, utf8: true, controlMode: false },
      { tty: "/dev/ttys003", termtype: "iTerm2 3.7.7", activity: 20, utf8: true, controlMode: false },
    ];
    expect(pickItermClient(clients)?.tty).toBe("/dev/ttys003");
    expect(pickItermClient([clients[1]!])).toBeNull();
    expect(pickItermClient([])).toBeNull();
  });

  test("skips non-UTF-8 and control-mode iTerm2 clients", () => {
    const clients = [
      { tty: "/dev/ttys001", termtype: "iTerm2 3.7.7", activity: 10, utf8: true, controlMode: false },
      { tty: "/dev/ttys002", termtype: "iTerm2 3.7.7", activity: 30, utf8: false, controlMode: false },
      { tty: "/dev/ttys003", termtype: "iTerm2 3.7.7", activity: 20, utf8: true, controlMode: true },
    ];
    expect(pickItermClient(clients)?.tty).toBe("/dev/ttys001");
    expect(pickItermClient(clients.slice(1))).toBeNull();
  });

  test("reports a short write as failure", () => {
    let written: Buffer | undefined;
    expect(writeOsc9((data) => (written = data).length, "am: x", "é")).toBe(true);
    expect(written?.toString()).toBe(osc9("am: x", "é"));
    expect(writeOsc9((data) => data.length - 1, "am: x", "é")).toBe(false);
    expect(writeOsc9(() => 0, "am: x", "é")).toBe(false);
  });

  test("builds a single OSC 9 sequence and strips control characters", () => {
    expect(osc9("am: alpha", "approval requested")).toBe("\x1b]9;am: alpha: approval requested\x07");
    const hostile = osc9("am: x", "a\x07\x1b]9;spoof\x07b\nc\u009cd é");
    expect(hostile).toBe("\x1b]9;am: x: a ]9;spoof b c d é\x07");
    expect(hostile.slice(1, -1)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
});
