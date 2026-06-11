import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "../src/paths";

describe("expandHome", () => {
  test("expands ~ and ~/ prefixes", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/code/x")).toBe(join(homedir(), "code/x"));
  });

  test("leaves absolute and relative paths alone", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x");
    expect(expandHome("relative/dir")).toBe("relative/dir");
    expect(expandHome("~user/x")).toBe("~user/x");
  });
});
