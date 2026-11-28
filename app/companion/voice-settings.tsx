// Settings → Voice: the companion's voice layer (lib/voice/).
//
// - Speaking: read answers aloud, the engine (Kokoro, a neural voice run on this computer, with
//   its model's first-use download; the OS's speech; or Deepgram Aura with your key), voice,
//   rate, volume, a test button, and the spoken event alerts, one toggle each. One voice list
//   shows, the one that speaks: Kokoro's voices (by accent) when Kokoro is the engine and its
//   model is downloaded, else the OS voices (lib/voice/voices.ts): the user's language first,
//   best first, "Show all languages" and "Show character voices", and on macOS where to get
//   better voices when none is installed for the language. Either list has a preview (▶), said
//   by the engine in use.
// - Listening: the speech-to-text engine (on-device Whisper by default; Deepgram or ElevenLabs
//   with your key; the webview's Web Speech only where it exists), the native library's and the
//   model's status with the first-use download (its size said before it starts), the hold-to-talk
//   key, the hold-to-dictate key (off until picked; never the same key as hold-to-talk: each
//   list greys out the other's key), transcript review, and "Dictate into focused tile".
// - Cloud keys go to the voice extension, which keeps them in the OS keychain (its own namespace
//   of Denext's secure store); this page can save, replace or remove a key and see whether one is
//   saved, never read it back (app/companion/api-key-field.tsx). Nothing goes to a cloud service
//   unless one is picked here.

import { useEffect, useState } from "denext";
import type { VoiceApi } from "../use-voice.ts";
import type { VoiceStatus } from "../../lib/voice/client.ts";
import type { ModelState } from "../../lib/voice/model.ts";
import {
  groupKokoroVoices,
  kokoroReady,
  type KokoroStatus,
  type KokoroVoice,
  pickKokoroVoice,
} from "../../lib/voice/kokoro.ts";
import { webRecognition } from "../../lib/voice/engines.ts";
import type { CloudService } from "../../lib/voice/client.ts";
import {
  classifyVoices,
  type VoiceInfo,
  voiceList,
} from "../../lib/voice/voices.ts";
import { ApiKeyField } from "./api-key-field.tsx";
import { SettingsGroup } from "../settings-ui.tsx";
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
  /** The companion's name (Settings → Companion → Name). */
  name: string;
  platform: KeyPlatform;
  voice: VoiceApi | null;
  onChange(patch: Partial<VoiceSettings>): void;
}

