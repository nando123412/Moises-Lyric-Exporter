/**
 * Moises Lyrics Exporter Pro - Popup Script v2.0
 * 
 * Handles:
 * - UI interactions and state management
 * - Settings persistence
 * - Export triggering and monitoring
 * - Error handling and user feedback
 */

console.log("🔧 [POPUP] Popup script loaded");

// ============================================
// DOM ELEMENTS
// ============================================

const els = {
  // Main
  exportBtn: document.getElementById('exportBtn'),
  status: document.getElementById('status'),
  
  // Format & Timing
  format: document.getElementById('format'),
  offset: document.getElementById('offset'),
  precision: document.getElementById('precision'),
  
  // Advanced
  instrumental: document.getElementById('instrumental'),
  gapSec: document.getElementById('gapSec'),
  titleCase: document.getElementById('titleCase'),
  confWarn: document.getElementById('confWarn'),
  
  // Manual URL
  manualUrl: document.getElementById('manualUrl'),
  clearUrlBtn: document.getElementById('clearUrlBtn'),
  
  // Stats
  statsSection: document.getElementById('statsSection'),
  statLines: document.getElementById('statLines'),
  statFormat: document.getElementById('statFormat'),
  statConfidence: document.getElementById('statConfidence'),
  statFilename: document.getElementById('statFilename'),
};

// ============================================
// STORAGE HELPERS
// ============================================

const storageGet = (keys) => new Promise(res => chrome.storage.local.get(keys, res));
const storageSet = (obj) => new Promise(res => chrome.storage.local.set(obj, res));
const tabsQuery = (q) => new Promise(res => chrome.tabs.query(q, res));

// ============================================
// INITIALIZATION
// ============================================

/**
 * Load saved settings on popup open
 */
(async () => {
  console.log("🔧 [POPUP INIT] Starting initialization...");
  try {
    const defaults = {
      format: 'lrc',
      mode: 'line',
      offset: '-200ms',
      precision: '3',
      instrumental: true,
      gapSec: 15,
      titleCase: true,
      confWarn: 0.7,
      manualUrl: '',
    };
    
    console.log("🔧 [POPUP INIT] Loading settings from storage...");
    const { exporterOptions } = await storageGet(['exporterOptions']);
    const opts = Object.assign({}, defaults, exporterOptions || {});
    console.log("🔧 [POPUP INIT] Settings loaded:", opts);

    // Restore UI state
    // LRC + word mode (set via the Moises UI) is shown as 'LRC Enhanced'
    els.format.value = (opts.format === 'lrc' && opts.mode === 'word') ? 'lrc-enhanced' : (opts.format || 'lrc');
    els.offset.value = opts.offset || '-200ms';
    els.precision.value = String(opts.precision || '3');
    els.instrumental.checked = opts.instrumental !== false;
    els.gapSec.value = String(opts.gapSec || 15);
    els.titleCase.checked = opts.titleCase !== false;
    els.confWarn.value = String(opts.confWarn || 0.7);
    els.manualUrl.value = opts.manualUrl || '';
    
    console.log("🔧 [POPUP INIT] UI elements restored");

    // Load and display previous stats if available
    displayStats();
    console.log("🔧 [POPUP INIT] Initialization complete");
  } catch (e) {
    console.warn('🔧 [POPUP INIT] Failed to load options:', e);
    setStatus('⚠️ Failed to load settings', 'warning');
  }
})();

// ============================================
// EVENT LISTENERS
// ============================================

/**
 * Export button handler
 */
els.exportBtn.addEventListener('click', async () => {
  await handleExport();
});

/**
 * Clear manual URL
 */
els.clearUrlBtn.addEventListener('click', async () => {
  els.manualUrl.value = '';
  await saveSettings();
  setStatus('Manual URL cleared', 'success');
});

/**
 * Save manual URL on input change or paste
 */
els.manualUrl.addEventListener('change', saveSettings);
els.manualUrl.addEventListener('input', () => {
  if (els.manualUrl.value.trim()) {
    setStatus('URL entered - Click Export to use it', 'info');
  }
});

/**
 * Auto-save settings on change
 */
[els.format, els.offset, els.precision, els.instrumental, els.gapSec, els.titleCase, els.confWarn].forEach(el => {
  el.addEventListener('change', saveSettings);
});

els.manualUrl.addEventListener('change', saveSettings);

// ============================================
// CORE FUNCTIONS
// ============================================

/**
 * Save current settings to storage
 */
