# Architecture Overview

## Frontend

- `src/App.tsx`
  - Composes the media browser UI and feature flows.
  - Delegates Tauri calls to `src/lib/tauri-media.ts`.
- `src/components/media-browser-parts.tsx`
  - Reusable media list, folder tree, and video thumbnail UI.
- `src/lib/media-browser.ts`
  - Pure media tree, sort, and filter logic.
- `src/lib/media-processing.ts`
  - Background-task types, preset catalogs, and VR/video helper logic.
- `src/lib/format.ts`
  - Shared UI formatting helpers.
- `src/lib/tauri-media.ts`
  - Tauri command wrappers and event subscriptions.

## Backend

- `src-tauri/src/lib.rs`
  - Thin Tauri entrypoint and command registration.
- `src-tauri/src/models.rs`
  - Shared DTOs and timestamp utility.
- `src-tauri/src/media_fs.rs`
  - Media scanning, ZIP handling, and file/folder operations.
- `src-tauri/src/external_tools.rs`
  - Python runtime setup, background-removal script execution, and FFmpeg integration.
- `src-tauri/src/background.rs`
  - Background task queue, worker lifecycle, and event emission.

## Reuse Strategy

- To reuse frontend media logic in another app:
  - Start with `src/lib/media-browser.ts`, `src/lib/media-processing.ts`, and `src/lib/tauri-media.ts`.
- To reuse backend local-media features in another Tauri app:
  - Start with `models.rs`, `media_fs.rs`, `background.rs`, and `external_tools.rs`.
- To replace Tauri later:
  - Keep the pure frontend helpers and swap only `src/lib/tauri-media.ts`.
- To replace Python or FFmpeg later:
  - Keep command names stable and swap implementations inside `src-tauri/src/external_tools.rs`.
