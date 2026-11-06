// Builds rullama-hardware's audio library (the `rullama-audio-ffi` cdylib in the Rullama repo) and
// installs it where the app looks for it: `<app support>/audio/` (desktop/voice.ts). This is the
// developer's (and, until Denext's packager can bundle extra files, the packaged app's) way to get
// on-device push-to-talk:
//
//   deno task audio:lib                      # Rullama checked out next to Qutty
//   RULLAMA_DIR=~/src/rullama deno task audio:lib
//   deno task audio:lib --lib path/to/librullama_audio_ffi.dylib   # install a prebuilt one
//
// Needs cargo and cmake (whisper-rs builds whisper.cpp). The Whisper model is not handled here:
// the app downloads it on first use (Settings → Voice), with its checksum checked.

import { dirname, join } from "@std/path";
import { audioLibFile } from "../lib/voice/ffi.ts";

/** The app's support folder, as Denext's runtime resolves it (desktop.app.identifier). */
export function appSupportDir(
  os: typeof Deno.build.os,
  home: string,
  env: (name: string) => string | undefined,
  identifier = "org.qutty.Qutty",
): string {
  if (os === "darwin") {
    return join(home, "Library", "Application Support", identifier);
  }
  if (os === "windows") {
    return join(env("APPDATA") ?? join(home, "AppData", "Roaming"), identifier);
  }
  return join(
    env("XDG_DATA_HOME") || join(home, ".local", "share"),
    identifier,
  );
}

/** Where a Rullama checkout may be: `RULLAMA_DIR`, else next to this repo. */
function rullamaCandidates(): string[] {
  const env = Deno.env.get("RULLAMA_DIR");
  const sibling = (name: string) =>
    new URL(`../../${name}`, import.meta.url).pathname;
  return env ? [env] : [
    sibling("rullama-audio-ffi"),
    sibling("rullama-framework"),
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function build(): Promise<string> {
  for (const dir of rullamaCandidates()) {
    if (!await exists(join(dir, "crates", "rullama-audio-ffi", "Cargo.toml"))) {
      continue;
    }
    console.log(`Building rullama-audio-ffi in ${dir} …`);
    const { code } = await new Deno.Command("cargo", {
      args: ["build", "-p", "rullama-audio-ffi", "--release"],
      cwd: dir,
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (code !== 0) throw new Error(`cargo build failed (exit ${code})`);
    return join(dir, "target", "release", audioLibFile(Deno.build.os));
  }
  throw new Error(
    "no Rullama checkout with crates/rullama-audio-ffi found; set RULLAMA_DIR",
  );
}

if (import.meta.main) {
  const libArg = Deno.args.indexOf("--lib");
  const lib = libArg >= 0 ? Deno.args[libArg + 1] : await build();
  if (!lib || !await exists(lib)) throw new Error(`no library at ${lib}`);
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const dest = join(
    appSupportDir(Deno.build.os, home, (n) => Deno.env.get(n)),
    "audio",
    audioLibFile(Deno.build.os),
  );
  await Deno.mkdir(dirname(dest), { recursive: true });
  await Deno.copyFile(lib, dest);
  console.log(`Installed ${dest}`);
}
