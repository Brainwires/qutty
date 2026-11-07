/**
 * The demo backend's links (browser dev mode and the e2e suite): a small fake file system under
 * `/Users/demo` for `linkResolve`, the editors it pretends are installed, and `linkOpen` /
 * `linkEdit` that only check their input (nothing opens; the e2e suite spies on the calls).
 *
 * @module
 */

import {
  editorArgv,
  isOpenableUrl,
  type LinkEditRequest,
  type LinkOpenRequest,
  type LinkTarget,
  resolvePath,
} from "./links.ts";

const DEMO_HOME = "/Users/demo";

/** The fake file system: folders end with `/`. */
const DEMO_FS = new Set([
  "/etc/hosts",
  "/Users/demo/",
  "/Users/demo/Applications/",
  "/Users/demo/Desktop/",
  "/Users/demo/Documents/",
  "/Users/demo/Downloads/",
  "/Users/demo/Source/",
  "/Users/demo/Source/qutty/",
  "/Users/demo/Source/qutty/src/",
  "/Users/demo/Source/qutty/src/main.ts",
  "/Users/demo/Source/qutty/README.md",
  "/Users/demo/notes.md",
  "/Users/demo/build.sh",
  "/Users/demo/todo.txt",
]);

function kindOf(path: string): LinkTarget["kind"] | null {
  if (DEMO_FS.has(`${path}/`) || path === "/") return "dir";
  return DEMO_FS.has(path) ? "file" : null;
}

export function createDemoLinks() {
  return {
    resolve(
      cwd: string | undefined,
      paths: string[],
    ): Promise<(LinkTarget | null)[]> {
      return Promise.resolve(paths.map((p) => {
        const path = resolvePath(p, cwd, DEMO_HOME);
        const kind = path ? kindOf(path) : null;
        return path && kind ? { path, kind } : null;
      }));
    },
    open(request: LinkOpenRequest): Promise<void> {
      const ok = request.kind === "url"
        ? isOpenableUrl(request.url)
        : kindOf(request.path) !== null;
      return ok ? Promise.resolve() : Promise.reject(new Error("cannot open"));
    },
    editors(): Promise<string[]> {
      return Promise.resolve(["code", "zed"]);
    },
    edit(request: LinkEditRequest): Promise<void> {
      return editorArgv(request.command, request) && kindOf(request.file)
        ? Promise.resolve()
        : Promise.reject(new Error("the editor command is not usable"));
    },
  };
}