async function saveSettings() {
  try {
    const { exporterOptions: prev } = await storageGet(['exporterOptions']);
    let mode = (prev && prev.mode === 'word') ? 'word' : 'line';
    if (els.format.value === 'lrc-enhanced') mode = 'word';
    else if (els.format.value === 'lrc') mode = 'line';
    const opts = {
      format: els.format.value,
      mode, // TTML behoudt de modus die in Moises is gekozen
      offset: (els.offset.value || '').trim(),
      precision: els.precision.value,
      instrumental: els.instrumental.checked,
      gapSec: Math.max(1, parseInt(els.gapSec.value || '15', 10)),
      titleCase: els.titleCase.checked,
      confWarn: Math.min(1, Math.max(0, parseFloat(els.confWarn.value || '0.7'))),
      manualUrl: (els.manualUrl.value || '').trim(),
    };
    
    await storageSet({ exporterOptions: opts });
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

/**
 * Main export handler
 */
async function handleExport() {
  console.log("🔧 [POPUP EXPORT] Export button clicked");
  try {
    // Save current settings FIRST - wait for confirmation
    console.log("🔧 [POPUP EXPORT] Saving settings...");
    await saveSettings();
    
    // Give storage time to write
    await new Promise(r => setTimeout(r, 100));
    
    // Validate we're on a Moises page
    console.log("🔧 [POPUP EXPORT] Querying active tab...");
    const [tab] = await tabsQuery({ active: true, currentWindow: true });
    
    if (!tab) {
      console.error("🔧 [POPUP EXPORT] No active tab found");
      setStatus('❌ No active tab found', 'error');
      return;
    }
    
    console.log("🔧 [POPUP EXPORT] Active tab URL:", tab.url);
    
    if (!/studio\.moises\.ai/.test(tab.url)) {
      console.error("🔧 [POPUP EXPORT] Not on moises.ai");
      setStatus('❌ Please open a song on studio.moises.ai first', 'error');
      return;
    }

    // Debug: Log current settings
    const { exporterOptions } = await storageGet(['exporterOptions']);
    console.log('🔧 [POPUP EXPORT] Current options being exported:', exporterOptions);

    // Show loading state
    setStatus('⏳ Exporting lyrics... (usually instant)', 'loading');
    els.exportBtn.disabled = true;
    els.exportBtn.textContent = '⏳ Processing...';

    // Set flag that export is in progress
    console.log("🔧 [POPUP EXPORT] Setting export in progress flag...");
    await storageSet({ exportInProgress: true, lastExportStats: null, lastExportError: null });

    // Signal content script to start export (content.js runs automatically but we need to trigger export)
    console.log("🔧 [POPUP EXPORT] Sending startExport message to content script...");
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'startExport' });
      console.log('🔧 [POPUP EXPORT] Content script acknowledged startExport');
    } catch (err) {
      console.error('🔧 [POPUP EXPORT] Failed to reach content script:', err?.message || err);
      await storageSet({ exportInProgress: false });
      setStatus('❌ Extension not connected to this tab. Refresh studio.moises.ai and try again.', 'error');
      return;
    }

    // Poll for results (reduced timeout - PerformanceObserver is fast now)
    console.log("🔧 [POPUP EXPORT] Starting 12s poll for results...");
    const startTime = Date.now();
    const maxWait = 12000; // 12 seconds (was 35)
    let lastError = null;
    let lastStats = null;
    let pollCount = 0;

    while (Date.now() - startTime < maxWait) {
      const { lastExportStats, lastExportError, exportInProgress } = await storageGet(['lastExportStats', 'lastExportError', 'exportInProgress']);
      pollCount++;
      
      if (pollCount % 20 === 1) {  // Log every 2 seconds (20 polls at 100ms)
        const elapsed = Date.now() - startTime;
        console.log(`🔧 [POPUP EXPORT] Poll #${pollCount} after ${elapsed}ms - stats:`, !!lastExportStats, "error:", !!lastExportError, "inProgress:", exportInProgress);
      }
      
      if (lastExportError) {
        lastError = lastExportError;
        console.log("🔧 [POPUP EXPORT] Got error:", lastError);
        break;
      }
      
      if (lastExportStats && !exportInProgress) {
        lastStats = lastExportStats;
        console.log("🔧 [POPUP EXPORT] Got stats:", lastStats);
        break;
      }

      // Check more frequently (every 100ms instead of 500ms)
      await new Promise(r => setTimeout(r, 100));
    }

    console.log("🔧 [POPUP EXPORT] Poll finished - stats:", !!lastStats, "error:", !!lastError, "polls:", pollCount);

    // Clear export in progress flag
    await storageSet({ exportInProgress: false });

    // Display results
    if (lastError) {
      console.error("🔧 [POPUP EXPORT] Displaying error:", lastError);
      setStatus(`❌ Error: ${lastError}`, 'error');
      els.statsSection.style.display = 'none';
    } else if (lastStats) {
      console.log("🔧 [POPUP EXPORT] Displaying success");
      displaySuccessMessage(lastStats);
      displayStats();
    } else {
      console.warn("🔧 [POPUP EXPORT] Timeout - no result after 12s");
      setStatus('⏳ Still processing... Try again in a moment', 'info');
    }

  } catch (err) {
    console.error('🔧 [POPUP EXPORT] Export threw error:', err);
    setStatus(`❌ ${err.message || 'Export failed'}`, 'error');
    await storageSet({ exportInProgress: false });
  } finally {
    els.exportBtn.disabled = false;
    els.exportBtn.textContent = '⬇️ Export Lyrics';
  }
}

