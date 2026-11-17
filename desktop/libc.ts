// File writes through libc FFI (the app needs no --allow-write; FFI is already full trust), and
// errno: desktop/ssh.ts (~/.ssh/qutty.conf, the recents file), companion.ts, voice.ts, hub.ts,
// shell-agent.ts, kept-shells.ts and hub-socket.ts use them. Nothing runs at import.

const IS_DARWIN = Deno.build.os === "darwin";
const EINTR = 4;

// mode_t is 16-bit on macOS, 32-bit on Linux (a non-variadic argument, so the width matters).
const MODE_T = IS_DARWIN ? "u16" : "u32";

const SYMBOLS = {
  write: { parameters: ["i32", "buffer", "usize"], result: "isize" },
  close: { parameters: ["i32"], result: "i32" },
  creat: { parameters: ["buffer", MODE_T], result: "i32" },
  chmod: { parameters: ["buffer", MODE_T], result: "i32" },
  mkdir: { parameters: ["buffer", MODE_T], result: "i32" },
  rename: { parameters: ["buffer", "buffer"], result: "i32" },
} as const;

const LIBC_PATH = IS_DARWIN ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

let libcCache: Deno.DynamicLibrary<typeof SYMBOLS>["symbols"] | undefined;
let errnoCache: (() => Deno.PointerValue) | undefined;

/** libc, opened on first use. */
function libc() {
  return (libcCache ??= Deno.dlopen(LIBC_PATH, SYMBOLS).symbols);
}

/** The calling thread's errno (read right after the failing call, on the same JS thread). */
export function errno(): number {
  errnoCache ??= IS_DARWIN
    ? Deno.dlopen(LIBC_PATH, {
      __error: { parameters: [], result: "pointer" },
    }).symbols.__error
    : Deno.dlopen(LIBC_PATH, {
      __errno_location: { parameters: [], result: "pointer" },
    }).symbols.__errno_location;
  const ptr = errnoCache();
  return ptr ? new Deno.UnsafePointerView(ptr).getInt32() : 0;
}

const encoder = new TextEncoder();
const cstr = (s: string) => encoder.encode(`${s}\0`);

/** `mkdir(path, mode)`; an existing directory is fine (its mode is left alone). */
export function ensureDir(path: string, mode: number): void {
  libc().mkdir(cstr(path), mode);
}

/**
 * Write `bytes` to `path` with `mode`, atomically: a temp file beside it, written, chmod'ed,
 * then renamed over the target (a reader never sees a partial file, and a crash leaves the old
 * one). The target's directory must exist.
 */
export function writeFileAtomic(
  path: string,
  bytes: Uint8Array,
  mode: number,
): void {
  const c = libc();
  const tmp = `${path}.${Deno.pid}.tmp`;
  const fd = c.creat(cstr(tmp), mode);
  if (fd < 0) throw new Error(`cannot create ${tmp} (errno ${errno()})`);
  try {
    let off = 0;
    while (off < bytes.length) {
      const n = Number(
        c.write(fd, bytes.subarray(off), BigInt(bytes.length - off)),
      );
      if (n < 0) {
        if (errno() === EINTR) continue;
        throw new Error(`cannot write ${tmp} (errno ${errno()})`);
      }
      off += n;
    }
  } finally {
    c.close(fd);
  }
  // creat applies the umask; the caller's mode is meant exactly (0600 for ssh files).
  c.chmod(cstr(tmp), mode);
  if (c.rename(cstr(tmp), cstr(path)) !== 0) {
    throw new Error(`cannot install ${path} (errno ${errno()})`);
  }
}

/** `rename(from, to)`, replacing `to` (both in one file system). */
export function renamePath(from: string, to: string): void {
  if (libc().rename(cstr(from), cstr(to)) !== 0) {
    throw new Error(`cannot move ${from} to ${to} (errno ${errno()})`);
  }
}
