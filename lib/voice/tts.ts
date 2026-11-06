/**
 * Text to speech: the engine adapter, the speech queue (answers and alerts said one at a time, in
 * order) and barge-in (`interrupt()`: whatever is being said stops and the queue is dropped, the
 * moment the user starts talking). Also which companion updates are read aloud, and how a reply is
 * made sayable (markdown and links dropped, long answers cut at a sentence).
 *
 * Client-safe and pure: the engines are injected (lib/voice/engines.ts has the real ones).
 *
 * @module
 */

import type { CompanionUpdate } from "../companion/protocol.ts";
import type { VoiceSettings } from "./settings.ts";

/** How to speak. */
export interface SpeakOptions {
  /** A voice name or id; the engine's default when absent. */
  voice?: string;
  /** 1 is normal. */
  rate?: number;
  /** 0–1. */
  volume?: number;
}

/** A speech engine: the OS's (`speak()` from denext/mobile) or a cloud one played locally. */
export interface TtsEngine {
  readonly id: string;
  /** Say `text`; settles when it has been said, or stopped. */
  speak(text: string, options: SpeakOptions): Promise<void>;
  /** Stop speaking now. */
  stop(): Promise<void>;
}

/** What is queued: an answer, or a (short) event alert. */
export type SpeechKind = "answer" | "alert";

interface QueuedSpeech {
  text: string;
  kind: SpeechKind;
}

export interface SpeechQueueOptions {
  /** The engine to use now (Settings may change it between items). */
  engine(): TtsEngine;
  /** The voice, rate and volume now. */
  options(): SpeakOptions;
  /** Whether something is being said changed. */
  onSpeaking?(speaking: boolean, text?: string): void;
  /** An engine error (logged; the queue moves on). */
  onError?(error: unknown): void;
  /** At most this many items wait (the oldest alerts go first). */
  maxQueued?: number;
}

/** The speech queue. */
export class SpeechQueue {
  #opts: SpeechQueueOptions;
  #queue: QueuedSpeech[] = [];
  #current: QueuedSpeech | undefined;
  #engine: TtsEngine | undefined;
  /** Bumped by `interrupt`: a speak call of an older generation is not followed by the next. */
  #generation = 0;
  #said = new Set<string>();

  constructor(opts: SpeechQueueOptions) {
    this.#opts = opts;
  }

  /** Whether something is being said. */
  get speaking(): boolean {
    return this.#current !== undefined;
  }

  /** How many items wait. */
  get pending(): number {
    return this.#queue.length;
  }

  /**
   * Queue `text`. `key` says each thing once (a turn's answer, even if its update is replayed).
   */
  say(text: string, kind: SpeechKind = "answer", key?: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (key !== undefined) {
      if (this.#said.has(key)) return;
      this.#said.add(key);
      if (this.#said.size > 500) {
        this.#said.delete(this.#said.values().next().value!);
      }
    }
    this.#queue.push({ text: clean, kind });
    const max = this.#opts.maxQueued ?? 8;
    while (this.#queue.length > max) {
      const alert = this.#queue.findIndex((q) => q.kind === "alert");
      this.#queue.splice(alert >= 0 ? alert : 0, 1);
    }
    this.#pump();
  }

  /** Barge-in: stop what is being said and drop the queue. */
  async interrupt(): Promise<void> {
    this.#generation++;
    this.#queue = [];
    const engine = this.#engine;
    const was = this.#current !== undefined;
    this.#current = undefined;
    this.#engine = undefined;
    if (was) this.#opts.onSpeaking?.(false);
    if (engine) {
      try {
        await engine.stop();
      } catch (e) {
        this.#opts.onError?.(e);
      }
    }
  }

  #pump(): void {
    if (this.#current) return;
    const next = this.#queue.shift();
    if (!next) return;
    const generation = this.#generation;
    let engine: TtsEngine;
    try {
      engine = this.#opts.engine();
    } catch (e) {
      this.#opts.onError?.(e);
      return this.#pump();
    }
    this.#current = next;
    this.#engine = engine;
    this.#opts.onSpeaking?.(true, next.text);
    let done: Promise<void>;
    try {
      done = engine.speak(next.text, this.#opts.options());
    } catch (e) {
      done = Promise.reject(e);
    }
    done.catch((e) => this.#opts.onError?.(e)).finally(() => {
      if (generation !== this.#generation) return; // interrupted: already reset
      this.#current = undefined;
      this.#engine = undefined;
      if (this.#queue.length === 0) this.#opts.onSpeaking?.(false);
      this.#pump();
    });
  }
}

/** The longest answer read aloud (cut at a sentence end before it). */
const MAX_SPOKEN = 600;

/**
 * `text` as it should be said: code, markdown marks, links and list bullets dropped, cut to about
 * {@linkcode MAX_SPOKEN} characters at a sentence end.
 */
export function speakableText(text: string): string {
  let t = text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > MAX_SPOKEN) {
    const cut = t.slice(0, MAX_SPOKEN);
    const end = Math.max(
      cut.lastIndexOf(". "),
      cut.lastIndexOf("! "),
      cut.lastIndexOf("? "),
    );
    t = end > MAX_SPOKEN / 3 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return t;
}

/**
 * What to read aloud for a companion update, or `null`: a finished answer to the user (typed or
 * spoken) while Speak answers is on. Errors, agents' mail turns and partial text are not read.
 */
export function answerToSpeak(
  update: CompanionUpdate,
  settings: Pick<VoiceSettings, "speakAnswers">,
): { key: string; text: string } | null {
  if (!settings.speakAnswers || update.kind !== "turn") return null;
  if (!update.done || update.isError || update.quiet) return null;
  if (update.source !== "user") return null;
  const text = speakableText(update.text);
  return text ? { key: `turn:${update.turn}`, text } : null;
}
