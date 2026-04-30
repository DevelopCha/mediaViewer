## Deployment Runtime Notes

This app is packaged as a Tauri desktop app.

Release builds are now configured to bundle these runtime assets inside the app:

- `src-tauri/scripts/`
- `src-tauri/.rembg-venv/`
- `src-tauri/resources/tools/`

At runtime the app will try bundled resources first, then fall back to local developer tools.

### What this means for end users

- No terminal window should appear during normal release usage.
- `ffmpeg` and `ffprobe` can be shipped inside the installer.
- The background-removal Python runtime can also be shipped inside the installer.
- Installed location no longer matters because the app resolves bundled resource paths dynamically.

### Platform note

The currently bundled Python virtual environment in `src-tauri/.rembg-venv/` is platform-specific.

- A Windows build needs a Windows Python runtime.
- A macOS build needs a macOS Python runtime.

For macOS release packaging, prepare the equivalent macOS runtime before building the `.dmg`.

### Current remaining limitation

The `withoutbg` engine may still need model files that are not yet bundled with the app.
If you want truly offline first-run behavior for that engine too, its model assets should also be packaged.
