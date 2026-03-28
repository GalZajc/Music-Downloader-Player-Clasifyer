# Music Downloader + Player + Clasifyer

Windows-focused Electron app for:

- playing and classifying a local music library
- importing/exporting song classification CSV files
- generating filtered random permutations of songs
- downloading YouTube audio as MP3
- rebuilding playlist metadata from Google Takeout / YouTube exports
- managing unavailable songs and manually deleted downloads

This repository is intentionally cleaned for public sharing. Personal data such as cookies, local config, saved classifications, generated backup data, and personal playlist selections are excluded.

## Main Features

### 1. Local Music Player

- Prev / Play / Next controls
- timeline scrubbing
- optional `Auto Next`
- optional audio `Normalize`
- optional `Mono`
- quick open in system player
- quick open on YouTube for tracks that include a YouTube video ID in the filename

### 2. Song Classification

- configurable classification columns from [`classification_config.json`](./classification_config.json)
- current default columns:
  - `Category`
  - `Tier`
  - `Happyness`
  - `Version`
- import existing classification CSV
- export current classification CSV
- keyboard shortcut: `Enter` confirms the current song classification

### 3. Permutation Builder

- create a new song permutation from selected classification values
- optional playlist filter
- optional explicit song filter
- optional duration range filter
- import/export permutation filter configs

### 4. YouTube Downloader / Backup Tools

- download audio from YouTube and convert to MP3
- thumbnail download support
- Google Takeout playlist loading
- “Update Playlists Data” mode for metadata refresh without downloading audio
- unavailable video manager
- manually deleted songs manager
- cookie assistant for age-restricted videos
- startup `yt-dlp` update check

## How It Works

### Local Library Mode

1. Choose your music directory.
2. Optionally import an existing `song_classifications.csv`.
3. Optionally import a saved permutation config.
4. Start the app and classify songs one by one.
5. Export classifications whenever you want a snapshot.

The app analyzes song duration and peak volume on first run for new tracks and stores that in local config so later launches are faster.

### YouTube / Takeout Mode

1. Open `Download Music`.
2. Choose your Google Takeout playlists directory.
3. Load playlists.
4. Select playlists to process.
5. Choose:
   - `Start Download` to fetch audio + thumbnails
   - `Update Playlists Data` to refresh playlist metadata only
6. Use `Unavailable Songs` and `Songs I Deleted` managers when needed.

If a video is age-restricted, the app can use a `cookies.txt` file exported from a browser session that is logged into YouTube.

## Installation

### Option A: Automatic setup

Run:

```bat
setup_and_run.bat
```

This script is designed to install or verify:

- Node.js
- Python
- FFmpeg
- `yt-dlp`
- npm dependencies

### Option B: Manual setup

Requirements:

- Windows
- Node.js
- Python 3
- FFmpeg in PATH
- `yt-dlp` available through Python

Install:

```bat
npm install
python -m pip install -U yt-dlp
```

Run:

```bat
npm start
```

Or:

```bat
run.bat
```

## File / Folder Overview

Core app files:

- [`main.js`](./main.js): Electron main process, FFmpeg/yt-dlp integration, IPC
- [`preload.js`](./preload.js): safe renderer bridge
- [`app.js`](./app.js): main renderer logic for player, classification, filtering, UI state
- [`ytBackup.js`](./ytBackup.js): YouTube backup / restore / unavailable handling logic
- [`index.html`](./index.html): UI
- [`styles.css`](./styles.css): styling

Utility / setup files:

- [`run.bat`](./run.bat)
- [`setup_and_run.bat`](./setup_and_run.bat)
- [`migrate_config.js`](./migrate_config.js)
- [`fix_happyness_zero_spacing.js`](./fix_happyness_zero_spacing.js)
- [`prepare_app_icon.py`](./prepare_app_icon.py)

Assets:

- [`App Icon.ico`](./App%20Icon.ico)
- [`placeholder.png`](./placeholder.png)

## Public Repo Safety

This public repo excludes:

- `cookies.txt`
- `Config.json`
- `ffmpeg_path.txt`
- `node_modules`
- `Previous Versions`
- personal saved permutation configs
- personal playlist save folders
- actual `Song Classifications` CSV files
- generated `YouTube_Backup_Data` contents

Empty placeholder folders are kept so the expected structure remains visible.

## Notes

- The app is currently optimized for Windows workflows.
- Some local runtime files are intentionally not versioned.
- If icon caching on Windows shows an old icon, restarting the app or recreating the shortcut usually fixes it.
