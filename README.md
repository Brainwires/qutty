# Qutty

[![CI](https://github.com/Brainwires/qutty/actions/workflows/ci.yml/badge.svg)](https://github.com/Brainwires/qutty/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Brainwires/qutty)](https://github.com/Brainwires/qutty/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A tiling terminal for macOS and Linux. Every terminal lives in one window, and
the one you are using gets the most space: in the cascade layout, tiles shrink
the longer they go unused, so your working set stays big and the rest step back.
Terminals that don't fit move to the switcher bar.

Website: <https://qutty.org>

## Features

- **Cascade layout.** The focused terminal is largest, the previous one second
  largest, and so on.
- **Seven layout patterns**: cascade (dwindle), spiral, master-stack, columns,
  rows, grid and monocle, with animated transitions.
- **Switcher bar**, horizontal or vertical, holding the terminals that overflow
  the cluster.
- **Tiled or free-form, per workspace**: let Qutty lay the tiles out, or switch
  to the free-form view and move, resize, overlap, cascade and arrange them as
  windows inside the workspace.
- **Minimize, Maximize and Restore** on every tile: a minimized tile waits in
  the switcher bar with its shell running.
- **Activity at a glance**: an unfocused tile shows new output, a running
  command, a bell, a failed or a finished command on its header and border,
  titled by what the program calls itself.
- **Six themes**, three dark and three light, switched live.
- **Adjustable font** typeface and size.
- **Your macOS key bindings** (`DefaultKeyBinding.dict`) work inside the
  terminal.
- Real shells through a PTY, rendered with xterm.js (WebGL when available).

## Install

### macOS

With [Homebrew](https://brew.sh):

```sh
brew tap brainwires/tap
brew trust --cask brainwires/tap/qutty   # Homebrew 7+ asks you to trust casks from other taps
brew install --cask brainwires/tap/qutty
```

Or download the `.dmg` for your Mac from the
[latest release](https://github.com/Brainwires/qutty/releases/latest): `arm64`
for Apple Silicon, `x86_64` for Intel. Open it and drag Qutty to Applications.
Builds are signed with a Developer ID and notarized by Apple.

### Linux

Each [release](https://github.com/Brainwires/qutty/releases/latest) has an
AppImage, a `.deb` and a tarball for `x86_64` and `arm64`. The window is
WebKitGTK, so the machine needs `libwebkit2gtk-4.1-0` and `libgtk-3-0` (Ubuntu
22.04+, Debian 12+, Fedora's `webkit2gtk4.1`). The `.deb` installs them for you.

Debian and Ubuntu:

```sh
sudo apt install ./Qutty-<version>-x86_64.deb   # or -arm64.deb
qutty
```

The package puts Qutty in `/usr/lib/qutty`, links `/usr/bin/qutty` and adds a
launcher and icon (listed with the terminal emulators).

Any distribution, with the AppImage:

```sh
chmod +x Qutty-<version>-x86_64.AppImage
./Qutty-<version>-x86_64.AppImage
```

It mounts itself with FUSE (`fusermount`, from the `fuse3` package, which most
desktops have); without it, run it with `--appimage-extract-and-run`. The
tarball holds the same app as a folder: unpack it and run `Qutty-x64/Qutty-x64`
(or `Qutty-arm64/Qutty-arm64`). Each file has a `.sha256` beside it
(`sha256sum -c Qutty-….sha256`).

Qutty also runs on Linux from source (see Development).

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

### Contributing and releasing

See [CONTRIBUTING.md](CONTRIBUTING.md): changes go through pull requests to
`main`, which must pass CI, and releases are cut by pushing a version tag.

## License

[MIT](LICENSE)
