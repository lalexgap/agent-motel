import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";

// How busy the host is, for work that can wait (gc's worktree inspections).

export interface Pressure {
  loadPerCpu: number;
  // PSI "some avg10": the share of the last 10s some task stalled. Null off Linux.
  io: number | null;
  memory: number | null;
}

export interface PressureLimits {
  gcAutoMaxLoad: number;
  gcAutoMaxPressure: number;
}

function psi(resource: string): number | null {
  try {
    const match = /^some avg10=([0-9.]+)/m.exec(readFileSync(`/proc/pressure/${resource}`, "utf8"));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function readPressure(): Pressure {
  return { loadPerCpu: loadavg()[0]! / Math.max(1, cpus().length), io: psi("io"), memory: psi("memory") };
}

// A hand-edited config can hold anything: out-of-range values fall back to the default.
export function configNumber(value: unknown, fallback: number, min: number, max = Infinity): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

// Why the host is too busy for more disk work right now, or null.
export function pressureReason(pressure: Pressure, limits: PressureLimits): string | null {
  const maxLoad = configNumber(limits.gcAutoMaxLoad, 1, Number.MIN_VALUE);
  const maxPressure = configNumber(limits.gcAutoMaxPressure, 20, Number.MIN_VALUE, 100);
  if (pressure.loadPerCpu > maxLoad) return `load ${pressure.loadPerCpu.toFixed(2)} per CPU (limit ${maxLoad})`;
  if (pressure.io !== null && pressure.io > maxPressure) return `IO pressure ${pressure.io.toFixed(0)}% (limit ${maxPressure}%)`;
  if (pressure.memory !== null && pressure.memory > maxPressure) return `memory pressure ${pressure.memory.toFixed(0)}% (limit ${maxPressure}%)`;
  return null;
}

const BACKOFF_MS = 10_000;

// Wait for the host to quieten before the next piece of work. The work's own
// reads raise IO pressure, so busy is normal mid-run: back off and look again
// rather than give up. Returns null to go ahead, or why to stop — the deadline
// passed, or the host stayed busy until it.
export function awaitQuiet(deadline: number, busy: () => string | null, sleep: (ms: number) => void): string | null {
  for (;;) {
    if (Date.now() > deadline) return "time budget";
    const reason = busy();
    if (!reason) return null;
    if (Date.now() + BACKOFF_MS > deadline) return reason;
    sleep(BACKOFF_MS);
  }
}
