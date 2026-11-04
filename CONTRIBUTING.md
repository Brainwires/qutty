# Contributing to Qutty

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Setup

- [Deno](https://deno.com) **2.9.8** exactly: `deno upgrade --version 2.9.8`.
  The desktop runtime is built for that version.
- macOS: nothing else.
- Linux: node-pty has no prebuilt Linux binary, so compile it once (needs
  `node`, `npm`, `python3`, `make` and a C++ compiler):

  ```sh
  sh scripts/build-node-pty-linux.sh
  ```

Then:

```sh
deno task desktop     # run the app
deno task test        # unit tests
deno task test:e2e    # browser tests (headless Chromium, downloaded on first run)
```

`deno task dev` runs the UI in a browser with a demo shell, which is handy for
layout work.

## Pull requests

`main` is protected. Every change goes through a pull request, and CI must pass
before it can merge:

- `deno fmt --check` and `deno lint`
- `deno task check`: type-check (run `deno task export` first, it generates
  `.deno-desktop/config.json`)
- `deno task fallow`: no dead code, no new duplication, health score at least 85
- unit tests on macOS Apple Silicon, macOS Intel and Linux
- end-to-end tests in Chromium

Run them locally before pushing:

```sh
deno fmt && deno lint && deno task export && deno task check && deno task fallow && deno task test
```

Please:

- keep a PR to one topic, and add or update tests for what it changes;
- add a line under `## Unreleased` in `CHANGELOG.md` for anything user-visible;
- leave the user's own key bindings alone: Qutty honors macOS
  `DefaultKeyBinding.dict` and never invents key mappings of its own.

## Releases (maintainers)

Releases are cut by pushing a tag. They are not made on merge.

1. In a PR, set `version` in `deno.json` (for example `0.2.0`) and rename
   `## Unreleased` in `CHANGELOG.md` to `## 0.2.0`. Merge it.
2. Tag the merge commit and push the tag:

   ```sh
   git tag -a v0.2.0 -m "Qutty 0.2.0" && git push origin v0.2.0
   ```

The Release workflow checks that the tag matches `deno.json`, runs the tests,
then builds, signs and notarizes the Apple Silicon and Intel apps. It publishes
the release with both `.dmg` files, their SHA-256 checksums and that version's
changelog section. A tag with a suffix (`v0.2.0-beta.1`) becomes a pre-release.
