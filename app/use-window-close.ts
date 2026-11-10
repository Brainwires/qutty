// The window's close button (`denext/desktop/window`'s `onCloseRequested`, through the session's
// `guardClose`): after Settings → Windows → "When a window closes", the window detaches (its
// shells keep running), ends its shells as the Window menu's "Close Window and End Its Shells"
// does (a busy agent asked about first), or the page asks (app/close-window-dialog.tsx). A quit is
// never held here: the app's quit guard asks about busy agents.
//
// Nothing else asks: the Window menu's item, "End workspace" and the page's own `closeWindow`
// bypass the close guard. Without one (the demo, an older runtime) the window just closes.

import { useCallback, useEffect, useRef, useState } from "denext";
import type { SessionBackend } from "../lib/session-client.ts";
import {
  createCloseGuard,
  type WindowClose,
} from "../lib/workspace/windows.ts";

/** The close question's answer. */
export type CloseAnswer = "keep" | "end" | "cancel";

export interface WindowCloseApi {
  /** Whether close requests are held (the Windows setting means something here). */
  guarded: boolean;
  /** The close question is showing. */
  asking: boolean;
  /** Answer the question; `remember` saves Keep or End as the setting (Cancel never does). */
  answer(choice: CloseAnswer, remember: boolean): void;
}

export function useWindowClose(opts: {
  session: SessionBackend | undefined;
  setting: WindowClose;
  /** Save a remembered choice. */
  onRemember(choice: WindowClose): void;
  /** The question was cancelled: give the keyboard back to the terminal. */
  onCancel(): void;
}): WindowCloseApi {
  const { session } = opts;
  const [guarded, setGuarded] = useState(false);
  const [asking, setAsking] = useState(false);
  const settingRef = useRef(opts.setting);
  settingRef.current = opts.setting;
  const guardRef = useRef<ReturnType<typeof createCloseGuard> | null>(null);

  useEffect(() => {
    if (!session) return;
    const guard = createCloseGuard({
      setting: () => settingRef.current,
      ask: () => setAsking(true),
      end: () => session.endWindow({ confirm: true }),
    });
    guardRef.current = guard;
    let live = true;
    let off: (() => void) | null = null;
    session.guardClose((reason) => guard.request(reason)).then(
      (unguard) => {
        if (!live) return unguard?.();
        off = unguard;
        setGuarded(unguard !== null);
      },
      () => {},
    );
    return () => {
      live = false;
      off?.();
      guardRef.current = null;
      setAsking(false);
    };
  }, [session]);

  const { onRemember, onCancel } = opts;
  const answer = useCallback((choice: CloseAnswer, remember: boolean) => {
    setAsking(false);
    const guard = guardRef.current;
    if (choice === "cancel" || !session) {
      guard?.settle();
      onCancel();
      return;
    }
    if (remember) onRemember(choice);
    const done = choice === "keep"
      ? session.closeWindow()
      : session.endWindow({ confirm: true });
    // Once the window has closed nothing is left to settle; a declined end keeps it open.
    void done.catch(() => {}).finally(() => guard?.settle());
  }, [session, onRemember, onCancel]);

  return { guarded, asking, answer };
}
