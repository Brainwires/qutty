# Qutty

A tiling terminal for macOS. Every terminal lives in one window, and the one you
are using gets the most space: in the cascade layout, tiles shrink the longer
they go unused, so your working set stays big and the rest step back. Terminals
that don't fit move to the switcher bar.

Website: <https://qutty.org>

## Features

- **Cascade layout.** The focused terminal is largest, the previous one second
  largest, and so on.
- **Seven layout patterns**: cascade (dwindle), spiral, master-stack, columns,
  rows, grid and monocle, with animated transitions.
- **Switcher bar**, horizontal or vertical, holding the terminals that overflow
  the cluster.
- **Adjustable font** typeface and size.
- Real shells through a PTY, rendered with xterm.js (WebGL when available).

## Install

Download the `.dmg` for your Mac (Apple Silicon `arm64` or Intel `x86_64`) from
[Releases](https://github.com/Brainwires/qutty/releases), open it and drag Qutty
to Applications. Builds are signed with a Developer ID and notarized by Apple.

## Development

Qutty is built with [Denext](https://jsr.io/@denext/denext) on Deno **2.9.8**
(the desktop runtime needs that exact version: `deno upgrade --version 2.9.8`).

| Command                     | What it does                                                   |
| --------------------------- | -------------------------------------------------------------- |
| `deno task desktop`         | Export the app and run it in a desktop window                  |
| `deno task dev`             | Browser dev server (demo backend, no real shells)              |
| `deno task test`            | Unit tests                                                     |
| `deno task test:e2e`        | End-to-end tests in headless Chromium                          |
| `deno task check`           | Type-check                                                     |
| `deno task fallow`          | Dead code, duplication and health gates ([fallow])             |
| `deno task desktop:package` | Build the `.app` and `.dmg` into `dist/`                       |
| `deno task install`         | Build, sign, notarize and install into `/Applications` (macOS) |

[fallow]: https://docs.fallow.tools

### Layout

- `app/`: the UI (Denext App Router; `workspace.tsx` is the root client
  component).
- `lib/layout/`: the layout engine (pure functions, property-tested).
- `lib/workspace/`: state, shortcuts, fonts and the switcher bar logic.
- `desktop/pty.ts`: the desktop extension that runs shells through node-pty.
- `tests/`: unit tests; `tests/e2e/`: browser tests.

### Releasing

Bump `version` in `deno.json`, add a `CHANGELOG.md` entry, then push a tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The Release workflow builds arm64 and x86_64 apps, signs and notarizes them, and
attaches the `.dmg` files to a draft GitHub release.

## License

[MIT](LICENSE)
