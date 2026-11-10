// What the Linux packages say about Qutty, from denext.config.ts through denext's own package
// builders: the .deb's launcher, metainfo, icon and control file, and the AppImage's AppDir. The
// bundle is a stand-in (the real one needs `deno desktop` on Linux; the release workflow's dry
// run checks that one), so this covers the metadata denext writes, not the runtime.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildDesktopAppImage,
  buildDesktopDeb,
  desktopPackageMeta,
} from "denext/desktop";

const SCRIPT = new URL("../scripts/package-linux.ts", import.meta.url).href;
const ID = "org.qutty.Qutty";
const EXE = "Qutty-x64";

/** The members of an `ar` archive (a .deb), by name. */
function arMembers(bytes: Uint8Array): Map<string, Uint8Array> {
  const text = new TextDecoder();
  assertEquals(text.decode(bytes.subarray(0, 8)), "!<arch>\n");
  const out = new Map<string, Uint8Array>();
  for (let at = 8; at < bytes.length;) {
    const header = text.decode(bytes.subarray(at, at + 60));
    const size = Number(header.slice(48, 58).trim());
    out.set(
      header.slice(0, 16).trim(),
      bytes.subarray(at + 60, at + 60 + size),
    );
    at += 60 + size + (size % 2);
  }
  return out;
}

/** The regular files of a gzipped ustar archive, by path (`./usr/…`). */
async function tarFiles(gz: Uint8Array): Promise<Map<string, Uint8Array>> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  const text = new TextDecoder();
  const str = (from: number, len: number) =>
    text.decode(tar.subarray(from, from + len)).replace(/\0.*$/s, "");
  const out = new Map<string, Uint8Array>();
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const prefix = str(at + 345, 155);
    const name = prefix ? `${prefix}/${str(at, 100)}` : str(at, 100);
    const size = parseInt(str(at + 124, 12).trim() || "0", 8);
    if (str(at + 156, 1) === "0") {
      out.set(name, tar.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** A stand-in for the bundle `buildDesktopBundle` leaves: launcher, entry and icon. */
async function fakeBundle(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "qutty-linux-bundle-" });
  await Deno.writeTextFile(join(dir, EXE), "#!/bin/sh\nexit 0\n");
  await Deno.chmod(join(dir, EXE), 0o755);
  const icon = await Deno.readFile(
    new URL("../icons/app.png", import.meta.url),
  );
  await Deno.writeFile(join(dir, "AppIcon.png"), icon);
  await Deno.writeFile(join(dir, `${ID}.png`), icon);
  await Deno.writeTextFile(
    join(dir, `${ID}.desktop`),
    `[Desktop Entry]\nType=Application\nName=Qutty\nExec=env LAUFEY_APP_ID=${ID} "${EXE}"\n` +
      `Icon=${ID}\nCategories=System;TerminalEmulator;\n`,
  );
  return dir;
}

Deno.test("linux packaging: the config's desktop entry, license and no-reply email", async () => {
  const meta = await desktopPackageMeta(SCRIPT, "Qutty", "linux");
  assertEquals(meta.identifier, ID);
  assertEquals(meta.name, "Qutty");
  assertEquals(meta.license, "MIT");
  assertEquals(meta.email, "155631428+Brainwires@users.noreply.github.com");
  assertEquals(meta.desktopEntry?.categories, ["System", "TerminalEmulator"]);
  assertEquals(meta.desktopEntry?.genericName, "Terminal");
  // The launchers run the app as its id (LAUFEY_APP_ID), which is its window class.
  assertEquals(meta.desktopEntry?.startupWMClass, ID);
  assert(meta.desktopEntry?.keywords?.includes("terminal"));
});

