// Results history: localStorage persistence + tagging + CSV export + comparison diff.

import { fmtMbps, fmtMs, fmtStamp, fmtDateTime, speedUnitLabel } from './format.js';

const KEY = 'speedundo.history';
const MAX_ENTRIES = 50;

export const AVAILABLE_TAGS = [
  'Wi-Fi 5G',
  'Wi-Fi 2.4G',
  'Ethernet',
  'Cellular 5G',
  'VPN On',
  'VPN Off',
];

export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

export function saveResult(result, tag = null) {
  const entries = loadHistory();
  entries.unshift({
    ts: result.ts,
    ping: result.ping,
    jitter: result.jitter,
    down: result.down,
    up: result.up,
    loss: result.loss ?? null,
    loadedRtt: result.loadedRtt,
    colo: result.meta?.colo || null,
    isp: result.geo?.isp || null,
    city: result.geo?.city || null,
    region: result.geo?.region || null,
    postal: result.geo?.postal || null,
    server: result.server,
    tag: tag || result.tag || null,
  });
  const trimmed = entries.slice(0, MAX_ENTRIES);
  try { localStorage.setItem(KEY, JSON.stringify(trimmed)); } catch (_) { /* full */ }
  return trimmed;
}

export function updateEntryTag(ts, tag) {
  const entries = loadHistory();
  const target = entries.find((e) => e.ts === ts);
  if (target) {
    target.tag = tag;
    try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch (_) {}
  }
  return entries;
}

export function clearHistory() {
  try { localStorage.removeItem(KEY); } catch (_) { /* ignore */ }
}

export function deleteEntry(ts) {
  const entries = loadHistory().filter((e) => e.ts !== ts);
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch (_) { /* ignore */ }
  return entries;
}

