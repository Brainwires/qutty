// Builds rullama-hardware's audio library (the `rullama-audio-ffi` cdylib in the Rullama repo) and
// installs it where the app looks for it (desktop/voice.ts): `<app support>/audio/`, the
// developer's way to get on-device push-to-talk, or with `--native` the project's
// `native/<target>/`, where `desktop.bundle.libraries` (denext.config.ts) has the package scripts
// bundle it into the app:
//
//   deno task audio:lib                      # Rullama checked out next to Qutty
//   RULLAMA_DIR=~/src/rullama deno task audio:lib
//   deno task audio:lib --lib path/to/librullama_audio_ffi.dylib   # install a prebuilt one
//   deno task audio:lib --native             # into native/<target>/ for packaging
//
// Needs cargo and cmake (whisper-rs builds whisper.cpp), and the network once: the library's
// Kokoro speech (its default `tts-kokoro` feature) links ONNX Runtime statically, and the `ort`
// crate's build script downloads that runtime's prebuilt library for the target (on Linux the
// build needs OpenSSL's headers, `libssl-dev`). The models are not handled here: the app downloads the
// Whisper model and Kokoro's on first use (Settings → Voice), with their checksums checked.

import { dirname, join } from "@std/path";
import { audioLibFile, audioLibTarget } from "../lib/voice/ffi.ts";

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

/**
 * The build's environment. A library for packaging (`--native`) must run on every Mac or PC of its
 * target, not only on the build machine: whisper.cpp's ggml tunes itself to the host CPU
 * (`GGML_NATIVE`, e.g. Arm i8mm on an M2, which an M1 lacks) unless `SOURCE_DATE_EPOCH` is set,
 * its reproducible-build switch. whisper-rs-sys passes no `GGML_*` define through, so this is the
 * way to turn host tuning off. A developer's own build (no `--native`) keeps host tuning.
 */
export function buildEnv(
  forPackaging: boolean,
  env: Record<string, string>,
): Record<string, string> {
  if (!forPackaging || env.SOURCE_DATE_EPOCH) return {};
  return { SOURCE_DATE_EPOCH: "0" };
}

async function build(forPackaging: boolean): Promise<string> {
  for (const dir of rullamaCandidates()) {
    if (!await exists(join(dir, "crates", "rullama-audio-ffi", "Cargo.toml"))) {
      continue;
    }
    console.log(`Building rullama-audio-ffi in ${dir} …`);
    const { code } = await new Deno.Command("cargo", {
      args: ["build", "-p", "rullama-audio-ffi", "--release"],
      cwd: dir,
      env: buildEnv(forPackaging, Deno.env.toObject()),
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

/**
 * Where `--native` puts the library: `native/<target>/<file>` in the project, the file
 * `desktop.bundle.libraries` (denext.config.ts) names for the host target, so the package scripts
 * bundle it and `denext desktop run` finds it with `bundledLibraryPath`.
 */
export function nativeLibDest(
  projectDir: string,
  os: typeof Deno.build.os,
  arch: typeof Deno.build.arch,
): string {
  const target = audioLibTarget(os, arch);
  if (!target) throw new Error(`no bundled-library target for ${os}-${arch}`);
  return join(projectDir, "native", target, audioLibFile(os));
}

if (import.meta.main) {
  const libArg = Deno.args.indexOf("--lib");
  const lib = libArg >= 0
    ? Deno.args[libArg + 1]
    : await build(Deno.args.includes("--native"));
  if (!lib || !await exists(lib)) throw new Error(`no library at ${lib}`);
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const dest = Deno.args.includes("--native")
    ? nativeLibDest(
      new URL("..", import.meta.url).pathname,
      Deno.build.os,
      Deno.build.arch,
    )
    : join(
      appSupportDir(Deno.build.os, home, (n) => Deno.env.get(n)),
      "audio",
      audioLibFile(Deno.build.os),
    );
  await Deno.mkdir(dirname(dest), { recursive: true });
  await Deno.copyFile(lib, dest);
  console.log(`Installed ${dest}`);
}
