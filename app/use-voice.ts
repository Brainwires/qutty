// The workspace's voice layer (lib/voice/): the companion's answers and the chosen event alerts read
// aloud through one speech queue, and push-to-talk — the mic button on the companion or the
// hold-to-talk key — through the speech-to-text engine picked in Settings → Voice. The transcript
// goes to the companion (`companionSend(text, "voice")`), to the summary request, or, in dictate
// mode, is typed into the focused tile. Talking (or pressing the mic) stops whatever is being said:
// barge-in. The hold-to-dictate key (Settings → Voice, off until picked) is a second hold key: its
// capture is always typed into the focused tile (a one-shot dictation), and it works with the
// companion off too — the controller lives here whenever there is a backend, not only with the
// companion shown. Review (Send / Edit / Cancel) happens only while the overlay is shown to hold
// the review box. While it listens, the microphone's level (0–1, about 20 times a second) is
// followed for the companion's pulse, and drops back to 0 when listening stops.
//
// With the companion floating (app/companion/floating-companion.tsx) each window has a voice layer:
// the floating one reads the answers aloud and reviews its mic's transcripts; a workspace window
// keeps its talk keys (the keyboard is there) and its tile alerts, but leaves the answers
// (`answers: false`) and the review box (`review: false`) to the floating companion.
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
  type DictateOutcome,
  IDLE_VOICE,
  VoiceController,
  type VoiceState,
} from "../lib/voice/controller.ts";
import {
  backendKeys,
  cloudTts,
  demoTts,
  type KeyStore,
  kokoroTts,
  sttEngine,
  systemTts,
} from "../lib/voice/engines.ts";
import { anyAlertOn, tileAlerts } from "../lib/voice/alerts.ts";
import { SUMMARIZE_PROMPT } from "../lib/voice/routing.ts";
import type { PttKey, VoiceSettings } from "../lib/voice/settings.ts";
import { answerToSpeak, SpeechQueue } from "../lib/voice/tts.ts";
import {
  dictateKeyAvailable,
  isPushToTalk,
  isPushToTalkRelease,
  type KeyPlatform,
} from "../lib/workspace/keys.ts";

export interface UseVoiceOptions {
  backend: PtyBackend | undefined;
  settings: VoiceSettings;
  platform: KeyPlatform;
  /**
   * Whether the companion overlay is shown: the push-to-talk key and transcript review need it;
   * the hold-to-dictate key does not.
   */
  enabled: boolean;
  /** Whether a transcript may wait for review (default `enabled`): the review box is shown here. */
  review?: boolean;
  /** Read the companion's answers aloud here (default `true`). */
  answers?: boolean;
  /** Say the tile alerts (Settings → Voice → alerts) here (default `true`). */
  alerts?: boolean;
  /** The companion's name (Settings → Companion → Name): the summary phrase may address it. */
  companionName?: string;
  /** Type `text` into the focused tile (its terminal, or a web tile's page, which answers late). */
  deliverToFocused(text: string): DictateOutcome | Promise<DictateOutcome>;
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
  /** Start a one-shot dictation into the focused tile (an agent tile's mic button). */
  pressDictate(): void;
  release(heldMs: number): void;
  cancel(): void;
  send(text: string): void;
  summarize(): void;
  /** Barge-in by hand (the stop button). */
  stopSpeaking(): void;
  /** Say `text` now (Settings' "Test voice"). */
  test(text: string): void;
  /**
   * Say `text` now in `voice` (an OS voice's id; the engine's default when `""`), cutting off
   * whatever is being said (Settings' voice preview). The engine in use speaks: with Kokoro,
   * `kokoroVoice` names its voice (else the one in Settings).
   */
  preview(text: string, voice: string, kokoroVoice?: string): void;
  /** Say `text` as an alert, after whatever is being said (the companion's reactions). */
  alert(text: string): void;
  /**
   * Voice mode: say `text` from the companion's bubble, in order after what is queued, or with
   * `replace` cutting off whatever is being said (a new bubble replaced the old one).
   */
  speak(text: string, replace?: boolean): void;
  /** Bumped whenever the user cuts speech off (barge-in, the stop button): a stream stops there. */
  speechCut(): number;
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

  // The on-device voice (desktop only): one engine, so a stop reaches the speech it started.
  const kokoro = useMemo(
    () =>
      voice?.kind === "desktop"
        ? kokoroTts(voice, () => optsRef.current.settings.kokoroVoice)
        : undefined,
    [voice],
  );