const TTS_LABEL: Record<TtsEngineId, string> = {
  kokoro: "Kokoro (natural voice, on this computer)",
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

/** The user's language (the window's). */
function userLanguage(): string {
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return nav?.language || "en-US";
}

/** The page's speechSynthesis voices, classified (lib/voice/voices.ts), where it has them. */
function useSystemVoices(): VoiceInfo[] {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  useEffect(() => {
    const synth = (globalThis as { speechSynthesis?: SpeechSynthesis })
      .speechSynthesis;
    if (typeof synth?.getVoices !== "function") return;
    const read = () =>
      setVoices(
        classifyVoices(
          synth.getVoices().map((v) => ({
            name: v.name,
            voiceURI: v.voiceURI,
            lang: v.lang,
          })),
          userLanguage(),
        ),
      );
    read();
    synth.addEventListener?.("voiceschanged", read);
    return () => synth.removeEventListener?.("voiceschanged", read);
  }, []);
  return voices;
}

/** Where macOS downloads its better voices. */
const BETTER_VOICES_HINT =
  "Better voices: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.";

/**
 * The OS voice picker: the user's language by default (their region first, the best voices
 * first), every language and the character voices on request, the stored voice always shown,
 * a preview of the picked one, and where to get better voices on macOS.
 */
function SystemVoicePicker(props: {
  voices: VoiceInfo[];
  value: string;
  name: string;
  platform: KeyPlatform;
  voice: VoiceApi | null;
  onChange(voice: string): void;
}) {
  const { voices, value, onChange } = props;
  const [showAll, setShowAll] = useState(false);
  const [showCharacters, setShowCharacters] = useState(false);
  const list = voiceList(voices, {
    userLang: userLanguage(),
    showAll,
    showCharacters,
    selected: value,
  });
  const selected = list.selected;
  // A voice saved by name (before 0.8.3) is kept by its id from now on; it says the same.
  useEffect(() => {
    if (
      selected && value && value !== selected.id && value === selected.rawName
    ) {
      onChange(selected.id);
    }
  }, [selected?.id, value]);
  const current = selected?.id ?? (value ? value : "");
  return (
    <>
      <div class="field" data-part="voice-picker">
        <span class="field-label" id="setting-voice-voice-label">Voice</span>
        <span class="voice-picker-control">
          <select
            class="field-select"
            data-testid="setting-voice-voice"
            aria-labelledby="setting-voice-voice-label"
            value={current}
            onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
          >
            <option value="">Default</option>
            {value && !selected && <option value={value}>{value}</option>}
            {list.groups.map((g) => (
              <optgroup label={g.heading} key={g.key} data-group={g.key}>
                {g.voices.map((v) => (
                  <option
                    value={v.id}
                    key={v.id}
                    data-tier={v.tier}
                    data-kind={v.kind}
                  >
                    {v.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            class="btn-quiet voice-preview"
            data-part="voice-preview"
            data-testid="setting-voice-preview"
            title="Preview this voice"
            aria-label="Preview this voice"
            disabled={!props.voice}
            onClick={() =>
              props.voice?.preview(
                `Hi, I'm ${props.name}. This is how I sound.`,
                current,
              )}
          >
            ▶
          </button>
        </span>
        {props.platform === "mac" && !list.hasBetterVoice && (
          <span
            class="field-hint"
            data-part="voice-hint"
            data-testid="setting-voice-hint"
          >
            {BETTER_VOICES_HINT}
          </span>
        )}
      </div>
      {list.otherLanguages > 0 && (
        <Check
          label={`Show all languages (${list.otherLanguages} more voices)`}
          testid="setting-voice-all-languages"
          checked={showAll}
          onChange={setShowAll}
        />
      )}
      {list.characters > 0 && (
        <Check
          label={`Show character voices (${list.characters})`}
          testid="setting-voice-characters"
          checked={showCharacters}
          onChange={setShowCharacters}
        />
      )}
    </>
  );
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

/** Kokoro's status (the library's speech support, its files), the download, the voices. */
function useKokoro(voice: VoiceApi | null) {
  const backend = voice?.voice;
  const [status, setStatus] = useState<KokoroStatus | null>(null);
  const [files, setFiles] = useState<ModelState | null>(null);
  const [voices, setVoices] = useState<KokoroVoice[]>([]);
  useEffect(() => {
    if (!backend) return;
    let live = true;
    backend.kokoroStatus().then((s) => {
      if (!live) return;
      setStatus(s);
      setFiles((f) => f?.state === "downloading" ? f : s.files);
    }, (e) => console.warn("voice: kokoro status", e));
    const off = backend.onKokoro((s) => live && setFiles(s));
    return () => {
      live = false;
      off();
    };
  }, [backend]);
  // The voices are read from the voices file, once it is there.
  const ready = files?.state === "ready" && status?.available === true;
  useEffect(() => {
    if (!backend || !ready) return setVoices([]);
    let live = true;
    backend.kokoroVoices().then(
      (v) => live && setVoices(v),
      (e) => console.warn("voice: kokoro voices", e),
    );
    return () => {
      live = false;
    };
  }, [backend, ready]);
  const download = () => {
    if (!backend) return;
    setFiles({ state: "downloading", received: 0, total: 0 });
    backend.downloadKokoro().then(
      setFiles,
      (e) => setFiles({ state: "error", error: String(e?.message ?? e) }),
    );
  };
  const cancel = () =>
    void backend?.cancelKokoroDownload().then(
      () => setFiles({ state: "missing" }),
    );
  return { status, files, voices, download, cancel };
}

/**
 * The on-device voice: whether the library can speak, the model's download (its size said before
 * it starts), and the voice, grouped by accent.
 */
function KokoroSettings(
  props: {
    kokoro: ReturnType<typeof useKokoro>;
    voice: VoiceApi;
    name: string;
    picked: string;
    onPick(id: string): void;
  },
) {
  const { status, files, voices, download, cancel } = props.kokoro;
  if (!status) return <span class="field-hint">Checking…</span>;
  if (!status.available) {
    return (
      <span class="field-hint" data-testid="voice-kokoro-status">
        The on-device voice is not available here ({status.reason ??
          "no speech in the audio library"}); this computer's voice speaks
        instead.
      </span>
    );
  }
  const size = status.files.size;
  const groups = groupKokoroVoices(voices);
  const current = pickKokoroVoice(props.picked, voices) ?? "";
  return (
    <div class="voice-local" data-testid="voice-kokoro-status">
      <span
        class="field-hint"
        data-testid="voice-kokoro-files"
        data-state={files?.state ?? ""}
      >
        Voice model (Kokoro): {files?.state === "ready"
          ? "downloaded. Speech is made on this computer; nothing is sent anywhere."
          : files?.state === "downloading"
          ? `downloading ${
            files.total ? Math.floor((files.received / files.total) * 100) : 0
          }%`
          : files?.state === "verifying"
          ? "checking the download…"
          : files?.state === "error"
          ? `failed (${files.error})`
          : `not downloaded (${size}, fetched once from Hugging Face and GitHub). This computer's voice speaks until then.`}
      </span>
      {files?.state === "downloading"
        ? (
          <progress
            max={files.total || 1}
            value={files.received}
            data-testid="voice-kokoro-progress"
          />
        )
        : null}
      {(files?.state === "missing" || files?.state === "error") && (
        <button
          type="button"
          class="btn-quiet"
          data-testid="voice-kokoro-download"
          onClick={download}
        >
          Download the voice model ({size})
        </button>
      )}
      {files?.state === "downloading" && (
        <button type="button" class="btn-quiet" onClick={cancel}>
          Cancel download
        </button>
      )}
      {groups.length > 0 && (
        <div class="field" data-part="voice-picker">
          <span class="field-label" id="setting-voice-kokoro-voice-label">
            Voice
          </span>
          <span class="voice-picker-control">
            <select
              class="field-select"
              data-testid="setting-voice-kokoro-voice"
              aria-labelledby="setting-voice-kokoro-voice-label"
              value={current}
              onChange={(e) =>
                props.onPick((e.target as HTMLSelectElement).value)}
            >
              {groups.map((g) => (
                <optgroup label={g.language} key={g.language}>
                  {g.voices.map((v) => (
                    <option value={v.id} key={v.id}>{v.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              class="btn-quiet voice-preview"
              data-part="voice-preview"
              data-testid="setting-voice-kokoro-preview"
              title="Preview this voice"
              aria-label="Preview this voice"
              onClick={() =>
                props.voice.preview(
                  `Hi, I'm ${props.name}. This is how I sound.`,
                  "",
                  current,
                )}
            >
              ▶
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

export function Check(props: {
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
  // Kokoro's state, asked for only while it is the engine. One voice list shows, the one that
  // speaks: Kokoro's once its model is there, else the OS's (which speaks until then).
  const kokoroPicked = settings.ttsEngine === "kokoro";
  const kokoro = useKokoro(kokoroPicked ? voice : null);
  const kokoroSpeaks = kokoroPicked && kokoroReady(
    kokoro.status && kokoro.files
      ? { ...kokoro.status, files: { ...kokoro.files, size: "" } }
      : undefined,
  );
  return (
    <div class="voice-settings" data-testid="voice-settings">
      <SettingsGroup title="Speaking" testid="voice-section">
        <Check
          label={`Read aloud (${props.name}'s answers)`}
          testid="setting-voice-speak"
          checked={settings.speakAnswers || settings.voiceMode}
          disabled={settings.voiceMode}
          onChange={(speakAnswers) => onChange({ speakAnswers })}
        />
        <Check
          label="Voice mode: say everything in the bubble aloud (answers as they stream, messages, questions, the quote of the day)"
          testid="setting-voice-mode"
          checked={settings.voiceMode}
          onChange={(voiceMode) => onChange({ voiceMode })}
        />
        <label class="field">
          <span class="field-label">Voice engine</span>
          <select
            class="field-select"
            data-testid="setting-voice-tts"
            value={settings.ttsEngine}
            onChange={(e) => {
              const ttsEngine = (e.target as HTMLSelectElement)
                .value as TtsEngineId;
              // A cloud engine's voice is a model's name, not an OS voice: start it over.
              // Between Kokoro and the OS voice, the OS voice picked is kept (it stands in).
              const reset = isCloudEngine(ttsEngine) || cloudTts;
              onChange({ ttsEngine, ...(reset ? { voice: "" } : {}) });
            }}
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
        {kokoroPicked && voice && (
          <KokoroSettings
            kokoro={kokoro}
            voice={voice}
            name={props.name}
            picked={settings.kokoroVoice}
            onPick={(kokoroVoice) => onChange({ kokoroVoice })}
          />
        )}
        {cloudTts && voice && (
          <KeyField voice={voice} service="deepgram" platform={platform} />
        )}
        {kokoroSpeaks ? null : !cloudTts && voices.length > 0
          ? (
            <SystemVoicePicker
              voices={voices}
              value={settings.voice}
              name={props.name}
              platform={platform}
              voice={voice}
              onChange={(v) => onChange({ voice: v })}
            />
          )
          : (
            <label class="field">
              <span class="field-label">Voice</span>
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
            </label>
          )}
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
            onClick={() =>
              voice?.test(`Hi, I'm ${props.name}. This is how I sound.`)}
          >
            Test voice
          </button>
        </div>
      </SettingsGroup>
      <SettingsGroup title="Spoken alerts">
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
      </SettingsGroup>
      <SettingsGroup title="Listening">
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
            {PTT_KEYS.filter((k) => k === "off" || pttAvailable(k, platform))
              .map(
                (k) => (
                  <option
                    value={k}
                    key={k}
                    disabled={k !== "off" && k === settings.dictateKey}
                  >
                    {k === "off"
                      ? "Off (mic button only)"
                      : shortcutLabel(k, platform)}
                    {k !== "off" && k === settings.dictateKey
                      ? " (the dictate key)"
                      : ""}
                  </option>
                ),
              )}
          </select>
        </label>
        <label class="field">
          <span class="field-label">Hold to dictate</span>
          <select
            class="field-select"
            data-testid="setting-voice-dictate-key"
            value={settings.dictateKey}
            onChange={(e) =>
              onChange({
                dictateKey: (e.target as HTMLSelectElement).value as PttKey,
              })}
          >
            {PTT_KEYS.filter((k) => k === "off" || pttAvailable(k, platform))
              .map(
                (k) => (
                  <option
                    value={k}
                    key={k}
                    disabled={k !== "off" && k === settings.pttKey}
                  >
                    {k === "off" ? "Off" : shortcutLabel(k, platform)}
                    {k !== "off" && k === settings.pttKey
                      ? " (the hold-to-talk key)"
                      : ""}
                  </option>
                ),
              )}
          </select>
          <span class="field-hint" data-testid="setting-voice-dictate-key-hint">
            Hold it and speak; let go to type what you said into the focused
            tile, with or without the companion.
          </span>
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
      </SettingsGroup>
    </div>
  );
}
