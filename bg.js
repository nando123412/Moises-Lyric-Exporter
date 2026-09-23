/**
 * Moises Lyrics Exporter Pro - Service Worker (Background)
 */

console.log("🔧 [BG] Service worker loaded");

const LYRICS_CACHE = new Map(); // tabId -> { url, data, timestamp }
const REQUEST_QUEUE = new Map(); // tabId -> queue of pending requests

/**
 * Clean up when tab closes
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  console.log("🔧 [BG] Tab closed, cleaning up tabId:", tabId);
  LYRICS_CACHE.delete(tabId);
  REQUEST_QUEUE.delete(tabId);
});

/**
 * Main message handler
 */
console.log("🔧 [BG] Setting up message listener...");
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("🔧 [BG MESSAGE]", msg.type, "from tab", sender.tab?.id);
  
  if (msg.type === "fetchLyrics") {
    handleFetchLyrics(msg, sender)
      .then(result => {
        console.log("🔧 [BG RESPONSE] Fetch success:", { ok: result.ok, cached: result.fromCache, entries: result.json?.length });
        sendResponse(result);
      })
      .catch(err => {
        console.error("🔧 [BG ERROR] Fetch failed:", err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }
  
  if (msg.type === "clearCache") {
    console.log("🔧 [BG] Clearing cache for tab", sender.tab?.id);
    if (sender.tab?.id) LYRICS_CACHE.delete(sender.tab.id);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "showNotification") {
    console.log("🔧 [BG] Creating notification...");
    chrome.notifications.create("lyrics-found", {
      type: "basic",
      iconUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Ccircle cx='64' cy='64' r='64' fill='%234CAF50'/%3E%3Cpath d='M54 88L34 68l8-8 12 12 32-32 8 8' fill='white'/%3E%3C/svg%3E",
      title: msg.title || "✅ Lyrics File Found",
      message: msg.message || "lyrics.json has been detected",
      priority: 2
    });
    sendResponse({ ok: true });
    return true;
  }
});

/**
 * Handle lyrics fetch with queueing and caching
 */
async function handleFetchLyrics(msg, sender) {
  const tabId = sender.tab?.id || 0;
  const url = msg.url;
  
  console.log("🔧 [HANDLE FETCH] URL:", url ? url.substring(0, 100) : "empty");
  
  if (!url || typeof url !== "string") {
    console.error("🔧 [HANDLE FETCH] Invalid URL");
    return { ok: false, error: "Invalid URL" };
  }
  
  // Check cache first
  const cached = LYRICS_CACHE.get(tabId);
  if (cached && cached.url === url && Date.now() - cached.timestamp < 30000) {
    console.log("🔧 [HANDLE FETCH] Cache hit - returning cached data");
    return { ok: true, json: cached.data, fromCache: true };
  }
  
  console.log("🔧 [HANDLE FETCH] Not in cache, queuing request...");
  
  if (!REQUEST_QUEUE.has(tabId)) {
    REQUEST_QUEUE.set(tabId, []);
  }
  
  const queue = REQUEST_QUEUE.get(tabId);
  const promise = new Promise((resolve, reject) => {
    queue.push({ url, resolve, reject });
  });
  
  if (queue.length === 1) {
    console.log("🔧 [HANDLE FETCH] Starting queue processor...");
    processQueue(tabId);
  }
  
  try {
    const json = await promise;
    console.log("🔧 [HANDLE FETCH] Promise resolved, got", json.length, "entries");
    return { ok: true, json };
  } catch (err) {
    console.error("🔧 [HANDLE FETCH] Promise rejected:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Process request queue for a tab
 */
async function processQueue(tabId) {
  const queue = REQUEST_QUEUE.get(tabId) || [];
  console.log("🔧 [PROCESS QUEUE] Starting - queue size:", queue.length);
  
  while (queue.length > 0) {
    const { url, resolve, reject } = queue.shift();
    console.log("🔧 [PROCESS QUEUE] Processing request for URL:", url.substring(0, 80));
    
    try {
      const data = await fetchWithRetry(url, 3);
      console.log("🔧 [PROCESS QUEUE] Fetch successful, caching", data.length, "entries");
      
      LYRICS_CACHE.set(tabId, {
        url,
        data,
        timestamp: Date.now(),
      });
      
      resolve(data);
    } catch (err) {
      console.error("🔧 [PROCESS QUEUE] Fetch failed:", err.message);
      reject(err);
    }
  }
  
  console.log("🔧 [PROCESS QUEUE] Queue processing complete");
}

/**
 * Fetch with retry logic and proper headers
 */
async function fetchWithRetry(url, maxRetries = 3) {
  const LYRICS_PATTERN = /(?:api|d1)\.moises\.ai\/v3\/download\/.*\/operations\/LYRICS.*\/lyrics.*\.json/i;
  
  console.log("🔧 [FETCH RETRY] Starting fetch with", maxRetries, "retries");
  
  if (!LYRICS_PATTERN.test(url)) {
    console.error("🔧 [FETCH RETRY] URL doesn't match lyrics pattern:", url);
    throw new Error("Invalid lyrics URL pattern");
  }
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log("🔧 [FETCH RETRY] Attempt", attempt, "of", maxRetries);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "User-Agent": navigator.userAgent,
        },
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      console.log("🔧 [FETCH RETRY] Response received, status:", response.status);
      
      if (!response.ok) {
        const statusText = response.statusText || `HTTP ${response.status}`;
        if (response.status === 401) throw new Error("Unauthorized (401): Please log in to Moises");
        if (response.status === 403) throw new Error("Forbidden (403): Access denied");
        if (response.status === 404) throw new Error("Not Found (404): Lyrics not available");
        throw new Error(`${statusText}`);
      }
      
      const json = await response.json();
      console.log("🔧 [FETCH RETRY] JSON parsed, entries:", json.length);
      
      if (!Array.isArray(json)) {
        throw new Error("Invalid lyrics format: expected array");
      }
      
      if (json.length === 0) {
        throw new Error("Empty lyrics array");
      }
      
      // Validate both the old and the new JSON format
      const hasValidEntry = json.some(item => 
        item && (
          typeof item.text === "string" || 
          typeof item.word === "string" ||
          Array.isArray(item.words) ||
          Array.isArray(item.syllables)
        )
      );
      
      if (!hasValidEntry) {
        throw new Error("No valid lyrics entries found in response");
      }
      
      console.log("🔧 [FETCH RETRY] Validation passed, returning data");
      return json;
    } catch (err) {
      lastError = err;
      console.error("🔧 [FETCH RETRY] Attempt", attempt, "failed:", err.message);
      
      if (err.name === "AbortError") {
        lastError = new Error("Request timeout (10s)");
      }
      
      if (err.message.includes("Unauthorized") || 
          err.message.includes("Forbidden") ||
          err.message.includes("Invalid")) {
        throw err;
      }
      
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  
  throw lastError || new Error("Failed to fetch lyrics");
}