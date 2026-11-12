import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// A lost brace nests every later rule inside the previous one, which browsers accept
// silently; nothing else in the suite parses the stylesheet.
test("desktop.css closes every rule it opens", () => {
  const css = readFileSync(new URL("../desktop/desktop.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0, deepest = 0;
  for (const character of css) {
    if (character === "{") deepest = Math.max(deepest, ++depth);
    else if (character === "}") depth--;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
  // Rules sit at depth 1, or 2 inside an at-rule such as @container or @media.
  expect(deepest).toBeLessThanOrEqual(2);
});
