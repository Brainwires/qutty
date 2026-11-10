// Settings → Voice: the companion's voice layer (lib/voice/).
//
// - Speaking: read answers aloud, the engine (the OS's speech, or Deepgram Aura with your key),
//   voice, rate, volume, a test button, and the spoken event alerts, one toggle each.
// - Listening: the speech-to-text engine (on-device Whisper by default; Deepgram or ElevenLabs
//   with your key; the webview's Web Speech only where it exists), the native library's and the
//   model's status with the first-use download (its size said before it starts), the hold-to-talk
//   key, transcript review, and "Dictate into focused tile".
// - Cloud keys go to the voice extension, which keeps them in the OS keychain (its own namespace
//   of Denext's secure store); this page can save, replace or remove a key and see whether one is
//   saved, never read it back (app/companion/api-key-field.tsx). Nothing goes to a cloud service
//   unless one is picked here.

import { useEffect, useState } from "denext";
import type { VoiceApi } from "../use-voice.ts";
import type { VoiceStatus } from "../../lib/voice/client.ts";
import type { ModelState } from "../../lib/voice/model.ts";
import { webRecognition } from "../../lib/voice/engines.ts";
import type { CloudService } from "../../lib/voice/client.ts";
import { ApiKeyField } from "./api-key-field.tsx";
import {
  isCloudEngine,
  PTT_KEYS,
  type PttKey,
  STT_ENGINES,
  type SttEngineId,
  TTS_ENGINES,
  type TtsEngineId,
  type VoiceSettings,
} from "../../lib/voice/settings.ts";
import {
  type KeyPlatform,
  pttAvailable,
  shortcutLabel,
} from "../../lib/workspace/keys.ts";

export interface VoiceSettingsProps {
  settings: VoiceSettings;
  platform: KeyPlatform;
  voice: VoiceApi | null;
  onChange(patch: Partial<VoiceSettings>): void;
}

const TTS_LABEL: Record<TtsEngineId, string> = {
  system: "This computer's voice",
  deepgram: "Deepgram Aura (cloud, your key)",
};

const STT_LABEL: Record<SttEngineId, string> = {
  local: "On this computer (Whisper)",
  deepgram: "Deepgram (cloud, your key)",
  elevenlabs: "ElevenLabs (cloud, your key)",
  web: "The window's Web Speech",
};

const ALERTS: { key: keyof VoiceSettings; label: string }[] = [
  { key: "alertFinished", label: "An agent finished" },
  {
    key: "alertPermission",
    label: "An agent needs you (permission, question)",
  },
  { key: "alertBuildFailed", label: "A build failed" },
];

/** The page's speechSynthesis voices (names), where it has them. */
function useSystemVoices(): string[] {
  const [voices, setVoices] = useState<string[]>([]);
  useEffect(() => {
    const synth = (globalThis as { speechSynthesis?: SpeechSynthesis })
      .speechSynthesis;
    if (typeof synth?.getVoices !== "function") return;
    const read = () =>
      setVoices([...new Set(synth.getVoices().map((v) => v.name))].sort());
    read();
    synth.addEventListener?.("voiceschanged", read);
    return () => synth.removeEventListener?.("voiceschanged", read);
  }, []);
  return voices;
}

/** The native library's and the model's status, the download's progress. */
function useVoiceStatus(voice: VoiceApi | null) {
  const backend = voice?.voice;
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [model, setModel] = useState<ModelState | null>(null);
  useEffect(() => {
    if (!backend) return;
    let live = true;
    backend.status().then((s) => {
      if (!live) return;
      setStatus(s);
      setModel((m) => m?.state === "downloading" ? m : s.model);
    }, (e) => console.warn("voice: status", e));
    const off = backend.onModel((s) => live && setModel(s));
    return () => {
      live = false;
      off();
    };
  }, [backend]);
  const download = () => {
    if (!backend) return;
    setModel({ state: "downloading", received: 0, total: 0 });
    backend.downloadModel().then(
      setModel,
      (e) => setModel({ state: "error", error: String(e?.message ?? e) }),
    );
  };
  const cancel = () =>
    void backend?.cancelDownload().then(
      () => setModel({ state: "missing" }),
    );
  return { status, model, download, cancel };
}

