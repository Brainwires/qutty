// Loads a built audio library (rullama-audio-ffi) the way the app does and checks it is the one
// the app expects: the symbols resolve on this machine, its ABI has speech (version 2), and it
// was built with Kokoro. No model is loaded, no device is opened, nothing is played. The release
// workflow runs it on each library it builds, before packaging:
//
//   deno run --allow-ffi --allow-read scripts/check-audio-lib.ts native/darwin-arm64/librullama_audio_ffi.dylib

import { AUDIO_SYMBOLS, AudioLib } from "../lib/voice/ffi.ts";

/** What is wrong with a library of this ABI version and speech support, or `undefined`. */
export function audioLibProblem(
  abiVersion: number,
  ttsAvailable: boolean,
): string | undefined {
  if (abiVersion < 2) {
    return `ABI version ${abiVersion}: built from a Rullama commit before speech (rla_tts_*)`;
  }
  if (!ttsAvailable) {
    return "built without speech (Rullama's tts-kokoro feature is off)";
  }
  return undefined;
}

if (import.meta.main) {
  const path = Deno.args[0];
  if (!path) throw new Error("usage: check-audio-lib.ts <library>");
  const dl = Deno.dlopen(path, AUDIO_SYMBOLS);
  try {
    const lib = new AudioLib(dl.symbols);
    const [abi, speech] = [lib.abiVersion(), lib.ttsAvailable()];
    console.log(
      `${lib.version()}: ABI version ${abi}, speech ${speech ? "yes" : "no"}`,
    );
    const problem = audioLibProblem(abi, speech);
    if (problem) {
      console.error(`${path}: ${problem}`);
      Deno.exit(1);
    }
  } finally {
    dl.close();
  }
}
