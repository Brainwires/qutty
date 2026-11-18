"use client";
// The hero's download button. The server renders the safe default (a link to /download); once
// hydrated it looks at the visitor's system and, when it can tell, points straight at the file:
// the .dmg for the Mac's chip, or the AppImage for the Linux machine's architecture.

import { useEffect, useState } from "denext";

export interface DownloadTargets {
  version: string;
  macArm64: string;
  macX64: string;
  linuxArm64: string;
  linuxX64: string;
}

interface Choice {
  href: string;
  label: string;
}

interface UAData {
  platform?: string;
  getHighEntropyValues?(hints: string[]): Promise<{ architecture?: string; bitness?: string }>;
}

/** Apple Silicon or Intel, from WebGL's renderer string (Safari and Firefox have no UA-CH). */
function macGpuArch(): "arm" | "x86" | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const r = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    // Safari says "Apple GPU" on every Mac, Intel ones too: that stays undecided.
    if (/Apple M\d/i.test(r)) return "arm";
    if (/Intel|AMD|Radeon|NVIDIA/i.test(r)) return "x86";
  } catch {
    // no WebGL: undecided
  }
  return null;
}

async function detect(t: DownloadTargets): Promise<Choice | null> {
  const nav = navigator as Navigator & { userAgentData?: UAData };
  const ua = nav.userAgent;
  const platform = nav.userAgentData?.platform ?? "";
  let arch = "";
  try {
    arch = (await nav.userAgentData?.getHighEntropyValues?.(["architecture", "bitness"]))
      ?.architecture ?? "";
  } catch {
    // refused: fall back to the user agent string
  }
  const isMac = platform === "macOS" || (/Macintosh|Mac OS X/.test(ua) && !/Mobile/.test(ua));
  if (isMac) {
    const kind = arch ? (arch === "arm" ? "arm" : "x86") : macGpuArch();
    if (kind === "arm") {
      return { href: t.macArm64, label: "Download for macOS (Apple Silicon)" };
    }
    if (kind === "x86") return { href: t.macX64, label: "Download for macOS (Intel)" };
    return { href: "/download#macos", label: "Download for macOS" };
  }
  const isLinux = platform === "Linux" || (/Linux/.test(ua) && !/Android/.test(ua));
  if (isLinux) {
    const armish = arch === "arm" || /aarch64|arm64/i.test(ua);
    const x86 = arch === "x86" || /x86_64|amd64/i.test(ua);
    if (armish) return { href: t.linuxArm64, label: "Download for Linux (arm64 AppImage)" };
    if (x86) return { href: t.linuxX64, label: "Download for Linux (x86_64 AppImage)" };
    return { href: "/download#linux", label: "Download for Linux" };
  }
  return null; // Windows, phones: the download page says what there is
}

export function DownloadButton({ targets }: { targets: DownloadTargets }) {
  const [choice, setChoice] = useState<Choice | null>(null);
  useEffect(() => {
    let live = true;
    detect(targets).then((c) => {
      if (live) setChoice(c);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <a
      class="button"
      href={choice?.href ?? "/download"}
      data-detected={choice ? "yes" : "no"}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" stroke-linecap="round" />
      </svg>
      {choice?.label ?? `Download Qutty ${targets.version}`}
    </a>
  );
}
