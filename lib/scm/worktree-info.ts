/**
 * Which git checkout a folder is in, read from the files alone (no git run): the nearest `.git`
 * above it, a folder for a repository's main worktree or a `gitdir:` file for a linked worktree
 * (`git worktree add`), and the branch its `HEAD` names. The agent hub (desktop/hub.ts) tags each
 * tile with it, so `list_peers` tells agents and the companion who works in which worktree.
 * Pure: the file reads come in.
 *
 * @module
 */

/** The checkout a tile's folder is in. */
export interface TileWorktree {
  /** The checkout's top folder. */
  path: string;
  /** The branch checked out (absent when HEAD is detached). */
  branch?: string;
  /** A linked worktree (`git worktree add`), not the repository's main checkout. */
  linked: boolean;
}

/** The file reads it needs: a file's text (`null`: not a readable file), and whether a path is a folder. */
export interface WorktreeFs {
  readText(path: string): string | null;
  isDir(path: string): boolean;
}

/** The checkout `cwd` (absolute) is in, or `undefined` when it is in none. */
export function worktreeOf(
  cwd: string,
  fs: WorktreeFs,
): TileWorktree | undefined {
  if (!cwd.startsWith("/")) return undefined;
  let dir = cwd.replace(/\/+$/, "") || "/";
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = `${dir === "/" ? "" : dir}/.git`;
    let gitDir: string | null = null;
    let linked = false;
    if (fs.isDir(dotGit)) gitDir = dotGit;
    else {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readText(dotGit) ?? "");
      if (m) {
        gitDir = m[1].startsWith("/") ? m[1] : `${dir}/${m[1]}`;
        linked = /\/worktrees\/[^/]+\/?$/.test(gitDir);
      }
    }
    if (gitDir !== null) {
      const head = fs.readText(`${gitDir}/HEAD`) ?? "";
      const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
      return { path: dir, ...(ref ? { branch: ref[1] } : {}), linked };
    }
    if (dir === "/") return undefined;
    dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
  }
  return undefined;
}

/** {@linkcode WorktreeFs} over Deno's synchronous file reads (the desktop side). */
export const denoWorktreeFs: WorktreeFs = {
  readText(path) {
    try {
      return Deno.readTextFileSync(path);
    } catch {
      return null;
    }
  },
  isDir(path) {
    try {
      return Deno.statSync(path).isDirectory;
    } catch {
      return false;
    }
  },
};
