Current icon layout for this desktop app:

- `32x32.png`
  Used by the dev window icon override in `src-tauri/src/lib.rs`.

- `128x128.png`
- `128x128@2x.png`
- `icon.ico`
- `icon.icns`
  Used by Tauri desktop bundling through `src-tauri/tauri.conf.json`.

- `source/mviewer-source.png`
  Editable master source image for regenerating the desktop icon set.

Removed on purpose:

- `64x64.png`
- `icon.png`
- `StoreLogo.png`
- `Square*.png`
- `android/`
- `ios/`

Those files were generated for other packaging targets or extra formats, but are not used by the current desktop-only dev/build flow.