  // Voice mode's speech, in order: a `replace` waits for the interrupt to settle first.
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const cutRef = useRef(0);
  const queue = useMemo(() =>
    new SpeechQueue({
      engine: () => {
        const s = optsRef.current.settings;
        if (script && isTestMode()) return demoTts(script);
        if (s.ttsEngine === "deepgram" && voice?.kind === "desktop" && keys) {
          return cloudTts(voice, keys);
        }
        // The on-device voice; the OS's stands in until its model is downloaded.
        if (s.ttsEngine === "kokoro" && kokoro) return kokoro;
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
    }), [voice, script, keys, kokoro]);

  const controller = useMemo(() => {
    if (!voice || !backend || !keys) return undefined;
    return new VoiceController({
      engine: () => sttEngine(optsRef.current.settings.sttEngine, voice, keys),
      // Review only where the review box can be shown (on the companion).
      settings: () => {
        const { settings, enabled, companionName, review } = optsRef.current;
        return {
          dictate: settings.dictate,
          review: settings.review && (review ?? enabled),
          ...(companionName !== undefined ? { name: companionName } : {}),
        };
      },
      bargeIn: () => {
        cutRef.current++;
        void queue.interrupt();
      },
      toCompanion: (text) =>
        void backend.companionSend(text, "voice").catch(() => {}),
      summarize: () =>
        void backend.companionSend(SUMMARIZE_PROMPT, "voice").catch(() => {}),
      dictate: (text) => optsRef.current.deliverToFocused(text),
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
      if (optsRef.current.answers === false) return;
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
      if (prev && anyAlertOn(s) && optsRef.current.alerts !== false) {
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
  const { speakAnswers, voiceMode } = opts.settings;
  useEffect(() => {
    if (!speakAnswers && !voiceMode) void queue.interrupt();
  }, [speakAnswers, voiceMode]);

  // The hold-to-talk key (with the overlay shown) and the hold-to-dictate key (always, once
  // picked): intercepted at the window (capture) before xterm, like the workspace's shortcuts;
  // xterm's own handler declines them (app/workspace.tsx `isWorkspaceShortcut`).
  const { pttKey, dictateKey } = opts.settings;
  const { platform, enabled } = opts;
  useHoldKey(controller, pttKey, platform, enabled, false);
  useHoldKey(
    controller,
    dictateKey,
    platform,
    dictateKeyAvailable(dictateKey, pttKey, platform),
    true,
  );

  return {
    state,
    speaking,
    level: listening ? level : 0,
    voice,
    keys,
    press: () => void controller?.press(),
    pressDictate: () => void controller?.press({ dictate: true }),
    release: (heldMs) => void controller?.release(heldMs),
    cancel: () => void controller?.cancel(),
    send: (text) => controller?.send(text),
    summarize: () => controller?.summarize(),
    stopSpeaking: () => {
      cutRef.current++;
      void queue.interrupt();
    },
    test: (text) => {
      void queue.interrupt().then(() => queue.say(text, "alert"));
    },
    preview: (text, voice, kokoroVoice) => {
      void queue.interrupt().then(() =>
        queue.say(text, "alert", undefined, {
          ...(voice ? { voice } : {}),
          ...(kokoroVoice ? { kokoroVoice } : {}),
        })
      );
    },
    alert: (text) => queue.say(text, "alert"),
    speak: (text, replace = false) => {
      const ready = replace ? queue.interrupt() : chainRef.current;
      chainRef.current = ready.then(() => queue.say(text, "answer"));
    },
    speechCut: () => cutRef.current,
  };
}

/**
 * Hold `key` to talk: down presses the controller (`dictate`: a one-shot dictation), up (its key,
 * Shift or the modifier let go, or the window losing focus) releases it after the time held.
 */
function useHoldKey(
  controller: VoiceController | undefined,
  key: PttKey,
  platform: KeyPlatform,
  active: boolean,
  dictate: boolean,
): void {
  useEffect(() => {
    if (!controller || !active) return;
    let downAt: number | undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPushToTalk(e, key, platform)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || downAt !== undefined) return;
      downAt = Date.now();
      void controller.press(dictate ? { dictate } : {});
    };
    const end = () => {
      if (downAt === undefined) return;
      const held = Date.now() - downAt;
      downAt = undefined;
      void controller.release(held);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (downAt === undefined || !isPushToTalkRelease(e, key, platform)) {
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
  }, [controller, key, platform, active, dictate]);
}
