# App icons

`deno desktop` uses a default icon unless you provide your own. Drop platform
icons in this folder, then reference them from the `desktop` block in
`deno.json`:

```jsonc
"desktop": {
  "app": {
    "name": "denext app",
    "identifier": "com.example.denext",
    "icons": {
      "macos": "./icons/app.icns",
      "windows": "./icons/app.ico",
      "linux": "./icons/app.png"
    }
  }
}
```

- **macOS** `app.icns` · **Windows** `app.ico` · **Linux** `app.png` (512×512+)
