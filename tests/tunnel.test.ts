import { describe, expect, test } from "bun:test";
import { nextBackoffMs, reverseTunnelArgs } from "../src/tunnel";

describe("reverseTunnelArgs", () => {
  test("builds a keepalive'd reverse forward to the local sshd", () => {
    const argv = reverseTunnelArgs("server", 2222, 22);
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("-N");
    expect(argv).toContain("-R");
    expect(argv).toContain("2222:localhost:22");
    expect(argv).toContain("ExitOnForwardFailure=yes");
    expect(argv).toContain("ServerAliveInterval=15");
    expect(argv.at(-1)).toBe("server"); // host is last
  });

  test("honors a custom server port and local sshd port", () => {
    expect(reverseTunnelArgs("box", 9000, 2200)).toContain("9000:localhost:2200");
  });
});

describe("nextBackoffMs", () => {
  test("doubles up to a 30s cap, and resets after a healthy uptime", () => {
    expect(nextBackoffMs(1000, 0)).toBe(2000); // crashed fast → back off
    expect(nextBackoffMs(2000, 0)).toBe(4000);
    expect(nextBackoffMs(20000, 0)).toBe(30000); // capped
    expect(nextBackoffMs(30000, 0)).toBe(30000); // stays capped
    expect(nextBackoffMs(30000, 120000)).toBe(1000); // was up 2min → reset to floor
  });
});
