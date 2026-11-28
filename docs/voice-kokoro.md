# Kokoro, the on-device voice

Qutty's companion can speak with
[Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an 82-million-parameter
neural text-to-speech model, instead of the operating system's voices. It runs
on this computer, in the native audio library that also does push-to-talk.
Nothing that is said is sent anywhere.

## How it fits together

| Piece                        | Where                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthesis and playback       | Rullama's `rullama-audio-ffi` (`rla_tts_*`, ABI version 2): Kokoro through ONNX Runtime, linked statically into the one library the app bundles (`desktop.bundle.libraries`) |
| The binding                  | `lib/voice/ffi.ts`: the speech symbols are optional, so a library built before them still loads and does everything else                                                     |
| The files and their download | `lib/voice/kokoro.ts` (`KOKORO_FILES`, `ModelSet`), run by `desktop/voice.ts` with `curl` in a hidden PTY, like the Whisper model                                            |
| The engine                   | `kokoroTts` in `lib/voice/engines.ts`: Kokoro when it can speak, else the OS voice                                                                                           |
| Settings                     | Settings → Voice → Voice engine: "Kokoro (natural voice, on this computer)"                                                                                                  |

Kokoro is the default engine. It **can speak** when the audio library was built
with speech (`rla_tts_available`) and both files are downloaded and checked.
Until then, and whenever a speech fails, the OS voice says the text, so choosing
Kokoro never makes the companion mute. Settings saved before Kokoro existed,
with the engine that was the default then, move to it the same way
(`migrateStoredVoice`); a "This computer's voice" picked since stays picked.

The model is loaded on the first thing said (about half a second) and unloaded
after five minutes without speech. Text is synthesized piece by piece, the first
sentence first, so speech starts after one short inference; talking (barge-in)
or the stop button silences it at once (`rla_tts_cancel`).

## The files

Fetched once, on first use, into `<app support>/models/`. Each is checked
against its size and SHA-256 before it is used, and again the first time it is
used in each session; a file that fails is removed.

| File                     | Source                                                                                                                                                                      | Size              | SHA-256                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| `kokoro-82m-v1.0.onnx`   | `onnx/model.onnx` of [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) at commit `1939ad2a8e416c0acfeecc08a694d14ef25f2231` | 325,532,232 bytes | `8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb` |
| `kokoro-voices-v1.0.bin` | `voices-v1.0.bin` of [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0)'s `model-files-v1.0` release                                  | 28,214,398 bytes  | `bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d` |

The exact URLs are in `lib/voice/kokoro.ts`. The model's URL names a commit, so
it cannot change; a GitHub release asset can be replaced, which the checksum
would catch.

The model is the full-precision export. Measured on an Apple M-series CPU with
four threads, synthesizing 15 s of speech:

| Export                           | Download | Speed          | Peak memory |
| -------------------------------- | -------- | -------------- | ----------- |
| `model.onnx` (float32, **used**) | 326 MB   | 4.8× real time | 0.9 GB      |
| `model_fp16.onnx`                | 163 MB   | 4.3×           | 0.6 GB      |
| `model_quantized.onnx` (8-bit)   | 92 MB    | 2.3×           | 0.5 GB      |
| `model_q8f16.onnx`               | 86 MB    | 2.2×           | 0.45 GB     |

The 8-bit exports are smaller but run at half the speed on a CPU and lose
quality. The half-precision one computes in 16-bit floats, which only some CPUs
do natively, so it is not used everywhere-safe. Changing the export is a change
of `KOKORO_MODEL` only: the library reads any of them.

## Voices

The voices file holds 54 voices; the 28 American and British English ones are
offered (`af_heart`, "American English — Heart", is the default). The others
(Spanish, French, Hindi, Italian, Japanese, Portuguese, Chinese) need
phonemizers the library does not have yet.

## Licenses

| Thing                                                                                                                                                                                 | License                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Kokoro-82M model weights and voices ([hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M))                                                                                 | Apache-2.0              |
| The ONNX export ([onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX))                                                                   | Apache-2.0              |
| The voices archive ([kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx), MIT, repackaging hexgrad's voices)                                                                    | Apache-2.0 (the voices) |
| ONNX Runtime 1.22, linked into the audio library                                                                                                                                      | MIT                     |
| Phonemes: [misaki-rs](https://github.com/MicheleYin/misaki-rs) (MIT) with [misaki](https://github.com/hexgrad/misaki)'s dictionaries (Apache-2.0) and spaCy-derived tagger data (MIT) | permissive              |
| Unknown words: [g2p_en](https://github.com/Kyubyong/g2p)'s letter-to-sound model (Apache-2.0, trained on CMUdict, BSD-2-Clause)                                                       | permissive              |

**No GPL code is involved.** Most Kokoro setups turn text into phonemes with
espeak-ng, which is GPL-3.0; linking it would put the audio library, and Qutty
with it, under the GPL. The audio library does not use, link or bundle
espeak-ng: see "How text becomes phonemes" in Rullama's
`crates/rullama-audio-ffi/README.md` and its `NOTICE.md`.

The files are downloaded by the user's own copy of the app from their
publishers; Qutty does not redistribute them.

## Checking it by hand

- Settings → Voice → Voice engine → Kokoro: the hint says the model is not
  downloaded and gives its size, and the Voice list is this computer's (it
  speaks until then). Download shows progress, then "downloaded", and the Voice
  list becomes Kokoro's. ▶ and Test voice speak with the picked voice. Back on
  "This computer's voice", the OS voice picked before is still picked.
- `QUTTY_KOKORO_SELFTEST="The build finished. All tests passed."` on the
  packaged app logs the library's speech support, fetches the files if they are
  missing, lists the voices and says the sentence once (`kokoro self-test: ...`
  on stderr).
- Hold the talk key while it speaks: it stops at once.
- `QUTTY_AUDIO_LIB=<an older library>`: push-to-talk still works, Settings says
  the on-device voice is not available, and the OS voice speaks.
