/**
 * Push-to-talk: the speech-to-text engine adapter and the controller between the mic button / the
 * hold-to-talk key and where the transcript goes.
 *
 * - Press (the mic button, or the key held): barge-in first (anything being said stops), then the
 *   engine listens. Release: it stops, and the transcript is routed (lib/voice/routing.ts).
 * - A short click on the mic button (under {@linkcode LATCH_MS}) latches: it keeps listening until
 *   the next click.
 * - With review on, the transcript waits in the chat box (Send / Edit / Cancel); otherwise it goes
 *   at once: to the companion (`userSays(text, "voice")`), to the summary request, or typed into
 *   the focused tile in dictate mode.
 * - The hold-to-dictate key presses with `{ dictate: true }`: that one capture is typed into the
 *   focused tile whatever dictate mode says (a one-shot dictation). Where a capture goes is fixed
 *   by the press that starts it (`state.target`, set while it listens too).
 *
 * Client-safe and pure: the engine and the outlets are injected.
 *
 * @module
 */

import { routeTranscript, type VoiceRoute } from "./routing.ts";
import type { SttEngineId, VoiceSettings } from "./settings.ts";

/** Why an engine cannot run here, and what fixes it. */
export type SttUnavailable = {
  ok: false;
  reason: string;
  /** What Settings → Voice offers: download the model, set a key, build the native library. */
  fix?: "download-model" | "set-key" | "build-lib";
};

/** A speech-to-text engine behind the adapter. */
export interface SttEngine {
  readonly id: SttEngineId | "fake";
  /** Whether it can run now (the library, the model, a key, the webview's support). */
  probe(): Promise<{ ok: true } | SttUnavailable>;
  /** Start listening. */
  start(): Promise<void>;
  /** Stop listening; the transcript (`""` when nothing was said). */
  stop(): Promise<string>;
  /** Stop listening and drop the audio. */
  cancel(): Promise<void>;
}

/** Where push-to-talk is. */
export type VoicePhase =
  | "idle"
  | "starting"
  | "listening"
  | "transcribing"
  | "review"
  | "error";

export interface VoiceState {
  phase: VoicePhase;
  /** A short click latched listening on (the next click stops). */
  latched: boolean;
  /** The transcript under review. */
  transcript: string;
  /** Where the capture (listening, or the transcript under review) goes. */
  target: "companion" | "dictate";
  /** What went wrong, or a note ("I didn't catch that"). */
  message: string;
}

export const IDLE_VOICE: VoiceState = {
  phase: "idle",
  latched: false,
  transcript: "",
  target: "companion",
  message: "",
};

/** What typing a dictated transcript into the focused tile came to. */
export type DictateOutcome =
  /** Typed. */
  | "typed"
  /** No tile has the focus. */
  | "no-tile"
  /** The focused tile cannot take text (a web page the engine cannot type into). */
  | "not-editable";

/** What the controller says when a dictation could not be typed. */
export const DICTATE_MISS: Record<Exclude<DictateOutcome, "typed">, string> = {
  "no-tile": "No tile has the focus to type into.",
  "not-editable": "Can't type into this page.",
};

/** A click on the mic button shorter than this latches listening on. */
const LATCH_MS = 300;

export interface VoiceControllerOptions {
  engine(): SttEngine;
  /** Voice settings, and the companion's name (the summary phrase may be addressed by it). */
  settings(): Pick<VoiceSettings, "review" | "dictate"> & { name?: string };
  /** Barge-in: stop speaking (the speech queue's `interrupt`). */
  bargeIn(): void;
  /** Send `text` to the companion as spoken. */
  toCompanion(text: string): void;
  /** Ask the companion for the window summary. */
  summarize(): void;
  /** Type `text` into the focused tile (a web page answers once its page took the text). */
  dictate(text: string): DictateOutcome | Promise<DictateOutcome>;
  onState(state: VoiceState): void;
}

/** The push-to-talk controller. */
export class VoiceController {
  #opts: VoiceControllerOptions;
  #state: VoiceState = IDLE_VOICE;
  #engine: SttEngine | undefined;
  /** Released while still starting: stop as soon as it listens. */
  #releaseAfterStart = false;
  /** Bumped by cancel: a start or stop in flight from before is ignored. */
  #generation = 0;
  /** The capture in progress is a one-shot dictation (the hold-to-dictate key). */
  #oneShot = false;

  constructor(opts: VoiceControllerOptions) {
    this.#opts = opts;
  }

  get state(): VoiceState {
    return this.#state;
  }