/**
 * Display success message with stats
 */
function displaySuccessMessage(stats) {
  if (!stats) return;
  
  const lines = stats.lines || 0;
  const format = stats.format || 'LRC';
  const confidence = (stats.avgConfidence || 0).toFixed(2);
  const filename = stats.filename || 'lyrics';
  
  let message = `✓ Success!\n📄 ${filename}\n`;
  message += `📊 ${lines} lines • Avg confidence: ${confidence}`;
  
  if (stats.insertedInstrumentals) {
    message += `\n♪ Added ${stats.insertedInstrumentals} instrumental markers`;
  }
  
  if (stats.lowConfidenceCount > 0) {
    message += `\n⚠️ Low confidence tokens: ${stats.lowConfidenceCount}`;
  }

  setStatus(message, 'success');
}

/**
 * Display export statistics
 */
function displayStats() {
  storageGet(['lastExportStats']).then(({ lastExportStats }) => {
    if (!lastExportStats) {
      els.statsSection.style.display = 'none';
      return;
    }

    const stats = lastExportStats;
    els.statLines.textContent = String(stats.lines || '-');
    els.statFormat.textContent = formatDisplayName(stats.format || '-');
    els.statConfidence.textContent = `${(stats.avgConfidence || 0).toFixed(2)}`;
    els.statFilename.textContent = stats.filename || '-';
    
    els.statsSection.style.display = 'block';
  }).catch(e => console.warn('Failed to load stats:', e));
}

/**
 * Set status message with styling
 */
function setStatus(message, type = 'info') {
  const lines = message.split('\n');
  els.status.innerHTML = lines
    .map(line => `<p class="status-text ${type}">${escapeHtml(line)}</p>`)
    .join('');
}

/**
 * Format display names for export types
 */
function formatDisplayName(format) {
  const names = {
    'ttml': 'TTML',
    'lrc': 'LRC (Line)',
    'lrc-enhanced': 'LRC (Word)',
    'txt': 'Text',
    'srt': 'SRT',
    'json': 'JSON',
  };
  return names[format] || format;
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================
// PERIODIC STATUS CHECK
// ============================================

/**
 * Poll for export completion
 */
setInterval(async () => {
  if (els.exportBtn.disabled) {
    const { lastExportStats } = await storageGet(['lastExportStats']);
    if (lastExportStats) {
      // Auto-update stats display
      displayStats();
    }
  }
}, 1000);

// ============================================
// KEYBOARD SHORTCUTS
// ============================================

document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + Enter to export
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!els.exportBtn.disabled) {
      els.exportBtn.click();
    }
  }
  
  // Escape to clear status (optional)
  if (e.key === 'Escape') {
    setStatus('Ready to export. Click the button above to start.');
  }
});

// ============================================
// CONTEXT MENU SUPPORT (Optional)
// ============================================

/**
 * Listen for manual URL paste from context menu
 * This could be extended to support right-click paste of lyrics URLs
 */
document.addEventListener('paste', (e) => {
  const pastedText = (e.clipboardData || window.clipboardData).getData('text');
  
  if (/lyrics\.json/.test(pastedText) && /moises\.ai/.test(pastedText)) {
    // Auto-populate manual URL if a lyrics URL is pasted
    if (document.activeElement === els.manualUrl) {
      e.preventDefault();
      els.manualUrl.value = pastedText;
      saveSettings();
      setStatus('✓ Lyrics URL pasted successfully', 'success');
    }
  }
});