/** A cloud service's key: kept by the voice extension in the OS keychain. */
function KeyField(
  props: { voice: VoiceApi; service: CloudService; platform: KeyPlatform },
) {
  const { voice, service } = props;
  const keys = voice.keys;
  if (!keys) return null;
  return (
    <ApiKeyField
      name={service === "deepgram" ? "Deepgram" : "ElevenLabs"}
      testid={`voice-key-${service}`}
      has={() => keys.has(service)}
      save={(key) => keys.set(service, key)}
      remove={() => keys.remove(service)}
      demo={voice.voice?.kind !== "desktop"}
      platform={props.platform}
    />
  );
}

/** The on-device engine: the library and the model, with the download. */
function LocalEngineStatus(props: { voice: VoiceApi }) {
  const { status, model, download, cancel } = useVoiceStatus(props.voice);
  if (!status) return <span class="field-hint">Checking…</span>;
  const size = status.model.size;
  return (
    <div class="voice-local" data-testid="voice-local-status">
      <span class="field-hint" data-testid="voice-lib-status">
        {status.lib.ok
          ? `Audio library: ${status.lib.version}`
          : `Audio library not installed: ${status.lib.reason}`}
      </span>
      <span
        class="field-hint"
        data-testid="voice-model-status"
        data-state={model?.state ?? ""}
      >
        {status.model.label}: {model?.state === "ready"
          ? "downloaded"
          : model?.state === "downloading"
          ? `downloading ${
            model.total ? Math.floor((model.received / model.total) * 100) : 0
          }%`
          : model?.state === "verifying"
          ? "checking the download…"
          : model?.state === "error"
          ? `failed (${model.error})`
          : `not downloaded (${size}, fetched once from Hugging Face)`}
      </span>
      {model?.state === "downloading"
        ? (
          <progress
            max={model.total || 1}
            value={model.received}
            data-testid="voice-model-progress"
          />
        )
        : null}
      {(model?.state === "missing" || model?.state === "error") && (
        <button
          type="button"
          class="btn-quiet"
          data-testid="voice-model-download"
          onClick={download}
        >
          Download the speech model ({size})
        </button>
      )}
      {model?.state === "downloading" && (
        <button type="button" class="btn-quiet" onClick={cancel}>
          Cancel download
        </button>
      )}
    </div>
  );
}

function Check(props: {
  label: string;
  testid: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label class="field field-check">
      <input
        type="checkbox"
        data-testid={props.testid}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)}
      />
      <span class="field-label">{props.label}</span>
    </label>
  );
}

