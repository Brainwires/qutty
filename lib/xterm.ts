// The single import point for xterm.js and its addons.
//
// `@xterm/*` resolve (deno.json) to the vendored ESM builds in vendor/xterm/, not to the npm
// packages: see vendor/xterm/README.md for why (UMD `main` entries Deno cannot read when denext
// evaluates this client module on the server, and an unbundled dev server that cannot serve an
// `npm:` specifier to the browser). The `.mjs` builds carry no types, so each import attaches
// the pinned package's own typings (`@xterm/*/types` in deno.json).

// @ts-types="@xterm/xterm/types"
export { Terminal } from "@xterm/xterm";
// @ts-types="@xterm/xterm/types"
export type {
  ILink,
  ILinkProvider,
  ITerminalOptions,
  ITheme,
} from "@xterm/xterm";
// @ts-types="@xterm/addon-fit/types"
export { FitAddon } from "@xterm/addon-fit";
// @ts-types="@xterm/addon-webgl/types"
export { WebglAddon } from "@xterm/addon-webgl";
