import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

const darwin = process.platform === "darwin";
const flockSignature = { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
const errnoSignature = { args: [], returns: FFIType.ptr } as const;
const libc = darwin
  ? dlopen("libSystem.B.dylib", { flock: flockSignature, __error: errnoSignature })
  : dlopen("libc.so.6", { flock: flockSignature, __errno_location: errnoSignature });
const errnoAddress = "__error" in libc.symbols ? libc.symbols.__error : libc.symbols.__errno_location;

function acquire(file: string, nonblocking: boolean): (() => void) | null {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a", 0o600);
  while (libc.symbols.flock!(fd, 2 | (nonblocking ? 4 : 0)) !== 0) {
    const errno = read.i32(errnoAddress()!);
    if (errno === 4) continue; // Interrupted system call.
    closeSync(fd);
    if (nonblocking && errno === (darwin ? 35 : 11)) return null;
    throw new Error(`cannot lock ${file}: errno ${errno}`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
  };
}

// Keep the inode: unlinking it allows a second process to lock a different
// file at the same path while the original lock is still held.
export function tryAcquireFileLock(file: string): (() => void) | null {
  return acquire(file, true);
}

export function withFileLock<T>(file: string, fn: () => T): T {
  const release = acquire(file, false)!;
  try {
    return fn();
  } finally {
    release();
  }
}