  #set(patch: Partial<VoiceState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#opts.onState(this.#state);
  }

  /** Whether the engine is busy (starting, listening or transcribing). */
  get active(): boolean {
    const p = this.#state.phase;
    return p === "starting" || p === "listening" || p === "transcribing";
  }

  /**
   * The talk key went down, or the mic button was pressed. `dictate`: the hold-to-dictate key,
   * whose capture is typed into the focused tile whatever dictate mode says.
   */
  async press(opts: { dictate?: boolean } = {}): Promise<void> {
    if (this.#state.latched && this.#state.phase === "listening") {
      return await this.release(Infinity);
    }
    if (this.active) return;
    this.#opts.bargeIn();
    const generation = ++this.#generation;
    this.#releaseAfterStart = false;
    const engine = this.#opts.engine();
    this.#engine = engine;
    this.#oneShot = opts.dictate === true;
    this.#set({
      phase: "starting",
      latched: false,
      transcript: "",
      target: this.#oneShot || this.#opts.settings().dictate
        ? "dictate"
        : "companion",
      message: "",
    });
    try {
      const probe = await engine.probe();
      if (!probe.ok) throw new Error(probe.reason);
      await engine.start();
    } catch (e) {
      if (generation === this.#generation) this.#fail(e);
      return;
    }
    if (generation !== this.#generation) {
      await engine.cancel().catch(() => {});
      return;
    }
    this.#set({ phase: "listening" });
    if (this.#releaseAfterStart) await this.release(Infinity);
  }

  /**
   * The talk key went up, or the mic button was let go after `heldMs`. A short click latches
   * (listening goes on until the next press).
   */
  async release(heldMs: number): Promise<void> {
    const phase = this.#state.phase;
    if (phase === "starting") {
      if (heldMs < LATCH_MS) this.#set({ latched: true });
      else this.#releaseAfterStart = true;
      return;
    }
    if (phase !== "listening") return;
    if (heldMs < LATCH_MS && !this.#state.latched) {
      this.#set({ latched: true });
      return;
    }
    const engine = this.#engine!;
    const generation = this.#generation;
    this.#set({ phase: "transcribing", latched: false });
    let text: string;
    try {
      text = await engine.stop();
    } catch (e) {
      if (generation === this.#generation) this.#fail(e);
      return;
    }
    if (generation !== this.#generation) return;
    this.#heard(text);
  }

  /** Stop listening and drop the audio, or drop the transcript under review. */
  async cancel(): Promise<void> {
    this.#generation++;
    this.#oneShot = false;
    const engine = this.#engine;
    const wasActive = this.active;
    this.#engine = undefined;
    this.#set({ ...IDLE_VOICE });
    if (wasActive && engine) await engine.cancel().catch(() => {});
  }

  /** Send the transcript under review (as edited). */
  send(text: string): void {
    if (this.#state.phase !== "review") return;
    const { name } = this.#opts.settings();
    const route = routeTranscript(text, {
      dictate: this.#state.target === "dictate",
      ...(name !== undefined ? { name } : {}),
    });
    this.#set({ ...IDLE_VOICE });
    this.#deliver(route);
  }

  /** The Summarize button. */
  summarize(): void {
    this.#opts.bargeIn();
    this.#opts.summarize();
  }

  #heard(text: string): void {
    const settings = this.#opts.settings();
    const dictate = this.#oneShot || settings.dictate;
    this.#oneShot = false;
    const route = routeTranscript(text, {
      dictate,
      ...(settings.name !== undefined ? { name: settings.name } : {}),
    });
    if (route.kind === "empty") {
      return this.#set({
        ...IDLE_VOICE,
        target: dictate ? "dictate" : "companion",
        message: "I didn't catch that.",
      });
    }
    if (settings.review) {
      const transcript = route.kind === "summarize" ? text.trim() : route.text;
      return this.#set({
        ...IDLE_VOICE,
        phase: "review",
        transcript,
        target: dictate ? "dictate" : "companion",
      });
    }
    this.#set({ ...IDLE_VOICE });
    this.#deliver(route);
  }

  #deliver(route: VoiceRoute): void {
    switch (route.kind) {
      case "empty":
        return;
      case "summarize":
        return this.#opts.summarize();
      case "companion":
        return this.#opts.toCompanion(route.text);
      case "dictate": {
        const outcome = this.#opts.dictate(route.text);
        if (typeof outcome === "string") return this.#typed(outcome);
        // A web page answers later: the note shows unless another capture started meanwhile.
        const generation = this.#generation;
        const late = (o: DictateOutcome) => {
          if (generation === this.#generation && this.#state.phase === "idle") {
            this.#typed(o);
          }
        };
        void outcome.then(late, () => late("not-editable"));
      }
    }
  }

  /** What typing a dictation came to: a note when it could not be typed. */
  #typed(outcome: DictateOutcome): void {
    if (outcome !== "typed") {
      this.#set({ target: "dictate", message: DICTATE_MISS[outcome] });
    }
  }

  #fail(e: unknown): void {
    this.#engine = undefined;
    this.#oneShot = false;
    this.#set({
      ...IDLE_VOICE,
      phase: "error",
      target: this.#state.target,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
