/**
 * Moises Lyrics Exporter Pro - Content Script v2.2
 */

console.log("🔧 [CONTENT SCRIPT] Loading...");
console.log("🔧 [FRAME] URL:", location.href, "Top frame:", window.top === window);

(function() {
  console.log("🔧 [IIFE] Outer scope starting");
  
  const LYRICS_PATTERN = /(?:api|d1)\.moises\.ai\/v3\/download\/.*\/operations\/LYRICS.*\/lyrics.*\.json/i;
  console.log("🔧 [PATTERN] Regex pattern created:", LYRICS_PATTERN);

  const PAGE_HOOK_SOURCE = "moises-lyrics-exporter-page-hook";

  let lyricsFoundUrl = null;
  let latestLyricsJson = null;
  let latestGraphqlPayload = null;
  let notificationShown = false;
  let pageHookInjected = false;
  let pageHookReady = false;
  let exportButtonObserver = null;
  let exportButtonBusy = false;

  const DOWNLOAD_ICON_SVG = `
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <path d="M8 1.75V9.19" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M5.25 6.88L8 9.63L10.75 6.88" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M3 11.25V12.25C3 12.8023 3.44772 13.25 4 13.25H12C12.5523 13.25 13 12.8023 13 12.25V11.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;

  function isLyricEntry(item) {
    if (!item || typeof item !== "object") return false;
    return (
      typeof item.text === "string" ||
      typeof item.word === "string" ||
      Array.isArray(item.words) ||
      Array.isArray(item.syllables)
    );
  }

  function extractLyricsCandidate(value, depth = 0, visited = new Set()) {
    if (depth > 6 || value == null) return null;
    if (typeof value !== "object") return null;
    if (visited.has(value)) return null;
    visited.add(value);

    if (Array.isArray(value)) {
      if (value.length > 0 && value.every(isLyricEntry)) {
        return value;
      }
      for (const item of value) {
        const nested = extractLyricsCandidate(item, depth + 1, visited);
        if (nested) return nested;
      }
      return null;
    }

    if (isLyricEntry(value)) {
      return [value];
    }

    for (const key of Object.keys(value)) {
      const nested = extractLyricsCandidate(value[key], depth + 1, visited);
      if (nested) return nested;
    }

    return null;
  }

  function injectPageHook() {
    if (pageHookInjected) return;

    try {
      const target = document.documentElement || document.head || document.body;
      if (!target) {
        setTimeout(injectPageHook, 50);
        return;
      }

      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page-hook.js");
      script.async = false;
      script.onload = () => {
        pageHookReady = true;
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      target.appendChild(script);
      pageHookInjected = true;
    } catch (err) {
      console.error("🔧 [HOOK] Injection failed:", err.message);
    }
  }

  function handlePageHookMessage(event) {
    const data = event && event.data;
    if (!data || data.source !== PAGE_HOOK_SOURCE) return;

    if (data.channel === "bootstrap") {
      pageHookReady = true;
      return;
    }

    if (data.type !== "MOISES_NETWORK") return;
    latestGraphqlPayload = data;

    if (!data.url) return;

    if (LYRICS_PATTERN.test(data.url)) {
      lyricsFoundUrl = data.url;
      showLyricsNotification(data.url);
    }

    if (/api\.moises\.ai\/graphql/i.test(data.url)) {
      const extracted = extractLyricsCandidate(data.responseJson);
      if (extracted && extracted.length > 0) {
        latestLyricsJson = extracted;
        lyricsFoundUrl = data.url;
        showLyricsNotification(data.url);
        storageSet({
          capturedLyricsJson: extracted,
          capturedLyricsMeta: {
            url: data.url,
            status: data.status,
            method: data.method,
            timestamp: new Date().toISOString(),
            entries: extracted.length,
          },
        }).catch(() => {});
      }
    }
  }

  // Lenient check for edit buttons on lyric lines
  function isLyricEditButton(button) {
    if (!button || button.dataset.moisesExporterButton === "true") return false;
    
    // Make sure we only search inside the lyrics section
    const lyricsContainer = button.closest('[class*="lyric" i], [class*="Lyrics" i]');
    if (!lyricsContainer) return false;

    const text = (button.textContent || "").replace(/\s+/g, " ").trim();
    const aria = button.getAttribute("aria-label") || "";
    
    // Match English, Dutch or generic action buttons
    const isEditAction = /edit|bewerk|modify/i.test(text) || /edit|bewerk|modify/i.test(aria);
    const isIconOnly = (!text || text.length <= 2) && button.querySelector("svg");

    return isEditAction || isIconOnly;
  }

  function createExportButtonFrom(editButton) {
    const exportButton = editButton.cloneNode(true);
    exportButton.dataset.moisesExporterButton = "true";
    exportButton.setAttribute("aria-label", "Download lyrics");
    exportButton.title = "Download lyrics";
    exportButton.type = "button";
    exportButton.style.marginLeft = "6px";

    const labelSpan = [...exportButton.querySelectorAll("span")].find((span) => {
      const text = (span.textContent || "").replace(/\s+/g, " ").trim();
      return /edit|bewerk/i.test(text);
    });

    if (labelSpan) labelSpan.textContent = "Download";

    const iconSpan = exportButton.querySelector("span") || exportButton;
    if (iconSpan && iconSpan.querySelector("svg")) {
      iconSpan.querySelector("svg").outerHTML = DOWNLOAD_ICON_SVG;
    }

    exportButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (exportButtonBusy) return;
      exportButtonBusy = true;
      try {
        await run();
      } catch (err) {
        console.error("🔧 [EXPORT BUTTON] Export failed:", err?.message || err);
      } finally {
        exportButtonBusy = false;
      }
    });

    return exportButton;
  }

  function injectExportButtons() {
    // More flexible search for buttons in the lyrics panels
    const buttons = document.querySelectorAll('[class*="lyric" i] button, [class*="Lyrics" i] button');
    if (!buttons.length) return;

    for (const editButton of buttons) {
      if (!isLyricEditButton(editButton)) continue;

      const parentContainer = editButton.parentElement;
      if (!parentContainer) continue;

      const existing = parentContainer.querySelector('button[data-moises-exporter-button="true"]');
      if (existing) continue;

      const exportButton = createExportButtonFrom(editButton);
      editButton.insertAdjacentElement("afterend", exportButton);
    }
  }

  function startExportButtonObserver() {
    injectExportButtons();
    if (exportButtonObserver) return;
    const root = document.documentElement || document.body;
    if (!root) {
      setTimeout(startExportButtonObserver, 50);
      return;
    }
    exportButtonObserver = new MutationObserver(() => injectExportButtons());
    exportButtonObserver.observe(root, { childList: true, subtree: true });
  }

  function monitorNetworkRequests() {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType !== "resource" || !entry.name) continue;
          if (LYRICS_PATTERN.test(entry.name)) {
            if (!notificationShown) {
              lyricsFoundUrl = entry.name;
              notificationShown = true;
              showLyricsNotification(entry.name);
            }
          }
        }
      });
      observer.observe({ entryTypes: ["resource"] });
    } catch (e) {
      console.warn("PerformanceObserver setup failed:", e.message);
    }
  }

  function showLyricsNotification(url) {
    chrome.runtime.sendMessage({
      type: "showNotification",
      title: "✅ Lyrics File Found!",
      message: "Ready to export!",
      url: url
    }).catch(() => {});
  }

  injectPageHook();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectPageHook, { once: true });
  }
  window.addEventListener("message", handlePageHookMessage, false);
  monitorNetworkRequests();
  startExportButtonObserver();

function getFromPerformanceAPI() {
  try {
    const entries = performance.getEntriesByType("resource");
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry && entry.name && LYRICS_PATTERN.test(entry.name)) {
        return entry.name;
      }
    }
  } catch (e) {}
  return null;
}

async function waitForPerformanceURL(maxWait = 8000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    const url = getFromPerformanceAPI() || getFromDOM() || getFromStorage() || getFromWindow() || getFromScripts();
    if (url) return url;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

function getFromScripts() {
  try {
    for (const script of document.scripts) {
      const text = script.textContent || "";
      const match = text.match(LYRICS_PATTERN);
      if (match) return match[0];
    }
  } catch (e) {}
  return null;
}

function getFromDOM() {
  try {
    const allText = document.documentElement.innerHTML;
    const match = allText.match(LYRICS_PATTERN);
    if (match) return match[0];
  } catch (_) {}
  return null;
}

function getFromStorage() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const value = localStorage.getItem(localStorage.key(i));
      if (value && LYRICS_PATTERN.test(value)) {
        const match = value.match(LYRICS_PATTERN);
        if (match) return match[0];
      }
    }
  } catch (e) {}
  return null;
}

function getFromWindow() {
  try {
    const search = (obj, depth = 0, visited = new Set()) => {
      if (depth > 2 || !obj || typeof obj !== 'object' || visited.has(obj)) return null;
      visited.add(obj);
      try {
        const str = JSON.stringify(obj);
        if (str && LYRICS_PATTERN.test(str)) {
          const match = str.match(LYRICS_PATTERN);
          if (match) return match[0];
        }
      } catch (_) {}
      return null;
    };
    return search(window);
  } catch (e) {}
  return null;
}

function getFromInlineJSON() {
  try {
    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!text.length) continue;
      if (text.includes('"words"') || text.includes('"line_id"')) {
        const match = text.match(/\[\s*{[\s\S]*?}\s*\]/);
        if (match) {
          try { return JSON.parse(match[0]); } catch (_) {}
        }
      }
    }
  } catch (_) {}
  return null;
}

const storageGet = (keys) => new Promise(res => chrome.storage.local.get(keys, res));
const storageSet = (obj) => new Promise(res => chrome.storage.local.set(obj, res));

async function run() {
  console.log("🔧 [RUN] Export function starting...");
  try {
    const defaults = {
      mode: 'line',
      format: 'lrc',
      instrumental: true,
      gapSec: 15,
      confWarn: 0.7,
      titleCase: true,
      offset: '-200ms',
      precision: '3',
      manualUrl: '',
    };
    
    const { exporterOptions, capturedLyricsJson } = await storageGet(['exporterOptions', 'capturedLyricsJson']);
    const opts = Object.assign({}, defaults, exporterOptions || {});
    const decimals = opts.precision === '2' ? 2 : 3;

    const parseOffsetToSeconds = (raw) => {
      if (!raw) return 0;
      let s = String(raw).trim();
      if (!s) return 0;
      let sign = 1;
      if (s[0] === '+') s = s.slice(1);
      else if (s[0] === '-') { sign = -1; s = s.slice(1); }
      s = s.trim();
      if (!s) return 0;
      const msMatch = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*ms$/i);
      if (msMatch) return sign * (parseFloat(msMatch[1]) / 1000);
      const sMatch = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*s(ec)?$/i);
      if (sMatch) return sign * parseFloat(sMatch[1]);
      if (!isNaN(Number(s))) return sign * parseFloat(s);
      return 0;
    };

    const outputOffset = parseOffsetToSeconds(opts.offset || '');
    const noSpaceBefore = /[.,!?;:)\]\}\"']/;
    const smallWords = new Set(["de", "het", "een", "van", "en", "op", "aan", "te", "der", "den", "met", "voor", "naar", "bij", "uit", "om", "als", "maar", "of", "a", "an", "the", "and", "or", "in", "on", "to", "for", "by", "at", "from", "as"]);
    
    const toTitleCase = (s) => {
      const words = (s || "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase().split(" ");
      return words.map((w, i) => {
        if (i !== 0 && i !== words.length - 1 && smallWords.has(w)) return w;
        return w ? w[0].toUpperCase() + w.slice(1) : w;
      }).join(" ");
    };
    
    const sanitizeFilename = (s) => (s || "").replace(/[\u0000-\u001f\/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim() || "lyrics";

    const formatTs = (t, dec) => {
      const unit = dec === 3 ? 1000 : 100;
      let totalUnits = Math.round(Math.max(0, t) * unit);
      const m = Math.floor(totalUnits / (60 * unit));
      totalUnits -= m * 60 * unit;
      const s = Math.floor(totalUnits / unit);
      const frac = totalUnits - s * unit;
      return `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(frac).padStart(dec, "0")}]`;
    };

    const tagTs = (t, dec) => {
      const unit = dec === 3 ? 1000 : 100;
      let totalUnits = Math.round(Math.max(0, t) * unit);
      const m = Math.floor(totalUnits / (60 * unit));
      totalUnits -= m * 60 * unit;
      const s = Math.floor(totalUnits / unit);
      const frac = totalUnits - s * unit;
      return `<${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(frac).padStart(dec, "0")}>`;
    };

    const formatSrtTime = (seconds) => {
      const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
      const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
      const s = String(Math.floor(seconds % 60)).padStart(2, "0");
      const ms = String(Math.floor((seconds % 1) * 1000)).padStart(3, "0");
      return `${h}:${m}:${s},${ms}`;
    };

    const joinWordsSmart = (words) => {
      let out = "";
      for (const w of words) {
        const token = (w.text || "").trim();
        if (!token) continue;
        const prev = out.slice(-1);
        const punctBefore = /^[.,!?;:)\]\}\"']/.test(token);
        const punctAfter = /[({\["']$/.test(prev);
        if (!out) out = token;
        else if (punctBefore || punctAfter) out += token;
        else out += " " + token;
      }
      return out.trim();
    };

    const isMarker = (t) => /^<(SO[LP]|EOL|EUL)>$/i.test(t || "");

    const titleEl = document.querySelector('p[class^="styles_song__" i]') || 
                    document.querySelector('[data-testid="player-song-title"]') ||
                    document.querySelector('[class*="songTitle"]');
    let rawTitle = titleEl ? (titleEl.textContent || "").trim() : (document.title || "lyrics");
    // Strip "Moises Play" / "Moises Studio" (and a separator before it) from the title
    rawTitle = rawTitle
      .replace(/\s*[-–—|·•:]?\s*Moises\s*(Play|Studio)\b/gi, "")
      .replace(/[\s\-–—|·•:]+$/, "")
      .trim() || "lyrics";
    let songTitle = opts.titleCase ? toTitleCase(rawTitle) : rawTitle;
    songTitle = sanitizeFilename(songTitle);

    let lyricsUrl = null;
    let lyricsJson = Array.isArray(latestLyricsJson) && latestLyricsJson.length > 0
      ? latestLyricsJson
      : (Array.isArray(capturedLyricsJson) && capturedLyricsJson.length > 0 ? capturedLyricsJson : null);

    if (!lyricsJson && lyricsFoundUrl) lyricsUrl = lyricsFoundUrl;
    if (!lyricsJson && !lyricsUrl && opts.manualUrl && LYRICS_PATTERN.test(opts.manualUrl)) lyricsUrl = opts.manualUrl;
    
    if (!lyricsJson && !lyricsUrl) {
      lyricsUrl = getFromScripts() || getFromDOM() || getFromStorage() || await waitForPerformanceURL(8000) || getFromWindow();
    }

    if (!lyricsJson && lyricsUrl) {
      try {
        const res = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Fetch timeout")), 10000);
          chrome.runtime.sendMessage({ type: "fetchLyrics", url: lyricsUrl }, (response) => {
            clearTimeout(timeout);
            if (response && response.ok) resolve(response.json);
            else reject(new Error(response?.error || "Fetch failed"));
          });
        });
        lyricsJson = res;
      } catch (err) {
        console.warn("🔧 [FETCH] Fetch failed:", err.message);
      }
    }

    if (!lyricsJson) lyricsJson = getFromInlineJSON();

    if (!Array.isArray(lyricsJson) || lyricsJson.length === 0) {
      const errorMsg = "Could not locate lyrics.json. Please ensure lyrics panel is open.";
      await storageSet({ lastExportError: errorMsg });
      throw new Error(errorMsg);
    }

    let sortedLines = [];
    const isSegmentFormat = lyricsJson.some(item => item && (Array.isArray(item.words) || Array.isArray(item.syllables)));

    if (isSegmentFormat) {
      let lineIdx = 0;
      for (const segment of lyricsJson) {
        if (!segment) continue;
        const lineWords = [];
        const rawWords = Array.isArray(segment.words) ? segment.words : [];

        if (rawWords.length > 0) {
          for (const w of rawWords) {
            const txt = w.word || w.text || "";
            if (!txt || isMarker(txt)) continue;
            lineWords.push({
              text: txt,
              start: typeof w.start === "number" ? w.start : (segment.start || 0),
              end: typeof w.end === "number" ? w.end : (segment.end || 0),
              confidence: typeof w.confidence === "number" ? w.confidence : 1,
              line_id: lineIdx,
              syllables: Array.isArray(w.syllables)
                ? w.syllables
                    .map(s => ({
                      text: String((s && (s.syllable ?? s.text)) ?? ""),
                      start: typeof s?.start === "number" ? s.start : null,
                      end: typeof s?.end === "number" ? s.end : null,
                    }))
                    .filter(s => s.text !== "" && s.start !== null)
                : null
            });
          }
        } else if (typeof segment.text === "string" && segment.text.trim()) {
          lineWords.push({
            text: segment.text.trim(),
            start: typeof segment.start === "number" ? segment.start : 0,
            end: typeof segment.end === "number" ? segment.end : 0,
            confidence: typeof segment.confidence === "number" ? segment.confidence : 1,
            line_id: lineIdx
          });
        }

        if (lineWords.length > 0) {
          lineWords.sort((a, b) => a.start - b.start);
          sortedLines.push(lineWords);
          lineIdx++;
        }
      }
    } else {
      const linesMap = new Map();
      for (const w of lyricsJson) {
        if (!w) continue;
        const txt = w.text || w.word || "";
        if (!txt || isMarker(txt)) continue;
        const wordObj = {
          text: txt,
          start: typeof w.start === "number" ? w.start : 0,
          end: typeof w.end === "number" ? w.end : 0,
          confidence: typeof w.confidence === "number" ? parseFloat(w.confidence) : 1,
          line_id: w.line_id ?? w.lineId ?? 0
        };
        const lid = wordObj.line_id;
        if (!linesMap.has(lid)) linesMap.set(lid, []);
        linesMap.get(lid).push(wordObj);
      }

      sortedLines = [...linesMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, words]) => words.sort((a, b) => a.start - b.start))
        .filter(arr => arr.length > 0);
    }

    if (!sortedLines.length) {
      await storageSet({ lastExportError: "No lyric lines found after filtering" });
      throw new Error("No lyric lines found");
    }

    const confVals = [];
    for (const line of sortedLines) {
      for (const w of line) {
        if (Number.isFinite(w.confidence)) confVals.push(w.confidence);
      }
    }
    const avgConfidence = confVals.length ? (confVals.reduce((a, b) => a + b, 0) / confVals.length) : 1;
    const lowConfidenceCount = confVals.filter(c => c < opts.confWarn).length;

    const lineStart = (line) => (typeof line[0]?.start === "number" ? line[0].start : 0);
    const lineEnd = (line) => {
      let e = line[0]?.end ?? line[0]?.start ?? 0;
      for (const w of line) {
        if (typeof w.end === "number") e = Math.max(e, w.end);
      }
      return e;
    };

    let output = "";
    let insertedInstrumentals = 0;
    const format = opts.format || 'lrc';

    if (format === 'lrc' || format === 'lrc-enhanced') {
      output += `[ti:${songTitle}]\n[re:Moises Lyrics Exporter Pro]\n[ve:2.0]\n[co:avg_confidence=${avgConfidence.toFixed(3)}; low_confidence_count=${lowConfidenceCount}]\n\n`;
      const isWordMode = format === 'lrc-enhanced' || opts.mode === 'word';
      let prevEnd = 0;

      for (let i = 0; i < sortedLines.length; i++) {
        const words = sortedLines[i];
        const ts = lineStart(words);
        const end = lineEnd(words);

        if (opts.instrumental && ((i === 0 && ts > opts.gapSec) || (i > 0 && ts - prevEnd > opts.gapSec))) {
          output += `${formatTs((i === 0 ? 0 : prevEnd) + outputOffset, decimals)} ♪\n`;
          insertedInstrumentals++;
        }

        if (!isWordMode) {
          const text = joinWordsSmart(words);
          if (text) output += `${formatTs(ts + outputOffset, decimals)} ${text}\n`;
        } else {
          let lineOut = "";
          for (const w of words) {
            const token = (w.text || "").trim();
            if (!token) continue;
            const piece = `${tagTs(w.start + outputOffset, decimals)}${token}`;
            if (!lineOut) lineOut = piece;
            else if (noSpaceBefore.test(token)) lineOut += piece;
            else lineOut += " " + piece;
          }
          if (lineOut) output += `${formatTs(ts + outputOffset, decimals)} ${lineOut}\n`;
        }
        prevEnd = end;
      }
    } else if (format === 'ttml') {
      const isWordMode = opts.mode === 'word';
      const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const ttmlTime = (t) => {
        const ms = Math.round(Math.max(0, t) * 1000);
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return `${m}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
      };
      const ttmlNoSpaceBefore = /^[.,!?;:)\]\}"']/;
      const firstStart = lineStart(sortedLines[0]) + outputOffset;
      const lastEnd = sortedLines.reduce((max, l) => Math.max(max, lineEnd(l)), 0) + outputOffset;

      let body = "";
      sortedLines.forEach((words, i) => {
        const s = lineStart(words) + outputOffset;
        const e = Math.max(lineEnd(words), lineStart(words)) + outputOffset;
        let inner = "";
        if (isWordMode) {
          for (const w of words) {
            const token = (w.text || "").trim();
            if (!token) continue;
            const sep = inner && !ttmlNoSpaceBefore.test(token) ? " " : "";
            const syl = Array.isArray(w.syllables) ? w.syllables : [];
            const joined = syl.map(s => s.text).join("");
            let spans = "";
            if (syl.length > 1 && joined === token) {
              // Syllables directly after each other (no space) => together form one word
              syl.forEach((s, k) => {
                const ss = s.start + outputOffset;
                const fallbackEnd = syl[k + 1] ? syl[k + 1].start : (typeof w.end === "number" ? w.end : s.start);
                const se = Math.max(typeof s.end === "number" ? s.end : fallbackEnd, s.start) + outputOffset;
                spans += `<span begin="${ttmlTime(ss)}" end="${ttmlTime(se)}">${xmlEsc(s.text)}</span>`;
              });
            } else {
              const ws = w.start + outputOffset;
              const we = Math.max(typeof w.end === "number" ? w.end : w.start, w.start) + outputOffset;
              spans = `<span begin="${ttmlTime(ws)}" end="${ttmlTime(we)}">${xmlEsc(token)}</span>`;
            }
            inner += sep + spans;
          }
        } else {
          inner = xmlEsc(joinWordsSmart(words));
        }
        if (inner) {
          body += `      <p begin="${ttmlTime(s)}" end="${ttmlTime(e)}" ttm:agent="v1" itunes:key="L${i + 1}">${inner}</p>\n`;
        }
      });

      output = `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="${isWordMode ? "Word" : "Line"}">\n` +
        `  <head>\n    <metadata>\n      <ttm:agent type="person" xml:id="v1"/>\n    </metadata>\n  </head>\n` +
        `  <body dur="${ttmlTime(lastEnd)}">\n    <div begin="${ttmlTime(firstStart)}" end="${ttmlTime(lastEnd)}">\n${body}    </div>\n  </body>\n</tt>\n`;
    } else if (format === 'txt') {
      output = sortedLines.map(words => joinWordsSmart(words)).filter(t => t).join("\n");
    } else if (format === 'json') {
      output = JSON.stringify(lyricsJson, null, 2);
    } else if (format === 'srt') {
      for (let i = 0; i < sortedLines.length; i++) {
        const words = sortedLines[i];
        const ts = lineStart(words) + outputOffset;
        const end = lineEnd(words) + outputOffset;
        const text = joinWordsSmart(words);
        if (text) {
          output += `${i + 1}\n${formatSrtTime(ts)} --> ${formatSrtTime(end)}\n${text}\n\n`;
        }
      }
    }

    const ext = format === 'json' ? 'json' : (format.startsWith('lrc') ? 'lrc' : format);
    const mimeType = format === 'json' ? 'application/json' : (format === 'ttml' ? 'application/ttml+xml' : 'text/plain');
    const blob = new Blob([output], { type: mimeType });
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = dlUrl;
    a.download = `${songTitle}.${ext}`;
    a.style.display = 'none';
    document.body.appendChild(a);

    setTimeout(() => a.click(), 100);
    setTimeout(() => {
      if (a.parentNode) document.body.removeChild(a);
      URL.revokeObjectURL(dlUrl);
    }, 500);

    const stats = {
      filename: `${songTitle}.${ext}`,
      lines: sortedLines.length,
      format,
      mode: opts.mode,
      avgConfidence: parseFloat(avgConfidence.toFixed(3)),
      lowConfidenceCount,
      confWarn: opts.confWarn,
      insertedInstrumentals,
      offsetApplied: opts.offset || "0",
      precision: String(decimals),
      timestamp: new Date().toISOString(),
      totalWords: lyricsJson.length,
    };

    await storageSet({ lastExportStats: stats, lastExportError: null });

  } catch (err) {
    console.error("🔧 [RUN] EXPORT FAILED:", err);
    await storageSet({
      lastExportError: err.message || "Unknown error occurred",
      lastExportStats: null,
    });
    throw err;
  }
}

