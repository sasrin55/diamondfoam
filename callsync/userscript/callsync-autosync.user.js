// ==UserScript==
// @name         CallSync Auto-Sync
// @namespace    https://diamondfoam.com/callsync
// @version      1.2
// @description  Automatically syncs Intellicon call recordings to CallSync — no clicking needed
// @author       DiamondFoam
// @match        https://diamondgroup.contegris.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      diamondfoam-production.up.railway.app
// @connect      diamondgroup.contegris.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const API      = 'https://diamondfoam-production.up.railway.app/api';
  const COOLDOWN = 30 * 60 * 1000; // 30 minutes between auto-syncs

  let syncing  = false;
  let allCalls = [];
  let badge    = null;

  // ── GM_xmlhttpRequest wrappers ───────────────────────────────────────────────

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...opts,
        onload:  r => resolve(r),
        onerror: () => reject(new Error('Network error: ' + opts.url)),
      });
    });
  }

  async function apiJSON(path, method = 'GET', body = null) {
    const opts = {
      method,
      url: API + path,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.data = JSON.stringify(body);
    const r = await gmRequest(opts);
    const data = JSON.parse(r.responseText);
    if (r.status >= 400) throw new Error(data.error || 'API error ' + r.status);
    return data;
  }

  async function downloadBlob(url) {
    const r = await gmRequest({ method: 'GET', url, responseType: 'blob' });
    if (r.status < 200 || r.status >= 300) return null;
    return r.response; // Blob
  }

  async function uploadRecording(blob, interactionId) {
    const fd = new FormData();
    fd.append('audio', blob, interactionId + '.mp3');
    fd.append('interaction_id', interactionId);
    fd.append('defer', 'true');
    const r = await gmRequest({ method: 'POST', url: API + '/calls/recording', data: fd });
    return r.status < 400;
  }

  // ── Status badge ──────────────────────────────────────────────────────────────

  function showBadge(html, bg = '#1e293b') {
    if (!badge) {
      badge = document.createElement('div');
      badge.setAttribute('style', [
        'position:fixed;bottom:20px;right:20px',
        'background:#1e293b;color:#e2e8f0',
        'padding:10px 16px;border-radius:8px',
        'font-family:system-ui,sans-serif;font-size:12px;line-height:1.6',
        'z-index:2147483647;box-shadow:0 4px 20px rgba(0,0,0,.5)',
        'min-width:240px;border:1px solid #334155;transition:opacity .3s',
      ].join(';'));
      document.body.appendChild(badge);
    }
    badge.style.background = bg;
    badge.style.opacity = '1';
    badge.innerHTML = '<b style="color:#94a3b8;font-size:11px;letter-spacing:.05em">CALLSYNC</b><br>' + html;
  }

  function hideBadge(delay = 6000) {
    setTimeout(() => {
      if (!badge) return;
      badge.style.opacity = '0';
      setTimeout(() => { badge && badge.remove(); badge = null; }, 400);
    }, delay);
  }

  // ── Field parsers ────────────────────────────────────────────────────────────

  function parseDur(s) {
    if (!s || s === 'N/A') return 0;
    const p = s.split(':');
    if (p.length === 3) return +p[0] * 3600 + +p[1] * 60 + +p[2];
    if (p.length === 2) return +p[0] * 60 + +p[1];
    return parseInt(s) || 0;
  }

  function parseDt(s) {
    if (!s || s === 'N/A' || s === '0000-00-00 00:00:00') return new Date().toISOString();
    const d = new Date(s.replace(' ', 'T'));
    if (!isNaN(d)) return d.toISOString();
    const m = String(s).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return new Date(m[3], +m[2] - 1, +m[1]).toISOString();
    return new Date().toISOString();
  }

  function mapDir(s) {
    if (!s) return 'Inbound';
    const l = s.toLowerCase();
    if (l.includes('out')) return 'Outbound';
    if (l.includes('miss') || l.includes('abandon')) return 'Missed';
    return 'Inbound';
  }

  // ── Audio URL extraction ─────────────────────────────────────────────────────

  function isAudioUrl(s) {
    return s && typeof s === 'string'
      && (s.startsWith('http') || s.startsWith('/'))
      && s.length > 4
      && (/\.(mp3|wav|ogg|m4a|webm)/i.test(s) || /\/recording/i.test(s) || /\/audio/i.test(s) || /\/sounds/i.test(s))
      && !s.startsWith('data:')
      && !s.startsWith('blob:blob:');
  }

  function getAudioUrl(cell) {
    if (!cell) return '';

    // Direct audio element
    const ae = cell.querySelector('audio');
    if (ae) {
      const s = ae.src || ae.currentSrc || ae.getAttribute('src') || ae.getAttribute('data-src') || '';
      if (isAudioUrl(s)) return s;
    }
    const src2 = cell.querySelector('audio source');
    if (src2) {
      const s = src2.src || src2.getAttribute('src') || '';
      if (isAudioUrl(s)) return s;
    }

    // Link
    const a = cell.querySelector('a[href]');
    if (a && isAudioUrl(a.href)) return a.href;

    // Scan all descendants for audio URLs
    for (const el of cell.querySelectorAll('*')) {
      // Attributes
      for (const attr of el.attributes) {
        if (isAudioUrl(attr.value)) return attr.value;
      }
      // Event handlers
      const ev = el.getAttribute('onclick') || el.getAttribute('ng-click') || el.getAttribute('@click') || el.getAttribute('data-action') || '';
      if (ev) {
        const m = ev.match(/['"]([^'"]+(?:mp3|wav|ogg|m4a|record|audio)[^'"]*)['"]/i);
        if (m && isAudioUrl(m[1])) return m[1];
      }
      // Vue props
      try {
        if (el.__vue__) {
          for (const obj of [el.__vue__.$props, el.__vue__.$data, el.__vue__._props, el.__vue__._data]) {
            if (!obj) continue;
            for (const v of Object.values(obj)) {
              if (isAudioUrl(v)) return v;
              if (v && typeof v === 'object') {
                for (const v2 of Object.values(v)) { if (isAudioUrl(v2)) return v2; }
              }
            }
          }
        }
      } catch (_) {}
      // Inline HTML scan
      const inner = el.innerHTML || '';
      if (inner.length < 2000) {
        const m2 = inner.match(/(?:https?:\/\/|(?=[^'"<>\s]*\/))[^'"<>\s]*(?:mp3|wav|ogg|m4a|webm)/i);
        if (m2 && isAudioUrl(m2[0])) return m2[0];
      }
    }
    return '';
  }

  // ── Table scraping ───────────────────────────────────────────────────────────

  function getBiggestTable() {
    let tbl = null, max = 0;
    for (const t of document.querySelectorAll('table')) {
      const n = t.querySelectorAll('tbody tr').length;
      if (n > max) { max = n; tbl = t; }
    }
    return max > 0 ? tbl : null;
  }

  function scrapeTable() {
    const tbl = getBiggestTable();
    if (!tbl) return null;

    const cols = {};
    Array.from(tbl.querySelectorAll('thead th,thead td,tr:first-child th,tr:first-child td')).forEach((th, i) => {
      const h = th.textContent.trim().toLowerCase();
      if (h === 'date')           cols.date      = i;
      else if (h === 'interaction id') cols.id   = i;
      else if (h === 'did/dod')   cols.did       = i;
      else if (h === 'cli/dst')   cols.cli       = i;
      else if (h === 'direction') cols.direction = i;
      else if (h === 'queue')     cols.queue     = i;
      else if (h === "agent(s)")  cols.agent     = i;
      else if (h === 'duration')  cols.duration  = i;
      else if (h === 'audio')     cols.audio     = i;
    });

    const rows = Array.from(tbl.querySelectorAll('tbody tr'));
    const calls = rows.map((row, idx) => {
      const cells = row.querySelectorAll('td');
      const cv = k => {
        const v = cols[k] !== undefined && cells[cols[k]] ? cells[cols[k]].textContent.trim() : '';
        return v === 'N/A' ? '' : v;
      };
      const iid = cv('id') || [cv('date'), cv('cli') || cv('did'), cv('duration'), cv('agent')].filter(Boolean).join('|') || ('row_' + idx);
      const recUrl = cols.audio !== undefined ? getAudioUrl(cells[cols.audio]) : null;
      return {
        interactionId: iid,
        createdAt:     parseDt(cv('date')),
        did:           cv('did'),
        cli:           cv('cli'),
        direction:     mapDir(cv('direction')),
        agentName:     cv('agent') || null,
        queueName:     cv('queue') || null,
        duration:      parseDur(cv('duration')),
        recordingUrl:  recUrl || undefined,
      };
    }).filter(c => c.interactionId);

    return calls.length > 0 ? calls : null;
  }

  // ── Pagination ───────────────────────────────────────────────────────────────

  function getPageInfo() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walker.nextNode()) {
      const m = node.textContent.match(/(\d+)-(\d+)\s+of\s+(\d+)/);
      if (m) {
        const s = +m[1], e = +m[2], tot = +m[3], ps = e - s + 1;
        return { currentPage: Math.ceil(e / ps), totalPages: Math.ceil(tot / ps), total: tot };
      }
    }
    return null;
  }

  function isLastPage() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walker.nextNode()) {
      const m = node.textContent.match(/(\d+)-(\d+)\s+of\s+(\d+)/);
      if (m) return +m[2] >= +m[3];
    }
    return false;
  }

  function isEnabled(el) {
    return !el.disabled
      && el.getAttribute('aria-disabled') !== 'true'
      && !el.classList.contains('disabled');
  }

  function findNextBtn() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node, pageNode = null;
    while (node = walker.nextNode()) {
      if (/\d+-\d+\s+of\s+\d+/.test(node.textContent)) { pageNode = node; break; }
    }
    if (pageNode) {
      let cont = pageNode.parentElement;
      for (let d = 0; d < 6 && cont; d++, cont = cont.parentElement) {
        for (const b of cont.querySelectorAll('button,a,[role=button]')) {
          const t  = b.textContent.trim();
          const al = b.getAttribute('aria-label') || '';
          if ((t === '>' || t === '›' || t === '»' || /next/i.test(al)) && isEnabled(b)) return b;
        }
      }
    }
    for (const b of document.querySelectorAll('button,a,[role=button]')) {
      const t  = b.textContent.trim();
      const al = b.getAttribute('aria-label') || b.getAttribute('title') || '';
      if ((t === '>' || t === '›' || /\bnext\b/i.test(al)) && isEnabled(b)) return b;
    }
    return null;
  }

  function waitForPageChange(prevFirstId) {
    return new Promise(resolve => {
      let ticks = 0;
      const ck = setInterval(() => {
        ticks++;
        const pc = scrapeTable();
        const fi = pc && pc.length ? pc[0].interactionId : null;
        if (fi && fi !== prevFirstId) { clearInterval(ck); resolve(true); return; }
        if (ticks > 30) { clearInterval(ck); resolve(false); }
      }, 300);
    });
  }

  // ── Audio player priming ─────────────────────────────────────────────────────

  async function primeAudioPlayers() {
    const tbl = getBiggestTable();
    if (!tbl) return;

    const cells = [];
    tbl.querySelectorAll('tbody td').forEach(td => {
      if ((td.querySelector('audio') || td.querySelector('[class*=play],[class*=audio],[class*=record]')) && !getAudioUrl(td)) {
        cells.push(td);
      }
    });
    if (!cells.length) return;

    cells.forEach(td => {
      const ae = td.querySelector('audio');
      if (ae) { ae.muted = true; ae.volume = 0; }
    });
    cells.forEach(td => {
      const btn = td.querySelector('button') || td.querySelector('[class*=play]') || td.querySelector('i');
      if (btn) try { btn.click(); } catch (_) {}
    });
    await sleep(700);
    cells.forEach(td => {
      const ae = td.querySelector('audio');
      if (ae) try { ae.pause(); ae.currentTime = 0; } catch (_) {}
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Data collection ───────────────────────────────────────────────────────────

  async function collectPage() {
    await primeAudioPlayers();
    const pc = scrapeTable();
    if (!pc || !pc.length) return 0;
    const seen = new Set(allCalls.map(c => c.interactionId));
    const fresh = pc.filter(c => !seen.has(c.interactionId) && c.recordingUrl);
    if (!fresh.length) return 0;
    allCalls = allCalls.concat(fresh);
    return fresh.length;
  }

  async function collectAllPages() {
    for (let page = 1; page <= 100; page++) {
      const pi = getPageInfo();
      const totalPages = pi ? pi.totalPages : '?';
      showBadge(`Scanning page ${page} of ${totalPages} — <b>${allCalls.length}</b> calls collected`);

      const pc   = scrapeTable();
      const pf   = pc && pc.length ? pc[0].interactionId : null;
      await collectPage();

      if (isLastPage()) break;

      const nb = findNextBtn();
      if (!nb) break;
      nb.click();

      const changed = await waitForPageChange(pf);
      if (!changed) break;
    }
  }

  // ── Sync to CallSync ─────────────────────────────────────────────────────────

  async function runSync() {
    if (syncing) return;
    syncing  = true;
    allCalls = [];

    try {
      // Cooldown check
      const lastSync = await GM_getValue('lastSync', 0);
      const ago      = Date.now() - lastSync;
      if (ago < COOLDOWN) {
        const minsLeft = Math.ceil((COOLDOWN - ago) / 60000);
        showBadge(`✓ Already synced recently — next auto-sync in ${minsLeft}m<br><small style="color:#64748b">Refresh page to force re-sync</small>`);
        hideBadge(5000);
        syncing = false;
        return;
      }

      // Collect all pages
      showBadge('Starting auto-sync...');
      await collectAllPages();

      if (!allCalls.length) {
        showBadge('No calls with recordings found.');
        hideBadge(5000);
        syncing = false;
        return;
      }

      // Import call metadata
      showBadge(`Importing <b>${allCalls.length}</b> calls...`);
      const importRes = await apiJSON('/calls/import', 'POST', { calls: allCalls });

      // Check which calls still need recordings
      let pendingIds = new Set();
      try {
        const pending = await apiJSON('/calls/pending-recordings');
        if (Array.isArray(pending)) pending.forEach(p => pendingIds.add(String(p.interaction_id)));
      } catch (_) {}

      // Build recording upload list: new calls + existing calls missing recordings
      const toUpload = [];
      (importRes.newCalls || []).forEach(nc => {
        const raw = allCalls.find(c => String(c.interactionId) === nc.interactionId);
        if (raw) toUpload.push(raw);
      });
      allCalls.forEach(c => {
        const iid = String(c.interactionId || '');
        if (iid && pendingIds.has(iid) && !toUpload.find(r => String(r.interactionId) === iid)) {
          toUpload.push(c);
        }
      });

      // Upload recordings
      let uploaded = 0;
      for (let i = 0; i < toUpload.length; i++) {
        const call = toUpload[i];
        showBadge(`Uploading recordings <b>${i + 1}/${toUpload.length}</b>...`);
        try {
          if (call.recordingUrl) {
            const blob = await downloadBlob(call.recordingUrl);
            if (blob) {
              const ok = await uploadRecording(blob, String(call.interactionId));
              if (ok) uploaded++;
            }
          }
        } catch (_) {}
      }

      // Kick off AI processing
      if (uploaded > 0) {
        try { await apiJSON('/calls/reprocess-all', 'POST'); } catch (_) {}
      }

      // Done
      await GM_setValue('lastSync', Date.now());
      showBadge(
        `✓ Sync complete<br>` +
        `<span style="color:#94a3b8">${importRes.synced || 0} new &nbsp;·&nbsp; ${importRes.skipped || 0} existing &nbsp;·&nbsp; ${uploaded} recordings uploaded</span>`,
        '#0f2d1a'
      );
      hideBadge(8000);

    } catch (err) {
      showBadge(`✗ Sync failed: ${err.message}`, '#2d0f0f');
      hideBadge(8000);
      console.error('[CallSync]', err);
    } finally {
      syncing = false;
    }
  }

  // ── Page detection & auto-trigger ────────────────────────────────────────────

  function isCallsPage() {
    const url = window.location.href.toLowerCase();
    return url.includes('call_center') || url.includes('report/call')
      || url.includes('/interactions') || url.includes('/cdr')
      || url.includes('callhistory')   || url.includes('call_history')
      || url.includes('callreport');
  }

  function hasCallsTable() {
    for (const t of document.querySelectorAll('table')) {
      const headers = Array.from(t.querySelectorAll('thead th,thead td')).map(th => th.textContent.trim().toLowerCase());
      if (headers.includes('interaction id') || (headers.includes('agent(s)') && headers.includes('duration'))) {
        return true;
      }
    }
    return false;
  }

  // Watch for SPA navigation
  let triggered = false;
  function resetTrigger() { triggered = false; pollCount = 0; }

  const _push = history.pushState.bind(history);
  history.pushState = function (...a) { _push(...a); resetTrigger(); };
  window.addEventListener('popstate', resetTrigger);

  // Poll until calls table appears, then run sync
  let pollCount = 0;
  const poller = setInterval(() => {
    pollCount++;
    if (triggered || syncing) return;
    if (!isCallsPage() && !hasCallsTable()) return;
    const rows = scrapeTable();
    if (!rows || rows.length === 0) return; // table not ready yet
    triggered = true;
    clearInterval(poller);
    runSync();
  }, 500);

  // Give up after 60 seconds if no calls page detected
  setTimeout(() => clearInterval(poller), 60000);

})();
