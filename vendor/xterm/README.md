# Vendored xterm.js ESM builds

Byte-for-byte copies of the `lib/*.mjs` ESM builds from the pinned npm packages (MIT, see
LICENSE):

| file | package |
| --- | --- |
| `xterm.mjs` | `@xterm/xterm@6.0.0` |
| `addon-fit.mjs` | `@xterm/addon-fit@0.11.0` |
| `addon-webgl.mjs` | `@xterm/addon-webgl@0.19.0` |

Why not `npm:` imports: the packages' `main` is a UMD/CommonJS bundle whose named exports Deno
cannot detect when denext evaluates a client module on the server, and denext's unbundled dev
server hands an `npm:` bare specifier to the browser unchanged (it only serves import-map targets
that are files inside the project). `deno.json` maps `@xterm/*` here; `lib/xterm.ts` attaches the
packages' own typings with `@ts-types`. `public/xterm.css` is the matching stylesheet copy.

To upgrade: bump the versions in `lib/xterm.ts`, re-copy the three files and `css/xterm.css`.