export function exportHistoryCsv() {
  const entries = loadHistory();
  if (!entries.length) return;

  const headers = [
    'Timestamp',
    'DateTime',
    'Tag',
    'ISP',
    'City',
    'Region',
    'Colo',
    'Download_Mbps',
    'Upload_Mbps',
    'Ping_ms',
    'Jitter_ms',
    'PacketLoss_Pct',
    'LoadedRTT_ms',
  ];

  let csv = headers.join(',') + '\n';
  entries.forEach((e) => {
    const row = [
      e.ts,
      `"${fmtDateTime(e.ts)}"`,
      `"${e.tag || ''}"`,
      `"${(e.isp || '').replace(/"/g, '""')}"`,
      `"${(e.city || '').replace(/"/g, '""')}"`,
      `"${(e.region || '').replace(/"/g, '""')}"`,
      `"${e.colo || ''}"`,
      e.down != null ? e.down.toFixed(2) : '',
      e.up != null ? e.up.toFixed(2) : '',
      e.ping != null ? e.ping.toFixed(1) : '',
      e.jitter != null ? e.jitter.toFixed(1) : '',
      e.loss != null ? e.loss.toFixed(1) : '',
      e.loadedRtt != null ? e.loadedRtt.toFixed(1) : '',
    ];
    csv += row.join(',') + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `SpeedUndo_History_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function computeComparison(entryA, entryB) {
  // A is typically the baseline / reference, B is the target (or vice versa)
  const calcDelta = (valB, valA, isLowerBetter = false) => {
    if (valA == null || valB == null) return { diff: '—', pct: '—', class: 'delta-neutral' };
    const diff = valB - valA;
    const pct = valA !== 0 ? ((diff / Math.abs(valA)) * 100).toFixed(1) : '0';
    let isPositive = diff > 0;
    if (isLowerBetter) isPositive = diff < 0;
    const isGood = isPositive;
    return {
      diff: (diff > 0 ? '+' : '') + diff.toFixed(1),
      pct: (diff > 0 ? '+' : '') + pct + '%',
      class: Math.abs(diff) < 0.05 ? 'delta-neutral' : (isGood ? 'delta-good' : 'delta-bad'),
    };
  };

  return {
    a: entryA,
    b: entryB,
    down: calcDelta(entryB.down, entryA.down, false),
    up: calcDelta(entryB.up, entryA.up, false),
    ping: calcDelta(entryB.ping, entryA.ping, true),
    jitter: calcDelta(entryB.jitter, entryA.jitter, true),
    loss: calcDelta(entryB.loss, entryA.loss, true),
    loaded: calcDelta(entryB.loadedRtt, entryA.loadedRtt, true),
  };
}

export function renderHistory(listEl, entries, onDelete, onTagChange, onSelectCompare) {
  listEl.textContent = '';
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'No tests yet. Run one and it will be kept here, in this browser.';
    listEl.appendChild(empty);
    return;
  }
  const maxMbps = Math.max(
    1,
    ...entries.map((e) => Math.max(e.down || 0, e.up || 0)),
  );

  for (const e of entries) {
    const row = document.createElement('article');
    row.className = 'history-row';
    row.dataset.ts = e.ts;

    const head = document.createElement('div');
    head.className = 'history-head';

    const left = document.createElement('div');
    left.className = 'history-head-left';

    // Selection checkbox for side-by-side comparison
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'history-chk';
    chk.setAttribute('aria-label', `Select run from ${fmtStamp(e.ts)} to compare`);
    chk.addEventListener('change', () => {
      if (onSelectCompare) onSelectCompare(e.ts, chk.checked);
    });

    const stamp = document.createElement('span');
    stamp.className = 'history-stamp';
    stamp.textContent = fmtStamp(e.ts) + (e.colo ? ` · via ${e.colo}` : '');
    left.append(chk, stamp);

    const right = document.createElement('div');
    right.className = 'history-head-right';

    // Tag selector
    const tagSelect = document.createElement('select');
    tagSelect.className = 'history-tag-select';
    tagSelect.setAttribute('aria-label', 'Network Tag');
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '+ Tag';
    tagSelect.appendChild(defaultOpt);

    AVAILABLE_TAGS.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      if (e.tag === t) opt.selected = true;
      tagSelect.appendChild(opt);
    });

    tagSelect.addEventListener('change', (ev) => {
      if (onTagChange) onTagChange(e.ts, ev.target.value || null);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-del';
    del.setAttribute('aria-label', `Delete result from ${fmtStamp(e.ts)}`);
    del.textContent = '✕';
    del.addEventListener('click', () => onDelete(e.ts));

    right.append(tagSelect, del);
    head.append(left, right);
    row.appendChild(head);

    if (e.tag) {
      const tagChip = document.createElement('span');
      tagChip.className = 'history-active-tag';
      tagChip.textContent = `🏷️ ${e.tag}`;
      row.appendChild(tagChip);
    }

    if (e.isp || e.city || e.postal) {
      const net = document.createElement('div');
      net.className = 'history-net';
      const place = [e.city, e.region, e.postal].filter(Boolean).join(' · ');
      net.textContent = [e.isp, place].filter(Boolean).join(' — ');
      row.appendChild(net);
    }

    for (const [kind, label, value] of [
      ['rx', 'RX', e.down],
      ['tx', 'TX', e.up],
    ]) {
      const line = document.createElement('div');
      line.className = 'history-line';
      const tag = document.createElement('span');
      tag.className = 'history-tag';
      tag.textContent = label;
      const barWrap = document.createElement('span');
      barWrap.className = 'history-bar-wrap';
      const bar = document.createElement('span');
      bar.className = `history-bar history-bar-${kind}`;
      bar.style.width = `${Math.max(2, ((value || 0) / maxMbps) * 100)}%`;
      barWrap.appendChild(bar);
      const val = document.createElement('span');
      val.className = 'history-val';
      val.textContent = `${fmtMbps(value)} ${speedUnitLabel()}`;
      line.append(tag, barWrap, val);
      row.appendChild(line);
    }

    const foot = document.createElement('div');
    foot.className = 'history-foot';
    foot.textContent = `ping ${fmtMs(e.ping)} ms · jitter ${fmtMs(e.jitter)} ms`
      + (e.loss != null ? ` · loss ${e.loss}%` : '')
      + (e.loadedRtt != null ? ` · loaded ${fmtMs(e.loadedRtt)} ms` : '');
    row.appendChild(foot);

    listEl.appendChild(row);
  }
}