Deno.test("linux packaging: the .deb's launcher, metainfo, icon and Maintainer", async () => {
  const meta = await desktopPackageMeta(SCRIPT, "Qutty", "linux");
  const bundle = await fakeBundle();
  const out = await Deno.makeTempDir({ prefix: "qutty-linux-deb-" });
  try {
    const deb = await buildDesktopDeb({
      meta,
      bundleDir: bundle,
      exe: EXE,
      arch: "x86_64",
      out: join(out, "Qutty-x64.deb"),
    });
    const members = arMembers(await Deno.readFile(deb));
    const control = new TextDecoder().decode(
      (await tarFiles(members.get("control.tar.gz")!)).get("./control"),
    );
    assertStringIncludes(
      control,
      "\nMaintainer: Brainwires <155631428+Brainwires@users.noreply.github.com>\n",
    );
    assertStringIncludes(control, "libwebkit2gtk-4.1-0");

    const data = await tarFiles(members.get("data.tar.gz")!);
    const text = (path: string) => {
      const bytes = data.get(path);
      assert(
        bytes,
        `${path} is in the .deb (it has ${[...data.keys()].join(", ")})`,
      );
      return new TextDecoder().decode(bytes);
    };
    const entry = text(`./usr/share/applications/${ID}.desktop`);
    for (
      const line of [
        "Name=Qutty",
        "GenericName=Terminal",
        `StartupWMClass=${ID}`,
        "Categories=System;TerminalEmulator;",
        "Keywords=terminal;shell;console;command line;tiling;ssh;",
      ]
    ) {
      assert(entry.split("\n").includes(line), `${line} in:\n${entry}`);
    }
    const icon = /^Icon=(.+)$/m.exec(entry)?.[1];
    assert(icon, `an Icon= line in:\n${entry}`);
    assert(
      [...data.keys()].some((p) =>
        p.startsWith("./usr/share/icons/") && p.endsWith(`/${icon}.png`)
      ),
      `the ${icon}.png icon is installed`,
    );

    const metainfo = text(`./usr/share/metainfo/${ID}.metainfo.xml`);
    assertStringIncludes(metainfo, `<id>${ID}</id>`);
    assertStringIncludes(metainfo, "<project_license>MIT</project_license>");
    assertStringIncludes(
      metainfo,
      `<launchable type="desktop-id">${ID}.desktop</launchable>`,
    );
    assertStringIncludes(metainfo, `<release version="${meta.version}"`);
  } finally {
    await Deno.remove(bundle, { recursive: true });
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test("linux packaging: the AppImage's AppDir (entry, icon, metainfo, AppRun)", async () => {
  const meta = await desktopPackageMeta(SCRIPT, "Qutty", "linux");
  const bundle = await fakeBundle();
  const out = await Deno.makeTempDir({ prefix: "qutty-linux-appimage-" });
  const seen: Record<string, string> = {};
  try {
    await buildDesktopAppImage({
      meta,
      bundleDir: bundle,
      exe: EXE,
      arch: "x86_64",
      out: join(out, "Qutty-x64.AppImage"),
      runtimeFile: "/pinned/runtime",
      date: "2026-11-10",
      // Stands in for appimagetool: read the AppDir it would wrap.
      run: async (_cmd, args, env) => {
        assertEquals(args.slice(0, 2), ["--runtime-file", "/pinned/runtime"]);
        assertEquals(env.ARCH, "x86_64");
        const appDir = args[2];
        for (
          const f of [
            `${ID}.desktop`,
            `usr/share/applications/${ID}.desktop`,
            `usr/share/metainfo/${ID}.metainfo.xml`,
            "AppRun",
          ]
        ) seen[f] = await Deno.readTextFile(join(appDir, f));
        assert((await Deno.stat(join(appDir, ".DirIcon"))).isFile);
      },
    });
    assertStringIncludes(seen["AppRun"], `LAUFEY_APP_ID:-${ID}`);
    assertStringIncludes(seen["AppRun"], `exec "$HERE/${EXE}"`);
    assertEquals(
      seen[`usr/share/applications/${ID}.desktop`],
      seen[`${ID}.desktop`],
    );
    const metainfo = seen[`usr/share/metainfo/${ID}.metainfo.xml`];
    assertStringIncludes(
      metainfo,
      '<release version="' + meta.version + '" date="2026-11-10"/>',
    );
    // The host libraries an AppImage does not carry: the webview backend's.
    assertStringIncludes(metainfo, "libwebkit2gtk-4.1.so.0");
  } finally {
    await Deno.remove(bundle, { recursive: true });
    await Deno.remove(out, { recursive: true });
  }
});