// ============================================================
// MOISES EXPORT DIALOG: "Lyrics" tab + own settings
// ============================================================
// Adds an extra "Lyrics" tab to Moises' own export dialog.
// While that tab is active, the original options + Moises' own export button
// are hidden (CSS only, Moises' own DOM/handlers stay untouched)
// and we show our own options and our own "Export Lyrics" button.

const MLE_XPATH_CONTENT = '/html/body/div[7]/div/div/div';
const MLE_XPATH_PANEL = '/html/body/div[7]/div/div/div/div';

const MLE_FORMATS = [
  { value: 'ttml', label: 'TTML' },
  { value: 'lrc', label: 'LRC' },
  { value: 'srt', label: 'SRT' },
  { value: 'txt', label: 'TXT' },
  { value: 'json', label: 'JSON' },
];
const MLE_MODES = [
  { value: 'line', label: 'Line by line' },
  { value: 'word', label: 'Word by word' },
];
const MLE_WORD_FORMATS = new Set(['ttml', 'lrc']);

const MLE_EXPORT_BUTTON_HTML =
  '<button type="button" data-accent-color="cyan" data-mle-export="" class="rt-reset rt-BaseButton rt-r-size-3 rt-variant-solid rt-Button _exportButton_xn3k9_23 _button_cs6cf_1 _cyan_cs6cf_82 _size3_cs6cf_19 _solid_cs6cf_28 _hasRightSlot_cs6cf_311">' +
  '<span class="_label_cs6cf_315">Export Lyrics</span><span class="_rightSlot_cs6cf_319"></span></button>';