export function VoiceSettingsSection(props: VoiceSettingsProps) {
  const { settings, onChange, voice, platform } = props;
  const voices = useSystemVoices();
  const hasWebSpeech = webRecognition() !== undefined;
  const cloudTts = isCloudEngine(settings.ttsEngine);
  return (
    <div class="voice-settings" data-testid="voice-settings">
      <Check
        label="Read aloud (Loopy's answers)"
        testid="setting-voice-speak"
        checked={settings.speakAnswers}
        onChange={(speakAnswers) => onChange({ speakAnswers })}
      />
      <label class="field">
        <span class="field-label">Voice engine</span>
        <select
          class="field-select"
          data-testid="setting-voice-tts"
          value={settings.ttsEngine}
          onChange={(e) =>
            onChange({
              ttsEngine: (e.target as HTMLSelectElement).value as TtsEngineId,
              voice: "",
            })}
        >
          {TTS_ENGINES.map((t) => (
            <option value={t} key={t}>
              {TTS_LABEL[t]}
            </option>
          ))}
        </select>
        {cloudTts && (
          <span class="field-hint">
            Answers are sent to Deepgram to be spoken, and played here.
          </span>
        )}
      </label>
      {cloudTts && voice && (
        <KeyField voice={voice} service="deepgram" platform={platform} />
      )}
      <label class="field">
        <span class="field-label">Voice</span>
        {!cloudTts && voices.length > 0
          ? (
            <select
              class="field-select"
              data-testid="setting-voice-voice"
              value={settings.voice}
              onChange={(e) =>
                onChange({ voice: (e.target as HTMLSelectElement).value })}
            >
              <option value="">Default</option>
              {voices.map((v) => <option value={v} key={v}>{v}</option>)}
            </select>
          )
          : (
            <input
              type="text"
              class="font-custom"
              data-testid="setting-voice-voice"
              placeholder={cloudTts ? "aura-asteria-en" : "Default"}
              value={settings.voice}
              maxLength={128}
              onChange={(e) =>
                onChange({ voice: (e.target as HTMLInputElement).value })}
            />
          )}
      </label>
      <label class="field">
        <span class="field-label">
          Rate <output>{settings.rate.toFixed(1)}×</output>
        </span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={settings.rate}
          data-testid="setting-voice-rate"
          onInput={(e) => onChange({ rate: Number(e.currentTarget.value) })}
        />
      </label>
      <label class="field">
        <span class="field-label">
          Volume <output>{Math.round(settings.volume * 100)}%</output>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.volume}
          data-testid="setting-voice-volume"
          onInput={(e) => onChange({ volume: Number(e.currentTarget.value) })}
        />
      </label>
      <div class="field">
        <button
          type="button"
          class="btn-quiet"
          data-testid="setting-voice-test"
          disabled={!voice}
          onClick={() => voice?.test("Hi, I'm Loopy. This is how I sound.")}
        >
          Test voice
        </button>
      </div>
      <div class="field">
        <span class="field-label">Say it out loud when</span>
        {ALERTS.map((a) => (
          <Check
            key={a.key}
            label={a.label}
            testid={`setting-voice-${a.key}`}
            checked={settings[a.key] as boolean}
            onChange={(on) => onChange({ [a.key]: on })}
          />
        ))}
      </div>
      <label class="field">
        <span class="field-label">Speech to text</span>
        <select
          class="field-select"
          data-testid="setting-voice-stt"
          value={settings.sttEngine}
          onChange={(e) =>
            onChange({
              sttEngine: (e.target as HTMLSelectElement).value as SttEngineId,
            })}
        >
          {STT_ENGINES.map((t) => (
            <option
              value={t}
              key={t}
              disabled={settings.sttEngine !== t && t === "web" &&
                !hasWebSpeech}
            >
              {STT_LABEL[t]}
              {t === "web" && !hasWebSpeech ? " (not in this window)" : ""}
            </option>
          ))}
        </select>
        <span class="field-hint">
          {isCloudEngine(settings.sttEngine)
            ? "What you say is recorded here and sent to the service you picked."
            : settings.sttEngine === "web"
            ? "The window's own engine (it may use its vendor's servers)."
            : "Nothing leaves this computer."}
        </span>
      </label>
      {voice && settings.sttEngine === "local" && (
        <LocalEngineStatus voice={voice} />
      )}
      {voice &&
        (settings.sttEngine === "deepgram" ||
          settings.sttEngine === "elevenlabs") &&
        (settings.sttEngine !== "deepgram" || !cloudTts) && (
        <KeyField
          voice={voice}
          service={settings.sttEngine}
          platform={platform}
        />
      )}
      <label class="field">
        <span class="field-label">Hold to talk</span>
        <select
          class="field-select"
          data-testid="setting-voice-ptt"
          value={settings.pttKey}
          onChange={(e) =>
            onChange({
              pttKey: (e.target as HTMLSelectElement).value as PttKey,
            })}
        >
          {PTT_KEYS.filter((k) => k === "off" || pttAvailable(k, platform)).map(
            (k) => (
              <option value={k} key={k}>
                {k === "off"
                  ? "Off (mic button only)"
                  : shortcutLabel(k, platform)}
              </option>
            ),
          )}
        </select>
      </label>
      <Check
        label="Show what I said before sending it (Send / Edit / Cancel)"
        testid="setting-voice-review"
        checked={settings.review}
        onChange={(review) => onChange({ review })}
      />
      <Check
        label="Dictate into the focused tile (no model)"
        testid="setting-voice-dictate"
        checked={settings.dictate}
        onChange={(dictate) => onChange({ dictate })}
      />
    </div>
  );
}
