// The workspace's voice layer (lib/voice/): the companion's answers and the chosen event alerts read
// aloud through one speech queue, and push-to-talk — the mic button on Loopy or the hold-to-talk
// key — through the speech-to-text engine picked in Settings → Voice. The transcript goes to the
// companion (`companionSend(text, "voice")`), to the summary request, or, in dictate mode, is typed
// into the focused tile. Talking (or pressing the mic) stops whatever is being said: barge-in.
// While it listens, the microphone's level (0–1, about 20 times a second) is followed for Loopy's
// pulse, and drops back to 0 when listening stops.
//
// In the browser demo the engines are fakes (lib/voice/client.ts `createDemoVoice`, a timed TTS),
// which the e2e suite drives through `window.__e2eVoice` in test mode.

import { useEffect, useMemo, useRef, useState } from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import type { HubSnapshot, TileInfo } from "../lib/hub/protocol.ts";
import { isTestMode } from "../lib/test-hooks.ts";
import {
  createDemoVoice,
  createDesktopVoice,
  demoVoiceScript,
  type VoiceBackend,
} from "../lib/voice/client.ts";
import {
  IDLE_VOICE,
  VoiceController,
  type VoiceState,
} from "../lib/voice/controller.ts";
import {
  backendKeys,
  cloudTts,
  demoTts,
  type KeyStore,
  sttEngine,
  systemTts,
} from "../lib/voice/engines.ts";
import { anyAlertOn, tileAlerts } from "../lib/voice/alerts.ts";
import { SUMMARIZE_PROMPT } from "../lib/voice/routing.ts";
import type { VoiceSettings } from "../lib/voice/settings.ts";
import { answerToSpeak, SpeechQueue } from "../lib/voice/tts.ts";
import {
  isPushToTalk,
  isPushToTalkRelease,
  type KeyPlatform,
} from "../lib/workspace/keys.ts";

export interface UseVoiceOptions {
  backend: PtyBackend | undefined;
  settings: VoiceSettings;
  platform: KeyPlatform;
  /** Whether the companion overlay is shown (push-to-talk needs it). */
  enabled: boolean;
  /** Type `text` into the focused tile; false when no tile has the focus. */
  typeIntoFocused(text: string): boolean;
}

/** What the overlay and Settings → Voice use. */
export interface VoiceApi {
  state: VoiceState;
  /** Something is being said. */
  speaking: boolean;
  /** The microphone's level (0–1) while listening; 0 otherwise. */
  level: number;
  voice: VoiceBackend | undefined;
  /** The cloud keys (set / clear / whether set; kept by the voice extension in the OS keychain). */
  keys: KeyStore | undefined;
  press(): void;
  release(heldMs: number): void;
  cancel(): void;
  send(text: string): void;
  summarize(): void;
  /** Barge-in by hand (the stop button). */
  stopSpeaking(): void;
  /** Say `text` now (Settings' "Test voice"). */
  test(text: string): void;
  /** Say `text` as an alert, after whatever is being said (Loopy's reactions). */
  alert(text: string): void;
}

