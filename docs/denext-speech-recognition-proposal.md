# Proposal: OS speech recognition in Denext desktop (`speechToText`)

For the Denext agent. Qutty's companion takes voice input (push-to-talk: hold a
key or Loopy's mic button, speak, release). Today Qutty does that with its own
native library: rullama-hardware's audio built as the `rullama-audio-ffi` cdylib
(cpal capture + Whisper through whisper-rs), loaded over `Deno.dlopen`. It works
offline and on macOS and Linux. But every app that wants dictation has to ship a
~2 MB native library per architecture plus a 57 MB model, and Denext's packager
has no way to bundle the library (see "Related gap" below).

Every desktop OS already has a recognizer. Denext has the text-to-speech half
(`speak()` in `denext/mobile`, the `textToSpeech` capability over
`Deno.desktop.speech`). This proposal is the other half.

## Why

- **No model download.** On macOS the on-device recognizer (Apple's
  `SFSpeechRecognizer` with `requiresOnDeviceRecognition`) is already on the
  machine for most languages.
- **No native library to bundle and sign.**
- **Symmetry with `speak()`.** `denext/mobile` already has the Capacitor speech
  recognition plugin story on iOS and Android. A desktop branch would make
  `listen()` work everywhere the way `speak()` does.

## What Denext already has (what we build on)

- `src/mobile/speech.ts`: `speak()` / `stopSpeaking()` with three branches: the
  Capacitor plugin, Web Speech, and the desktop runtime's `Deno.desktop.speech`.
- `src/desktop/caps/speech.ts`: the `textToSpeech` capability, feature-detected
  per call and answering `unsupported` (501) on an older runtime.
- `desktop.capabilities.microphone`: the `NSMicrophoneUsageDescription` text and
  the `com.apple.security.device.audio-input` entitlement. Recognition needs
  both, plus one more usage string.

## The API

In `denext/mobile`, beside `speak()`:

```ts
interface ListenOptions {
  lang?: string; // BCP 47, default the user's
  onDevice?: boolean; // refuse to use a server (default true on desktop)
  partials?: boolean; // stream interim text through onPartial
  onPartial?(text: string): void;
  maxSeconds?: number; // hard stop, default 60
}
interface ListenSession {
  stop(): Promise<{ text: string; final: boolean }>; // end the audio, get the result
  cancel(): Promise<void>; // drop it
}
function listen(options?: ListenOptions): Promise<ListenSession>;
function listenAvailability(lang?: string): Promise<
  { available: true; onDevice: boolean } | { available: false; reason: string }
>;
```

This is push-to-talk shaped on purpose: `listen()` starts on key-down, and
`stop()` on key-up resolves with the final text. No wake word, no
always-listening mode.

Branches, in order:

1. Capacitor `@capacitor-community/speech-recognition` (iOS, Android).
2. Deno Desktop: a new `speechToText` capability over a runtime
   `Deno.desktop.speechRecognition`:
   - macOS: `SFSpeechRecognizer` + `AVAudioEngine` input tap,
     `SFSpeechAudioBufferRecognitionRequest`,
     `requiresOnDeviceRecognition =
     onDevice`,
     `shouldReportPartialResults = partials`.
   - Windows: `Windows.Media.SpeechRecognition.SpeechRecognizer`
     (`ContinuousRecognitionSession`), or `SpeechRecognitionEngine` (SAPI).
   - Linux: there is no system recognizer. Answer `unsupported`, so an app can
     fall back to its own engine, as Qutty does with Whisper.
3. Web Speech `SpeechRecognition`, only where it really works (WebView2 has it;
   WKWebView exposes `webkitSpeechRecognition`, but in an app it fails without
   the entitlements; WebKitGTK has none). Feature-detect it with a real start,
   not by checking the constructor.

## Packaging

- `desktop.capabilities.speechRecognition = { usageDescription? }`. It turns on
  `microphone` and adds `NSSpeechRecognitionUsageDescription` to `Info.plist`.
  Without that key, macOS ends the process the first time the recognizer is
  asked for authorization.
- The entitlement is the microphone's (`com.apple.security.device.audio-input`).
  `SFSpeechRecognizer` needs no extra hardened-runtime entitlement.
- `SFSpeechRecognizer.requestAuthorization` prompts once. Surface it as
  `listenAvailability()` → `{ available: false, reason: "denied" }` after a
  refusal, so the app can point the user to System Settings → Privacy & Security
  → Speech Recognition.

## Capability shape (bridge)

| method          | args                                           | result                             |
| --------------- | ---------------------------------------------- | ---------------------------------- |
| `status`        | `{ lang? }`                                    | `{ available, onDevice, reason? }` |
| `start`         | `{ lang?, onDevice?, partials?, maxSeconds? }` | `{ session }`                      |
| `stop`          | `{ session }`                                  | `{ text, final }`                  |
| `cancel`        | `{ session }`                                  | `void`                             |
| event `partial` | `{ session, text }`                            |                                    |

- One session per window at a time: a second `start` answers `busy`.
- A window that reloads or closes cancels its session.
- `stop` waits for the final result, bounded (for example 10 s after the audio
  ends).

## Acceptance criteria (tests in Denext)

- **Unit:** argument validation, `unsupported` on a runtime without
  `Deno.desktop.speechRecognition`, session ownership per window, and cancel on
  page load.
- **macOS runtime test:** feed a WAV file through the recognizer with
  `SFSpeechURLRecognitionRequest` (no microphone in CI) and assert the text.
  Qutty's fixture: `say -o x.aiff "Run the tests in the second tile."`, then
  `afconvert -f WAVE -d LEI16@16000`.
- **Packaging:** with the capability on, the packaged `Info.plist` has both
  usage strings, and a signed build has the audio-input entitlement.
- **Doctor:** `denext desktop doctor` warns when `speechRecognition` is on
  without a usage description.

## Not in scope

- Wake words, always-on listening, and voice activity detection: apps that want
  these keep their own engine.
- Cloud recognizers (Deepgram, ElevenLabs…): apps bring their own key and client
  (`@rullama/provider-speech`).

## Related gap: bundling a native library

There is no `desktop` config for extra files in the bundle, for example a dylib
in `Contents/Frameworks/` (macOS) or `lib/` beside the binary (Linux). Such a
file would need to be lipo-merged for universal builds and code-signed with the
app. Qutty looks for its audio library there first (`lib/voice/ffi.ts`
`audioLibCandidates`). Until the packager can put it there, Qutty installs a
local build into the app-support folder (`deno task audio:lib`). A
`desktop.bundle.frameworks: ["path/to/lib.dylib"]` option (or a per-OS
`desktop.resources`) would close it.

## How Qutty would use it

`lib/voice/engines.ts` would add an `os` STT engine (`listen()` from
`denext/mobile`) behind the same `SttEngine` adapter as Whisper, Deepgram,
ElevenLabs and Web Speech. On macOS and Windows it would become the default when
`listenAvailability()` says on-device; Linux keeps Whisper.

## Open questions for the Denext agent

- Does WKWebView's `webkitSpeechRecognition` work in a Deno Desktop app once the
  two usage strings are present? If it does, branch 3 might be enough on macOS
  without new runtime code.
- Should partial results go through the event stream, or through a polled
  `partial` method like Qutty's FFI does?
