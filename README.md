# Moises Lyrics Exporter 

A Chrome extension that adds a **Lyrics** tab to the export dialog in [Moises Studio](https://studio.moises.ai) and lets you export a song's synced lyrics as **TTML, LRC, SRT, TXT or JSON**, with line-by-line or word-by-word (and syllable) timing.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by Moises. It only reads lyrics that your own logged-in Moises session already loads in the browser.

---

## Features

- **Native-looking UI inside Moises.** A new **Lyrics** tab appears next to the existing tabs in Moises' export dialog, styled with Moises' own components.
- **Five export formats:** TTML, LRC, SRT, TXT and JSON (raw data).
- **Two timing modes:** *Line by line* and *Word by word*.
- **Syllable timing in TTML.** In word-by-word mode, words are split into per-syllable `<span>`s (Apple Music style) when Moises provides syllable data.
- **LRC Enhanced** (word-by-word LRC) when using LRC in word mode.
- **Instrumental markers** (`♪`) inserted in LRC files for long gaps between lines.
- **Time offset** (e.g. `-200ms` or `0.5s`) applied to every timestamp.
- **Configurable precision**, confidence threshold and instrumental gap threshold via the toolbar popup.
- **Nothing leaves your browser.** No external servers, no analytics.

---

## Installation

The extension is not (yet) on the Chrome Web Store, so you install it manually as an unpacked extension. Works in Chrome and other Chromium browsers (Edge, Brave, Opera, Vivaldi, ...).

1. **Download** this repository (green **Code** button → **Download ZIP**) and unzip it, or clone it:
   ```bash
   git clone <your-repo-url>
   ```
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Open (or refresh) [studio.moises.ai](https://studio.moises.ai). You're ready to go.

**Updating:** download the new version, replace the files in your folder, then click the **reload** icon on the extension's card in `chrome://extensions` and refresh Moises.

**Tip:** pin the extension via the puzzle-piece icon in the toolbar if you want quick access to the popup settings.

---

## Usage

### Exporting from inside Moises (recommended)

1. Open a song in Moises Studio and make sure its **lyrics have loaded** (open the lyrics panel).
2. Open Moises' **Export** dialog.
3. Click the new **Lyrics** tab.
4. Choose:
   - **File format**: TTML, LRC, SRT, TXT or JSON
   - **Timing mode**: *Line by line* or *Word by word* (only applies to TTML and LRC; dimmed for the other formats)
   - **Instrumental breaks**: on/off (adds `♪` markers to LRC files)
5. Click **Export Lyrics**. The file downloads as `<Song Title>.<ext>`.

Your choices are saved automatically and are shared with the toolbar popup.

Clicking any of Moises' own tabs closes the Lyrics view and brings back Moises' normal options and its own export button. The extension never modifies or triggers Moises' original controls.

### Exporting from the toolbar popup

Click the extension icon while on `studio.moises.ai`, adjust the settings, and press **Export Lyrics** (or `Ctrl/Cmd + Enter`).

---

## Formats

| Format | Extension | Notes |
| --- | --- | --- |
| **TTML** | `.ttml` | Apple-style TTML (`itunes:timing="Line"` or `"Word"`). In word mode, multi-syllable words are split into one `<span>` per syllable. |
| **LRC** | `.lrc` | Line-timed lyrics. In word mode this becomes **LRC Enhanced** with `<mm:ss.xxx>` tags per word. Supports `♪` instrumental markers. |
| **SRT** | `.srt` | Subtitle format, one cue per line. |
| **TXT** | `.txt` | Plain lyrics, one line per row, no timestamps. |
| **JSON** | `.json` | The raw lyrics data as received from Moises. |

<details>
<summary>Examples</summary>

**LRC (line by line)**
```
[00:04.840] Dat is onze stilo
```

**LRC Enhanced (word by word)**
```
[00:04.840] <00:04.840>Dat <00:05.120>is <00:05.360>onze <00:05.820>stilo
```

**TTML, word by word with syllables**
```xml
<p begin="0:01.040" end="0:02.930" ttm:agent="v1" itunes:key="L1">
  <span begin="0:01.040" end="0:01.180">Tran</span><span begin="0:01.180" end="0:01.530">qui</span><span begin="0:01.530" end="0:01.780">lo,</span>
  <span begin="0:01.780" end="0:01.920">tran</span><span begin="0:01.920" end="0:02.400">qui</span><span begin="0:02.400" end="0:02.930">lo,</span>
</p>
```
Spans that directly follow each other without whitespace form a single word; whitespace separates words.

</details>

---

## Settings (toolbar popup)

| Setting | Default | Description |
| --- | --- | --- |
| Format | LRC | Export format (TTML, LRC, LRC Enhanced, SRT, TXT, JSON). |
| Time offset | `-200ms` | Shifts all timestamps. Accepts `-200ms`, `+0.5s`, `1.2`, ... |
| Precision (decimals) | 3 | Decimals in LRC timestamps (`0.001s` or `0.01s`). |
| Instrumental gap threshold (sec) | 15 | Minimum gap between lines before a `♪` marker is inserted. |
| Confidence threshold | 0.7 | Words below this confidence are counted as "low confidence" in the export stats. |
| Instrumental breaks | on | Add `♪` markers to LRC files. |
| Title in Title Case | on | Convert the song title used as the filename to Title Case. |
| Manual lyrics JSON URL | empty | Optional fallback: paste a `lyrics.json` URL from `api.moises.ai` / `d1.moises.ai` if automatic detection fails. |

---

## How it works

1. `page-hook.js` is injected into the Moises page and observes the page's own `fetch`/XHR calls to `api.moises.ai` to capture the lyrics data.
2. `content.js` collects that data, adds the **Lyrics** tab to the export dialog, converts the lyrics to the selected format and triggers the download.
3. `bg.js` (service worker) fetches `lyrics.json` files when only a URL was detected, and shows a notification when lyrics are found.
4. `popup.html` / `popup.js` / `popup.css` provide the toolbar popup and share settings with the in-page UI through `chrome.storage.local`.

### Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save your export settings and the last export stats. |
| `activeTab`, `tabs` | Detect that the popup is used on a Moises tab and message the content script. |
| `scripting` | Declared for script injection support. |
| `notifications` | Show the "Lyrics File Found" notification. |
| Host access to `studio.moises.ai`, `studio1.moises.ai`, `api.moises.ai`, `d1.moises.ai` | Run on Moises Studio and fetch the lyrics file for the song you have open. |

### Privacy

Everything runs locally in your browser. Lyrics and settings are stored in `chrome.storage.local` on your machine, and the only network requests made are to Moises itself, using your existing session.

---

## Troubleshooting

**"Could not locate lyrics.json. Please ensure lyrics panel is open."**
Open the song's lyrics panel in Moises so the lyrics get loaded, wait a moment, then try again. Refreshing the page and reopening the song also helps. As a last resort, paste the `lyrics.json` URL into **Manual lyrics JSON URL** in the popup.

**The Lyrics tab doesn't appear in the export dialog.**
Reload the extension in `chrome://extensions` and refresh Moises. The tab is added by matching Moises' current export dialog layout, so a Moises UI update can break it. Please open an issue and include the dialog's HTML.

**"Extension not connected to this tab."**
Refresh `studio.moises.ai` after installing or reloading the extension.

**The export is offset from the audio.**
Adjust **Time offset** in the popup, for example `-200ms` or `+300ms`.

**Word-by-word is greyed out.**
Word timing only applies to TTML and LRC. Switch the file format to one of those.

---

## Known limitations

- The in-page UI depends on Moises' current DOM structure and CSS class names, so it may need updating after Moises releases UI changes.
- Word and syllable timing are only as good as the data Moises provides for the song.
- In LRC Enhanced output, words containing punctuation (such as a comma) can end up attached to the previous word.
- The confidence statistics currently read a `confidence` field, while Moises' data uses `score`, so the average shows as `1.00`.

---

## Project structure

```
manifest.json    Extension manifest (Manifest V3)
content.js       Content script: capture lyrics, in-page UI, export logic
page-hook.js     Page-context hook that observes Moises' network calls
bg.js            Background service worker (fetching, notifications)
popup.html/js/css  Toolbar popup and its styling
```

---

## Disclaimer

This is an independent, unofficial tool. You need your own Moises account, and it only accesses lyrics that Moises already shows you. Song lyrics may be protected by copyright, so use exported files for personal purposes or with the necessary rights. You are responsible for complying with Moises' terms of service.

## License

Copyright (c) 2026 nandoothjuuh. All rights reserved.
This code is provided for use only. No permission is granted to modify or distribute it without the author's written consent.