export function useVoice(opts: UseVoiceOptions): VoiceApi {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const { backend } = opts;
  const [state, setState] = useState<VoiceState>(IDLE_VOICE);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);

  // The voice backend and the demo script (published for the e2e suite in test mode).
  const { voice, script } = useMemo(() => {
    if (!backend) return { voice: undefined, script: undefined };
    if (backend.kind === "desktop") {
      return { voice: createDesktopVoice(), script: undefined };
    }
    const script = demoVoiceScript();
    if (isTestMode()) {
      (globalThis as { __e2eVoice?: unknown }).__e2eVoice = script;
    }
    return { voice: createDemoVoice(script), script };
  }, [backend]);
  const keys = useMemo(() => voice ? backendKeys(voice) : undefined, [voice]);

  const queue = useMemo(() =>
    new SpeechQueue({
      engine: () => {
        const s = optsRef.current.settings;
        if (script && isTestMode()) return demoTts(script);
        if (s.ttsEngine === "deepgram" && voice?.kind === "desktop" && keys) {
          return cloudTts(voice, keys);
        }
        return systemTts();
      },
      options: () => {
        const s = optsRef.current.settings;
        return {
          ...(s.voice ? { voice: s.voice } : {}),
          rate: s.rate,
          volume: s.volume,
        };
      },
      onSpeaking: (on) => setSpeaking(on),
      onError: (e) => console.warn("voice: speech failed", e),
    }), [voice, script, keys]);

  const controller = useMemo(() => {
    if (!voice || !backend || !keys) return undefined;
    return new VoiceController({
      engine: () => sttEngine(optsRef.current.settings.sttEngine, voice, keys),
      settings: () => optsRef.current.settings,
      bargeIn: () => void queue.interrupt(),
      toCompanion: (text) =>
        void backend.companionSend(text, "voice").catch(() => {}),
      summarize: () =>
        void backend.companionSend(SUMMARIZE_PROMPT, "voice").catch(() => {}),
      dictate: (text) => optsRef.current.typeIntoFocused(text),
      onState: setState,
    });
  }, [voice, backend, queue, keys]);

  // The microphone's level while listening (the pulse); back to 0 once it stops.
  const listening = state.phase === "starting" || state.phase === "listening";
  useEffect(() => {
    if (!voice || !listening) return;
    const off = voice.onLevel(setLevel);
    return () => {
      off();
      setLevel(0);
    };
  }, [voice, listening]);

  // Answers read aloud.
  useEffect(() => {
    if (!backend) return;
    return backend.onCompanion((update) => {
      const say = answerToSpeak(update, optsRef.current.settings);
      if (say) queue.say(say.text, "answer", say.key);
    });
  }, [backend, queue]);

  // Event alerts from the hub's tile snapshots.
  useEffect(() => {
    if (!backend) return;
    let prev: TileInfo[] | undefined;
    const onTiles = (snapshot: HubSnapshot) => {
      const s = optsRef.current.settings;
      if (prev && anyAlertOn(s)) {
        for (const alert of tileAlerts(prev, snapshot.tiles, s)) {
          queue.say(alert.text, "alert");
        }
      }
      prev = snapshot.tiles;
    };
    const off = backend.onHubTiles(onTiles);
    backend.hubSnapshot().then((s) => prev ??= s.tiles, () => {});
    return off;
  }, [backend, queue]);

  // Stop speaking when the app goes away, and when Speak answers is turned off.
  useEffect(() => () => void queue.interrupt(), [queue]);
  const { speakAnswers } = opts.settings;
  useEffect(() => {
    if (!speakAnswers) void queue.interrupt();
  }, [speakAnswers]);

  // The hold-to-talk key: intercepted at the window (capture) before xterm, like the workspace's
  // shortcuts; xterm's own handler declines it (app/workspace.tsx `isWorkspaceShortcut`).
  const { pttKey } = opts.settings;
  const { platform, enabled } = opts;
  useEffect(() => {
    if (!controller || !enabled) return;
    let downAt: number | undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPushToTalk(e, pttKey, platform)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || downAt !== undefined) return;
      downAt = Date.now();
      void controller.press();
    };
    const end = () => {
      if (downAt === undefined) return;
      const held = Date.now() - downAt;
      downAt = undefined;
      void controller.release(held);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (downAt === undefined || !isPushToTalkRelease(e, pttKey, platform)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      end();
    };
    globalThis.addEventListener("keydown", onKeyDown, true);
    globalThis.addEventListener("keyup", onKeyUp, true);
    globalThis.addEventListener("blur", end);
    return () => {
      globalThis.removeEventListener("keydown", onKeyDown, true);
      globalThis.removeEventListener("keyup", onKeyUp, true);
      globalThis.removeEventListener("blur", end);
      if (downAt !== undefined) void controller.cancel();
    };
  }, [controller, pttKey, platform, enabled]);

  return {
    state,
    speaking,
    level: listening ? level : 0,
    voice,
    keys,
    press: () => void controller?.press(),
    release: (heldMs) => void controller?.release(heldMs),
    cancel: () => void controller?.cancel(),
    send: (text) => controller?.send(text),
    summarize: () => controller?.summarize(),
    stopSpeaking: () => void queue.interrupt(),
    test: (text) => {
      void queue.interrupt().then(() => queue.say(text, "alert"));
    },
    alert: (text) => queue.say(text, "alert"),
  };
}
