"use client";

// The floating companion (Settings → Companion → Floating): the page of its own window
// (`/companion`, opened by the app for whichever workspace window asks: desktop/companion-window.ts).
// The companion overlay fills the transparent window (app/companion/companion-overlay.tsx): its
// face, its bubble with agents' questions and `qutty-hook say` messages from every workspace,
// its chat box, the mic, Summarize and Stop buttons. The window lets clicks through outside them,
// drags with the companion, keeps where it was dropped, and takes the keyboard only for the chat
// box (app/companion/use-floating-window.ts).
//
// It is not a workspace: it joins none and has no tiles. Its settings are the workspace windows'
// (the page's storage, followed as they change); a mode other than Floating closes it. Its voice
// layer reads the answers aloud and runs its mic (dictation has no tile to type into here); the
// tile alerts stay with the workspace windows. The hot face and the reactions to finished jobs
// stay in the window too: they follow a window's own tiles.

import { useEffect, useLayoutEffect, useRef, useState } from "denext";
import { CompanionOverlay } from "./companion-overlay.tsx";
import { useFloatingWindow } from "./use-floating-window.ts";
import { useVoice } from "../use-voice.ts";
import { getPtyBackend, type PtyBackend } from "../../lib/pty-client.ts";
import {
  loadSettings,
  sanitizeSettings,
  type Settings,
  SETTINGS_STORAGE_KEY,
} from "../../lib/workspace/store.ts";
import { brainChoice, companionOn } from "../../lib/companion/settings.ts";
import { applyChromeTheme, themeById } from "../../lib/workspace/themes.ts";
import {
  detectPlatform,
  type KeyPlatform,
  pttAvailable,
  shortcutLabel,
} from "../../lib/workspace/keys.ts";

/** The workspace windows' settings, from the page's storage. */
function storedSettings(): Settings {
  return sanitizeSettings(loadSettings());
}

/** The settings, followed as another window changes them. */
function useSharedSettings(): Settings {
  const [settings, setSettings] = useState<Settings>(storedSettings);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SETTINGS_STORAGE_KEY) setSettings(storedSettings());
    };
    globalThis.addEventListener("storage", onStorage);
    return () => globalThis.removeEventListener("storage", onStorage);
  }, []);
  return settings;
}

/** Whether the user asked for less motion. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    setReduced(!!mq?.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq?.addEventListener?.("change", on);
    return () => mq?.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

export function FloatingCompanion() {
  const [backend, setBackend] = useState<PtyBackend | null>(null);
  const [platform, setPlatform] = useState<KeyPlatform>("other");
  const settings = useSharedSettings();
  const reducedMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const { companion } = settings;

  useEffect(() => {
    setPlatform(detectPlatform());
    setBackend(getPtyBackend());
  }, []);

  // The theme's colours for the bubble and the chat box.
  useLayoutEffect(() => {
    applyChromeTheme(document.documentElement, themeById(settings.theme));
  }, [settings.theme]);

  const win = useFloatingWindow(rootRef, backend, companion.floatAllSpaces);

  // The brain, as the workspace windows set it (the same settings; asking again is a no-op).
  const { engine, model } = brainChoice(companion);
  const brainOn = companion.brain && companionOn(companion.mode);
  useEffect(() => {
    if (!backend) return;
    backend.companionConfigure(brainOn, model, engine, companion.name).catch(
      (e) => console.warn("companion: could not configure its brain", e),
    );
  }, [backend, brainOn, model, engine, companion.name]);

  // Another mode was picked: this window goes (the workspace windows close it too).
  const floating = companion.mode === "floating";
  useEffect(() => {
    if (!backend || floating) return;
    backend.companionWindow({ open: false }).catch(() => {});
  }, [backend, floating]);

  const voice = useVoice({
    backend: backend ?? undefined,
    settings: settings.voice,
    platform,
    enabled: true,
    alerts: false,
    companionName: companion.name,
    deliverToFocused: () => "no-tile",
  });

  return (
    <div
      ref={rootRef}
      class="floating-companion"
      data-testid="floating-companion"
    >
      {backend && (
        <CompanionOverlay
          backend={backend}
          name={companion.name}
          corner="bottom-left"
          brain={companion.brain}
          lively={companion.lively}
          reducedMotion={reducedMotion}
          floating
          mover={win.mover}
          takeKeyboard={win.takeKeyboard}
          onRefocus={() => {
            // Only when this window took the keyboard (its chat box): give it back.
            if (document.hasFocus()) {
              backend.companionRefocus().catch(() => {});
            }
          }}
          voice={voice}
          pttLabel={pttAvailable(settings.voice.pttKey, platform)
            ? shortcutLabel(settings.voice.pttKey, platform)
            : ""}
          reactions={{
            nightSleepy: companion.nightSleepy,
            nightFrom: companion.nightFrom,
            nightTo: companion.nightTo,
            bubble: companion.reactBubble,
          }}
        />
      )}
    </div>
  );
}
