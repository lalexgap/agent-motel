import { describe, expect, test } from "bun:test";
import { newMsgId } from "../src/msgid";

describe("newMsgId", () => {
  test("is 26 Crockford chars", () => {
    expect(newMsgId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("is unique and time-sortable (monotonic) across a burst", () => {
    const ids = Array.from({ length: 2000 }, () => newMsgId());
    // all distinct
    expect(new Set(ids).size).toBe(ids.length);
    // lexically sorted order equals insertion order — i.e. strictly increasing,
    // even for the many ids minted within the same millisecond
    expect([...ids].sort()).toEqual(ids);
  });

  test("a later timestamp sorts after an earlier one", () => {
    // use values past any real clock so module state can't interfere
    const a = newMsgId(10_000_000_000_000);
    const b = newMsgId(10_000_000_001_000);
    expect(b > a).toBe(true);
  });
});