const mleState = { format: 'lrc', mode: 'line', instrumental: true };
let mleUi = null;
let mleActive = false;
let mleBusy = false;
let mlePendingSave = Promise.resolve();

function mleEnsureStyle() {
  if (document.getElementById('mle-style')) return;
  const style = document.createElement('style');
  style.id = 'mle-style';
  style.textContent = `
    [data-mle-active="true"] > *:not([data-mle-keep]) { display: none !important; }
    :not([data-mle-active="true"]) > [data-mle-section] { display: none !important; }
    [data-mle-content-active="true"] > button:not([data-mle-export]) { display: none !important; }
    :not([data-mle-content-active="true"]) > [data-mle-export] { display: none !important; }
    [data-mle-disabled="true"] { opacity: .45; pointer-events: none; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function mleFromStored(o) {
  o = o || {};
  let format = o.format || 'lrc';
  let mode = o.mode === 'word' ? 'word' : 'line';
  if (format === 'lrc-enhanced') { format = 'lrc'; mode = 'word'; }
  if (!MLE_FORMATS.some(f => f.value === format)) format = 'lrc';
  return { format, mode, instrumental: o.instrumental !== false };
}

async function mleLoad() {
  try {
    const { exporterOptions } = await storageGet(['exporterOptions']);
    Object.assign(mleState, mleFromStored(exporterOptions));
  } catch (_) {}
}

function mlePersist() {
  mlePendingSave = (async () => {
    try {
      const { exporterOptions } = await storageGet(['exporterOptions']);
      const next = Object.assign({}, exporterOptions || {}, {
        format: mleState.format,
        mode: mleState.mode,
        instrumental: mleState.instrumental,
      });
      await storageSet({ exporterOptions: next });
    } catch (err) {
      console.warn('🔧 [MLE] Saving failed:', err?.message || err);
    }
  })();
  return mlePendingSave;
}

function mleXPath(path) {
  try {
    return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  } catch (_) {
    return null;
  }
}

function mleHtml(str) {
  const t = document.createElement('template');
  t.innerHTML = str.trim();
  return t.content.firstElementChild;
}

function mleSegItem(label, inactiveLabel) {
  return '<button type="button" data-state="off" role="radio" aria-checked="false" class="rt-reset rt-SegmentedControlItem customSegmentedControlItem" tabindex="-1" data-radix-collection-item="">' +
    '<span class="rt-SegmentedControlItemSeparator"></span>' +
    '<span class="rt-SegmentedControlItemLabel"><span class="rt-SegmentedControlItemLabelActive">' + label + '</span>' +
    '<span class="rt-SegmentedControlItemLabelInactive" aria-hidden="true">' + (inactiveLabel || label) + '</span></span></button>';
}

function mleSegRoot(items) {
  return '<div role="group" dir="ltr" data-radius="medium" class="rt-SegmentedControlRoot rt-r-size-2 rt-variant-surface customSegmentedControl w-full" tabindex="0" style="outline: none;">' +
    items.map(i => mleSegItem(i.label, i.inactiveLabel)).join('') +
    '<div class="rt-SegmentedControlIndicator"></div></div>';
}

function mleResolve() {
  const valid = (content, panel) =>
    content && panel &&
    panel.parentElement === content &&
    [...content.children].some(el => el.tagName === 'BUTTON') &&
    panel.children[0] &&
    panel.children[0].querySelector('.rt-SegmentedControlRoot');

  let content = mleXPath(MLE_XPATH_CONTENT);
  let panel = mleXPath(MLE_XPATH_PANEL);

  if (!valid(content, panel)) {
    // Fallback: look up via the export button (class contains "_exportButton_")
    const btn = document.querySelector('button[class*="_exportButton_"]:not([data-mle-export])');
    if (!btn) return null;
    content = btn.parentElement;
    panel = content && [...content.children].find(el =>
      el.tagName === 'DIV' && el.children[0] && el.children[0].querySelector('.rt-SegmentedControlRoot'));
    if (!valid(content, panel)) return null;
  }

  const tabsSection = panel.children[0];
  const tabsRoot = tabsSection.querySelector('.rt-SegmentedControlRoot');
  if (tabsRoot.querySelectorAll(':scope > button:not([data-mle-tab])').length < 2) return null;
  return { content, panel, tabsSection, tabsRoot };
}

// Radix Themes moves the indicator via CSS. With our extra items that can
// go wrong; only then do we correct the position inline.
function mleSyncIndicator(root) {
  clearTimeout(root._mleIndTimer);
  root._mleIndTimer = setTimeout(() => {
    const ind = root.querySelector(':scope > .rt-SegmentedControlIndicator');
    const on = root.querySelector(':scope > [data-state="on"]');
    if (!ind || !on) return;
    const b = on.getBoundingClientRect();
    const i = ind.getBoundingClientRect();
    if (!b.width) return;
    if (Math.abs(b.left - i.left) > 2 || Math.abs(b.width - i.width) > 2) {
      const r = root.getBoundingClientRect();
      ind.style.transition = 'left .2s ease, width .2s ease';
      ind.style.transform = 'none';
      ind.style.left = (b.left - r.left - root.clientLeft) + 'px';
      ind.style.width = b.width + 'px';
    }
  }, 320);
}

function mleSetSeg(root, idx) {
  [...root.querySelectorAll(':scope > button')].forEach((b, i) => {
    const on = i === idx;
    b.dataset.state = on ? 'on' : 'off';
    b.setAttribute('aria-checked', String(on));
  });
  mleSyncIndicator(root);
}

function mleWireSeg(root, items, onSelect) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button');
    if (!btn || !root.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = [...root.querySelectorAll(':scope > button')].indexOf(btn);
    if (idx >= 0) onSelect(items[idx].value);
  });
}

function mleSetActive(on) {
  mleActive = on;
  if (!mleUi) return;
  const { content, panel, tabsRoot, tab, formatRoot, modeRoot } = mleUi;
  panel.setAttribute('data-mle-active', String(on));
  content.setAttribute('data-mle-content-active', String(on));
  tab.dataset.state = on ? 'on' : 'off';
  tab.setAttribute('aria-checked', String(on));
  if (on) {
    tabsRoot.querySelectorAll(':scope > button:not([data-mle-tab])').forEach(b => {
      b.dataset.state = 'off';
      b.setAttribute('aria-checked', 'false');
    });
    mleSyncIndicator(formatRoot);
    mleSyncIndicator(modeRoot);
  }
  mleSyncIndicator(tabsRoot);
}

function mleRefresh() {
  if (!mleUi || !mleUi.formatRoot.isConnected) return;
  const { formatRoot, modeRoot, timingSection, switchBtn } = mleUi;
  mleSetSeg(formatRoot, Math.max(0, MLE_FORMATS.findIndex(f => f.value === mleState.format)));
  mleSetSeg(modeRoot, Math.max(0, MLE_MODES.findIndex(m => m.value === mleState.mode)));
  timingSection.setAttribute('data-mle-disabled', String(!MLE_WORD_FORMATS.has(mleState.format)));
  const s = mleState.instrumental ? 'checked' : 'unchecked';
  switchBtn.setAttribute('aria-checked', String(mleState.instrumental));
  switchBtn.dataset.state = s;
  const thumb = switchBtn.querySelector('.rt-SwitchThumb');
  if (thumb) thumb.dataset.state = s;
}

function mleInject() {
  const ctx = mleResolve();
  if (!ctx) return;
  const { content, panel, tabsSection, tabsRoot } = ctx;

  const complete =
    panel.dataset.mleReady === '1' &&
    panel.querySelectorAll(':scope > [data-mle-section]').length === 3 &&
    tabsRoot.querySelector(':scope > [data-mle-tab]') &&
    content.querySelector(':scope > [data-mle-export]');
  if (complete) return;

  if (panel.dataset.mleReady !== '1') mleActive = false; // new dialog => default tab
  panel.querySelectorAll(':scope > [data-mle-section]').forEach(n => n.remove());
  tabsRoot.querySelectorAll(':scope > [data-mle-tab]').forEach(n => n.remove());
  content.querySelectorAll(':scope > [data-mle-export]').forEach(n => n.remove());

  // 1) "Lyrics" tab button (after the last existing button, before the indicator)
  const tab = mleHtml(mleSegItem('Lyrics'));
  tab.setAttribute('data-mle-tab', 'lyrics');
  const nativeBtns = [...tabsRoot.querySelectorAll(':scope > button:not([data-mle-tab])')];
  nativeBtns[nativeBtns.length - 1].after(tab);
  tabsSection.setAttribute('data-mle-keep', '');

  // 2) File format choice (TTML / LRC / SRT / TXT / JSON)
  const formatSection = mleHtml(
    '<div data-mle-section="format" data-mle-keep="" style="display:flex;flex-direction:column;gap:8px;">' +
    '<span class="rt-Text rt-r-size-2">File format</span><div></div></div>');
  const formatRoot = mleHtml(mleSegRoot(MLE_FORMATS));
  formatSection.querySelector(':scope > div').appendChild(formatRoot);

  // 3) Timing mode (title + Line/Word)
  const timingSection = mleHtml(
    '<div data-mle-section="timing" data-mle-keep="" style="display:flex;flex-direction:column;gap:8px;">' +
    '<span class="rt-Text rt-r-size-2">Timing mode</span><div></div></div>');
  const modeRoot = mleHtml(mleSegRoot(MLE_MODES));
  timingSection.querySelector(':scope > div').appendChild(modeRoot);

  // 4) Instrumental breaks (text + switch)
  const toggleSection = mleHtml(
    '<div data-mle-section="toggles" data-mle-keep="">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
    '<span class="rt-Text rt-r-size-2">Instrumental breaks</span>' +
    '<button type="button" role="switch" aria-checked="false" data-state="unchecked" value="on" class="rt-reset rt-SwitchRoot rt-r-size-2 rt-variant-surface">' +
    '<span data-state="unchecked" class="rt-SwitchThumb"></span></button></div></div>');
  const switchBtn = toggleSection.querySelector('button[role="switch"]');

  tabsSection.after(formatSection, timingSection, toggleSection);

  // 5) Own export button (separate from Moises' button)
  const exportBtn = mleHtml(MLE_EXPORT_BUTTON_HTML);
  const slot = exportBtn.querySelector('span:nth-child(2)');
  if (slot) slot.innerHTML = DOWNLOAD_ICON_SVG;
  const nativeExport = content.querySelector(':scope > button:not([data-mle-export])');
  if (nativeExport) nativeExport.after(exportBtn); else content.appendChild(exportBtn);

  mleUi = { content, panel, tabsRoot, tab, formatRoot, modeRoot, timingSection, switchBtn };
  panel.dataset.mleReady = '1';

  // --- events ---
  tab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    mleSetActive(true);
  });

  // If the user clicks one of Moises' own tabs: close our view
  tabsRoot.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button');
    if (!btn || btn.hasAttribute('data-mle-tab') || !tabsRoot.contains(btn)) return;
    const wasActive = mleActive;
    if (wasActive) mleSetActive(false);
    const restore = () => {
      if (wasActive) {
        tabsRoot.querySelectorAll(':scope > button:not([data-mle-tab])').forEach(b => {
          const on = b === btn;
          b.dataset.state = on ? 'on' : 'off';
          b.setAttribute('aria-checked', String(on));
        });
      }
      mleSyncIndicator(tabsRoot);
    };
    setTimeout(restore, 0);
    setTimeout(restore, 80);
  }, true);

  mleWireSeg(formatRoot, MLE_FORMATS, (value) => {
    mleState.format = value;
    mlePersist();
    mleRefresh();
  });
  mleWireSeg(modeRoot, MLE_MODES, (value) => {
    mleState.mode = value;
    mlePersist();
    mleRefresh();
  });
  switchBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    mleState.instrumental = !mleState.instrumental;
    mlePersist();
    mleRefresh();
  });

  exportBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (mleBusy) return;
    mleBusy = true;
    const label = exportBtn.querySelector('span:first-child');
    const flash = (text) => {
      if (label) label.textContent = text;
      setTimeout(() => { if (label) label.textContent = 'Export Lyrics'; }, 2000);
    };
    exportBtn.disabled = true;
    if (label) label.textContent = 'Working...';
    try {
      await mlePendingSave;
      await run();
      flash('Exported ✓');
    } catch (err) {
      console.error('🔧 [MLE] Export failed:', err?.message || err);
      flash('Failed (see console)');
    } finally {
      exportBtn.disabled = false;
      mleBusy = false;
    }
  });

  mleRefresh();
  mleSetActive(mleActive);
}

function startMoisesDialogUi() {
  mleEnsureStyle();
  mleLoad().then(mleRefresh);

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.exporterOptions) {
        Object.assign(mleState, mleFromStored(changes.exporterOptions.newValue));
        mleRefresh();
      }
    });
  } catch (_) {}

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try { mleInject(); } catch (err) { console.warn('🔧 [MLE] Inject error:', err?.message || err); }
    });
  };
  const root = document.documentElement;
  if (!root) { setTimeout(startMoisesDialogUi, 50); return; }
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
  schedule();
}

startMoisesDialogUi();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startExport') {
    run().then(() => sendResponse({ success: true }))
       .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

})();
