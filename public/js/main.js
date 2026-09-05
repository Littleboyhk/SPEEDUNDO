// UI orchestration: state machine over the engine's events.
// States: idle → running(meta|ping|download|upload) → done | error.

import { SERVERS, SpeedTest } from './engine.js';
import { Gauge } from './gauge.js';
import { Trace } from './trace.js';
import { initTheme, toggleTheme, currentTheme } from './theme.js';
import {
  loadHistory, saveResult, clearHistory, deleteEntry, renderHistory,
  updateEntryTag, exportHistoryCsv, computeComparison, AVAILABLE_TAGS,
} from './history.js';
import {
  fmtMbps, fmtMs, fmtBytes, fmtPct, fmtDateTime, speedUnitLabel,
} from './format.js';
import { getSettings, getSetting, setSetting } from './settings.js';
import { detectIsp } from './geo.js';
import {
  submitResult, fetchLeaderboard, fetchPatterns, fetchOutage, fetchCountries,
  renderLeaderboard, renderCountryBoard, renderOutage, PatternsChart, embedFor,
} from './intel.js';
import {
  defaultCaption, drawCard, copyCardToClipboard, downloadCard,
  nativeShare, renderNetworkButtons,
} from './share.js';
import {
  unlockAudio, playRelayClick, playProbeTick,
  startThroughputSweep, updateThroughputSweep, stopThroughputSweep,
  playCompletionChime,
} from './audio.js';
import { renderQualityCard } from './quality.js';
import {
  openDisputeModal, closeDisputeModal, copyDisputeReport, downloadDisputeReport,
} from './report.js';
import { PingMonitor } from './monitor.js';
import {
  runGlobalPingMatrix, runDnsBenchmark, checkIpv6Support, renderMatrixView,
} from './matrix.js';

const $ = (id) => document.getElementById(id);

const els = {
  themeBtn: $('themeBtn'), historyBtn: $('historyBtn'),
  soundBtn: $('soundBtn'), kioskBtn: $('kioskBtn'), monitorBtn: $('monitorBtn'),
  gaugeCanvas: $('gauge'), goBtn: $('goBtn'),
  reading: $('gaugeReading'), liveValue: $('liveValue'), liveUnit: $('liveUnit'),
  phaseChip: $('phaseChip'), phaseLed: $('phaseLed'), phaseText: $('phaseText'),
  stopBtn: $('stopBtn'), againBtn: $('againBtn'), copyBtn: $('copyBtn'),
  shareBtn: $('shareBtn'), shareModal: $('shareModal'), shareBackdrop: $('shareBackdrop'),
  shareClose: $('shareClose'), shareCard: $('shareCard'), shareCaption: $('shareCaption'),
  shareNets: $('shareNets'), shareDownload: $('shareDownload'),
  shareCopyImg: $('shareCopyImg'), shareNative: $('shareNative'), shareNote: $('shareNote'),
  errorBanner: $('errorBanner'), errorText: $('errorText'), retryBtn: $('retryBtn'),
  pingVal: $('pingVal'), jitterVal: $('jitterVal'), lossVal: $('lossVal'),
  downVal: $('downVal'), upVal: $('upVal'),
  ispLine: $('ispLine'), ispName: $('ispName'), ispWhere: $('ispWhere'),
  outage: $('outage'),
  resultTagBar: $('resultTagBar'), resultTagChips: $('resultTagChips'),
  qualitySection: $('qualitySection'),
  disputeBtn: $('disputeBtn'), disputeModal: $('disputeModal'),
  disputeBackdrop: $('disputeBackdrop'), disputeClose: $('disputeClose'),
  disputePreview: $('disputePreview'), disputePrint: $('disputePrint'),
  disputeCopy: $('disputeCopy'), disputeDownload: $('disputeDownload'),
  monitorModal: $('monitorModal'), monitorBackdrop: $('monitorBackdrop'),
  monitorClose: $('monitorClose'), monitorCanvas: $('monitorCanvas'),
  monitorList: $('monitorList'), monitorStats: $('monitorStats'),
  monitorToggleBtn: $('monitorToggleBtn'), monitorClearBtn: $('monitorClearBtn'),
  monitorExportBtn: $('monitorExportBtn'),
  compareModal: $('compareModal'), compareBackdrop: $('compareBackdrop'),
  compareClose: $('compareClose'), compareContent: $('compareContent'),
  compareBtn: $('compareBtn'), exportCsvBtn: $('exportCsvBtn'),
  kioskHud: $('kioskHud'), kioskCountdown: $('kioskCountdown'), kioskExitBtn: $('kioskExitBtn'),
  kioskIntervalSelect: $('kioskIntervalSelect'),
  intel: $('intel'), intelScope: $('intelScope'), leaderboard: $('leaderboard'),
  countryBoard: $('countryBoard'),
  patterns: $('patterns'), patternsTip: $('patternsTip'), patternsScope: $('patternsScope'),
  matrixContainer: $('matrixContainer'),
  badgeImg: $('badgeImg'), embedMd: $('embedMd'), embedHtml: $('embedHtml'),
  statsLink: $('statsLink'),
  traceCanvas: $('trace'), traceTooltip: $('traceTooltip'),
  details: $('details'), detailsBody: $('detailsBody'),
  metaChips: $('metaChips'), serverSelect: $('serverSelect'),
  drawer: $('drawer'), drawerClose: $('drawerClose'),
  historyList: $('historyList'), clearBtn: $('clearBtn'),
  backdrop: $('backdrop'), srStatus: $('srStatus'),
  settingsBtn: $('settingsBtn'), settingsModal: $('settingsModal'),
  settingsBackdrop: $('settingsBackdrop'), settingsClose: $('settingsClose'),
  dateFormat: $('dateFormat'), settingsServerName: $('settingsServerName'),
  settingsServerSelect: $('settingsServerSelect'), settingsChangeServer: $('settingsChangeServer'),
};

const PHASE_LABEL = {
  meta: 'CONNECTING', ping: 'LATENCY',
  download: 'DOWNLOAD', upload: 'UPLOAD',
  loss: 'PACKET LOSS', done: 'COMPLETE',
};
const PHASE_KIND = { ping: 'ping', download: 'down', upload: 'up', loss: 'ping' };

let state = 'idle';
let engine = null;
let lastResult = null;
let lastDownT = 0;
let upOffset = 0;

initTheme();
const gauge = new Gauge(els.gaugeCanvas);
const trace = new Trace(els.traceCanvas, els.traceTooltip);
const pingMonitor = new PingMonitor(els.monitorCanvas, els.monitorList, els.monitorStats);

// ---- helpers ---------------------------------------------------------------

function announce(text) {
  els.srStatus.textContent = text;
}

function setPhaseChip(label, kind) {
  els.phaseText.textContent = label;
  els.phaseLed.dataset.kind = kind || 'idle';
  els.phaseChip.hidden = false;
}

function setReading(valueText, unitText) {
  els.liveValue.textContent = valueText;
  els.liveUnit.textContent = unitText;
}

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  els.goBtn.hidden = next !== 'idle';
  els.reading.hidden = next === 'idle';
  els.stopBtn.hidden = next !== 'running';
  els.againBtn.hidden = !(next === 'done' || next === 'error');
  els.copyBtn.hidden = next !== 'done';
  els.shareBtn.hidden = next !== 'done';
  if (els.disputeBtn) els.disputeBtn.hidden = next !== 'done';
  if (next !== 'running') {
    els.phaseChip.hidden = next === 'idle';
  }
  if (next === 'running') {
    els.errorBanner.hidden = true;
    if (els.qualitySection) els.qualitySection.hidden = true;
    if (els.resultTagBar) els.resultTagBar.hidden = true;
  }
}

function resetTiles() {
  for (const el of [els.pingVal, els.jitterVal, els.lossVal, els.downVal, els.upVal]) {
    el.textContent = '—';
  }
}

// Selected server lookup
function selectedServer() {
  const chosen = getSetting('server');
  return SERVERS.find((s) => s.id === chosen) || SERVERS[0];
}

function renderMetaChips(meta, loadedRtt) {
  els.metaChips.textContent = '';
  const chips = [];
  if (meta?.ip) chips.push({ label: 'IP', val: meta.ip });
  if (meta?.asn) chips.push({ label: 'ASN', val: `AS${meta.asn}` });
  if (meta?.colo) chips.push({ label: 'VIA', val: meta.colo });
  if (loadedRtt != null) chips.push({ label: 'LOADED RTT', val: `${fmtMs(loadedRtt)} ms` });
  for (const c of chips) {
    const li = document.createElement('li');
    li.className = 'meta-chip';
    const l = document.createElement('span');
    l.className = 'chip-label';
    l.textContent = c.label;
    const v = document.createElement('span');
    v.className = 'chip-val';
    v.textContent = c.val;
    li.append(l, v);
    els.metaChips.appendChild(li);
  }
}

function fillDetails(r) {
  const u = speedUnitLabel();
  const rows = [
    ['Phase', 'Duration', 'Samples', 'Metric'],
    ['Ping', '—', `${r.pingSamples?.length || 0} pings`, `${fmtMs(r.ping)} ms (jitter ${fmtMs(r.jitter)} ms)`],
    ['Download', '15.0 s', `${r.downRaw?.length || 0} samples`, `${fmtMbps(r.down)} ${u} (peak ${fmtMbps(r.downPeak)} ${u})`],
    ['Upload', '15.0 s', `${r.upRaw?.length || 0} samples`, `${fmtMbps(r.up)} ${u} (peak ${fmtMbps(r.upPeak)} ${u})`],
  ];
  if (r.loss != null) {
    rows.push(['Packet loss', '—', r.lossMethod || 'WebRTC relay', `${fmtPct(r.loss)}% loss`]);
  }
  if (r.loadedRtt != null) {
    rows.push(['Loaded RTT', 'under download load', '0-byte pings', `${fmtMs(r.loadedRtt)} ms`]);
  }
  els.detailsBody.textContent = '';
  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    row.forEach((cell) => {
      const el = document.createElement(i === 0 ? 'th' : 'td');
      el.textContent = cell;
      tr.appendChild(el);
    });
    els.detailsBody.appendChild(tr);
  });
  els.details.hidden = false;
}

// Result Tag selector chips
function renderResultTagChips(ts) {
  if (!els.resultTagChips || !els.resultTagBar) return;
  els.resultTagChips.innerHTML = '';
  AVAILABLE_TAGS.forEach((tag) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-chip-btn';
    btn.textContent = tag;
    btn.addEventListener('click', () => {
      updateEntryTag(ts, tag);
      els.resultTagChips.querySelectorAll('.tag-chip-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderHistoryList();
    });
    els.resultTagChips.appendChild(btn);
  });
  els.resultTagBar.hidden = false;
}

// ---- test run ---------------------------------------------------------------

function start() {
  if (state === 'running') return;
  unlockAudio();
  playRelayClick(true);

  const server = selectedServer();
  lastDownT = 0;
  upOffset = 0;
  resetTiles();
  trace.reset();
  els.details.hidden = true;
  if (els.qualitySection) els.qualitySection.hidden = true;
  if (els.resultTagBar) els.resultTagBar.hidden = true;
  setState('running');
  setPhaseChip(PHASE_LABEL.meta, 'idle');
  setReading('···', '');
  gauge.setKind('idle');
  gauge.start((val) => {
    setReading(fmtMbps(val), speedUnitLabel());
  });
  announce('Test started. Connecting to the test server.');

  engine = new SpeedTest(server, {
    server_selected(srv, rtt) {
      const rttText = rtt != null ? ` (${fmtMs(rtt)} ms)` : '';
      setPhaseChip(`ROUTED: ${srv.label.split('(')[0].trim()}${rttText}`, 'idle');
    },
    phase(name) {
      const kind = PHASE_KIND[name] || 'idle';
      if (name !== 'done') setPhaseChip(PHASE_LABEL[name], kind);
      if (name === 'ping') {
        gauge.setKind('idle');
        setReading('···', '');
        stopThroughputSweep();
        announce('Measuring latency in the background.');
      } else if (name === 'download') {
        gauge.setKind('down');
        gauge.setValue(0);
        startThroughputSweep('down');
        announce('Measuring download speed.');
      } else if (name === 'upload') {
        upOffset = lastDownT + 1;
        gauge.setKind('up');
        gauge.setValue(0);
        startThroughputSweep('up');
        announce('Measuring upload speed.');
      } else if (name === 'loss') {
        gauge.setKind('idle');
        setReading('···', '');
        stopThroughputSweep();
        announce('Measuring packet loss over a relay in the background.');
      }
    },
    isp(g) {
      showIspLine(g);
    },
    loss(l) {
      els.lossVal.textContent = l ? fmtPct(l.lossPct) : '—';
    },
    meta(m) {
      renderMetaChips(m, null);
    },
    ping(ms) {
      playProbeTick();
      els.pingVal.textContent = fmtMs(ms);
    },
    sample(kind, t, v) {
      if (kind === 'down') {
        lastDownT = t;
        trace.addSample('down', t, v);
      } else {
        trace.addSample('up', upOffset + t, v);
      }
    },
    live(kind, mbps) {
      gauge.setValue(mbps);
      updateThroughputSweep(mbps);
      (kind === 'down' ? els.downVal : els.upVal).textContent = fmtMbps(mbps);
    },
    done(result) {
      stopThroughputSweep();
      playCompletionChime();
      lastResult = result;
      els.pingVal.textContent = fmtMs(result.ping);
      els.jitterVal.textContent = fmtMs(result.jitter);
      els.lossVal.textContent = result.loss != null ? fmtPct(result.loss) : '—';
      els.downVal.textContent = fmtMbps(result.down);
      els.upVal.textContent = fmtMbps(result.up);
      gauge.setKind('done');
      gauge.stop();
      trace.finish();

      gauge.park((v) => setReading(v === 0 ? '0' : fmtMbps(v), speedUnitLabel()));
      setPhaseChip(PHASE_LABEL.done, 'down');
      renderMetaChips(result.meta, result.loadedRtt);
      fillDetails(result);

      // Feature 1: Connection Quality & Bufferbloat Grades
      renderQualityCard(els.qualitySection, result);

      // Save result to history and render tag chips
      saveResult(result);
      renderHistoryList();
      renderResultTagChips(result.ts);

      setState('done');

      // Community submission
      const srv = SERVERS.find((s) => s.id === (result.selectedServerId || result.server));
      if (srv?.internet && result.geo) {
        submitResult(result).finally(() => loadIntel(result.geo));
      } else if (result.geo || currentGeo) {
        loadIntel(result.geo || currentGeo);
      }

      const unitWord = getSetting('speed') === 'kbps' ? 'kilobits per second' : 'megabits per second';
      announce(
        `Test complete. Download ${fmtMbps(result.down)} ${unitWord}, `
        + `upload ${fmtMbps(result.up)} ${unitWord}, `
        + `ping ${fmtMs(result.ping)} milliseconds`
        + (result.loss != null ? `, packet loss ${fmtPct(result.loss)} percent.` : '.'),
      );

      // Kiosk auto-repeat scheduler
      scheduleKioskLoop();
    },
    error(err, phase) {
      stopThroughputSweep();
      playRelayClick(false);
      gauge.stop();
      gauge.park();
      trace.finish();
      setState('error');
      setPhaseChip('ERROR', 'idle');
      setReading('—', '');
      els.errorText.textContent = phase
        ? `The ${phase} phase failed: ${err.message} Check your connection and try again.`
        : `The test failed: ${err.message}`;
      announce(els.errorText.textContent);
    },
    aborted() {
      stopThroughputSweep();
      playRelayClick(false);
      gauge.setKind('idle');
      gauge.stop();
      trace.finish();
      setState('idle');
      setReading('—', '');
      announce('Test stopped.');
    },
  });
  engine.run();
}

// ---- network intel ----------------------------------------------------------

let currentGeo = null;
let lastIntel = null;
const patternsChart = new PatternsChart(els.patterns, els.patternsTip);

function showIspLine(g) {
  currentGeo = g;
  if (!g || (!g.isp && !g.city)) { els.ispLine.hidden = true; return; }
  els.ispName.textContent = g.isp || 'Unknown ISP';
  els.ispWhere.textContent = [g.city, g.region, g.postal].filter(Boolean).join(' · ');
  els.ispLine.hidden = false;
}

function renderIntelFromCache() {
  if (!lastIntel) return;
  const { lb, pat, out, g, patScope, ctry } = lastIntel;
  if (lb) renderLeaderboard(els.leaderboard, lb, g?.isp);
  if (ctry) renderCountryBoard(els.countryBoard, ctry, g?.country);
  if (pat) patternsChart.setData(pat.hours || pat);
  if (out) renderOutage(els.outage, out, g?.isp);
  els.patternsScope.textContent = patScope ? `scope: ${patScope}` : '';
  const place = [g?.city, g?.region, g?.country].filter(Boolean).join(', ');
  els.intelScope.textContent = place ? `local: ${place}` : '';
}

async function loadIntel(g) {
  if (!g?.city && !g?.isp) return;
  let [lb, pat, out, ctry] = await Promise.all([
    fetchLeaderboard({ city: g.city }),
    fetchPatterns({ isp: g.isp, city: g.city }),
    g.isp ? fetchOutage({ isp: g.isp, city: g.city }) : Promise.resolve(null),
    fetchCountries({}),
  ]);
  let patScope = g.isp || 'All ISPs';
  if (pat && g.isp && pat.scope.samples < 12) {
    const cityWide = await fetchPatterns({ city: g.city });
    if (cityWide && cityWide.scope.samples > pat.scope.samples) {
      pat = cityWide;
      patScope = 'All ISPs';
    }
  }
  lastIntel = { lb, pat, out, g, patScope, ctry };
  renderIntelFromCache();
  const embed = embedFor(g, location.origin);
  els.badgeImg.src = embed.badge;
  els.embedMd.value = embed.markdown;
  els.embedHtml.value = embed.html;
  els.statsLink.href = embed.stats;
  els.intel.hidden = false;
}

// Global Matrix & DNS Benchmark Runner
let matrixCached = null;
async function loadMatrixAndDns(force = false) {
  if (matrixCached && !force) return;
  els.matrixContainer.innerHTML = '<p class="matrix-loading">Measuring transit hops and DNS resolvers...</p>';
  try {
    const [ipv6, matrixResults, dnsResults] = await Promise.all([
      checkIpv6Support(),
      runGlobalPingMatrix(),
      runDnsBenchmark(),
    ]);
    matrixCached = { ipv6, matrixResults, dnsResults };
    renderMatrixView(els.matrixContainer, matrixResults, dnsResults, ipv6);
    const refreshBtn = $('matrixRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadMatrixAndDns(true));
  } catch (err) {
    els.matrixContainer.innerHTML = `<p class="matrix-loading">Matrix error: ${err.message}</p>`;
  }
}

// Tabs
for (const tab of document.querySelectorAll('.intel-tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.intel-tab')) {
      t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    }
    for (const view of document.querySelectorAll('.intel-view')) {
      view.hidden = view.dataset.panel !== tab.dataset.tab;
    }
    if (tab.dataset.tab === 'patterns') patternsChart.resize();
    if (tab.dataset.tab === 'matrix') loadMatrixAndDns();
  });
}
for (const input of [els.embedMd, els.embedHtml]) {
  input.addEventListener('focus', () => input.select());
}

detectIsp().then((g) => {
  showIspLine(g);
  if (g) loadIntel(g);
}).catch(() => {});

// ---- wiring -----------------------------------------------------------------

els.goBtn.addEventListener('click', start);
els.againBtn.addEventListener('click', start);
els.retryBtn.addEventListener('click', start);
els.stopBtn.addEventListener('click', () => engine?.abort());

els.themeBtn.addEventListener('click', () => {
  const next = toggleTheme();
  els.themeBtn.setAttribute('aria-label', `Switch to ${next === 'dark' ? 'light' : 'dark'} theme`);
});
els.themeBtn.setAttribute(
  'aria-label',
  `Switch to ${currentTheme() === 'dark' ? 'light' : 'dark'} theme`,
);

// Audio toggle in topbar
function syncSoundBtn() {
  const isSoundOn = getSetting('sound') !== 'off';
  els.soundBtn.textContent = isSoundOn ? '🔊' : '🔇';
  els.soundBtn.setAttribute('aria-label', isSoundOn ? 'Mute sound effects' : 'Enable sound effects');
}
els.soundBtn.addEventListener('click', () => {
  unlockAudio();
  const next = getSetting('sound') === 'on' ? 'off' : 'on';
  setSetting('sound', next);
  syncSoundBtn();
  playRelayClick();
});
syncSoundBtn();

// Copy result
els.copyBtn.addEventListener('click', async () => {
  if (!lastResult) return;
  const r = lastResult;
  const when = fmtDateTime(r.ts);
  const u = speedUnitLabel();
  const text = `SpeedUndo speed test — down ${fmtMbps(r.down)} ${u} · up ${fmtMbps(r.up)} ${u}`
    + ` · ping ${fmtMs(r.ping)} ms · jitter ${fmtMs(r.jitter)} ms`
    + (r.meta?.colo ? ` · via ${r.meta.colo}` : '') + ` · ${when}`;
  try {
    await navigator.clipboard.writeText(text);
    els.copyBtn.textContent = 'Copied';
    setTimeout(() => { els.copyBtn.textContent = 'Copy result'; }, 1600);
  } catch (_) {
    announce('Copy failed. Clipboard access was blocked.');
  }
});

// Server selection
function populateServerSelect(sel) {
  for (const s of SERVERS) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
}
populateServerSelect(els.serverSelect);
populateServerSelect(els.settingsServerSelect);

function applyServerToUI() {
  const id = getSetting('server');
  els.serverSelect.value = id;
  els.settingsServerSelect.value = id;
  const s = selectedServer();
  els.settingsServerName.textContent = s.label;
}

els.serverSelect.addEventListener('change', () => setSetting('server', els.serverSelect.value));
els.settingsServerSelect.addEventListener('change', () => {
  setSetting('server', els.settingsServerSelect.value);
  applyServerToUI();
  els.settingsServerSelect.hidden = true;
  els.settingsChangeServer.textContent = 'Change Server';
});

els.settingsChangeServer.addEventListener('click', () => {
  const isHidden = els.settingsServerSelect.hidden;
  els.settingsServerSelect.hidden = !isHidden;
  els.settingsChangeServer.textContent = isHidden ? 'Done' : 'Change Server';
  if (isHidden) els.settingsServerSelect.focus();
});

// ---- Feature 2: ISP Dispute Report Modal ------------------------------------

els.disputeBtn.addEventListener('click', () => {
  if (!lastResult) return;
  openDisputeModal(els.disputeModal, els.disputeBackdrop, lastResult);
});
els.disputeClose.addEventListener('click', () => closeDisputeModal(els.disputeModal, els.disputeBackdrop));
els.disputeBackdrop.addEventListener('click', () => closeDisputeModal(els.disputeModal, els.disputeBackdrop));
els.disputePrint.addEventListener('click', () => window.print());
els.disputeCopy.addEventListener('click', async () => {
  if (!lastResult) return;
  try {
    await copyDisputeReport(lastResult);
    flashBtn(els.disputeCopy, 'Copied Ticket ✓', 'Copy Markdown Ticket');
  } catch (_) {
    flashBtn(els.disputeCopy, 'Copy Failed', 'Copy Markdown Ticket');
  }
});
els.disputeDownload.addEventListener('click', () => {
  if (lastResult) downloadDisputeReport(lastResult);
});

// ---- Feature 3: Ping Pulse & Stability Monitor Modal -----------------------

function openMonitor() {
  els.monitorModal.hidden = false;
  els.monitorBackdrop.hidden = false;
  pingMonitor.start();
  els.monitorToggleBtn.textContent = 'Pause';
}
function closeMonitor() {
  els.monitorModal.hidden = true;
  els.monitorBackdrop.hidden = true;
  pingMonitor.stop();
}

els.monitorBtn.addEventListener('click', openMonitor);
els.monitorClose.addEventListener('click', closeMonitor);
els.monitorBackdrop.addEventListener('click', closeMonitor);
els.monitorToggleBtn.addEventListener('click', () => {
  if (pingMonitor.running) {
    pingMonitor.stop();
    els.monitorToggleBtn.textContent = 'Resume';
  } else {
    pingMonitor.start();
    els.monitorToggleBtn.textContent = 'Pause';
  }
});
els.monitorClearBtn.addEventListener('click', () => pingMonitor.clear());
els.monitorExportBtn.addEventListener('click', () => pingMonitor.exportCsv());

// ---- Feature 4: History Tagging, Compare & CSV Export ----------------------

const selectedToCompare = new Set();

function updateCompareButton() {
  const count = selectedToCompare.size;
  els.compareBtn.textContent = `Compare (${count}/2)`;
  els.compareBtn.disabled = count !== 2;
}

function renderHistoryList() {
  const entries = loadHistory();
  renderHistory(
    els.historyList,
    entries,
    onDeleteEntry,
    (ts, tag) => {
      updateEntryTag(ts, tag);
      renderHistoryList();
    },
    (ts, checked) => {
      if (checked) {
        if (selectedToCompare.size >= 2) {
          // Keep max 2
          const first = selectedToCompare.values().next().value;
          selectedToCompare.delete(first);
        }
        selectedToCompare.add(ts);
      } else {
        selectedToCompare.delete(ts);
      }
      // Re-sync check states in DOM
      els.historyList.querySelectorAll('.history-chk').forEach((chk) => {
        const row = chk.closest('.history-row');
        if (row) {
          const rowTs = Number(row.dataset.ts);
          chk.checked = selectedToCompare.has(rowTs);
        }
      });
      updateCompareButton();
    },
  );
  // Restore checked boxes
  els.historyList.querySelectorAll('.history-chk').forEach((chk) => {
    const row = chk.closest('.history-row');
    if (row) {
      const rowTs = Number(row.dataset.ts);
      chk.checked = selectedToCompare.has(rowTs);
    }
  });
  updateCompareButton();
}

function onDeleteEntry(ts) {
  selectedToCompare.delete(ts);
  deleteEntry(ts);
  renderHistoryList();
}

els.exportCsvBtn.addEventListener('click', () => exportHistoryCsv());

els.compareBtn.addEventListener('click', () => {
  if (selectedToCompare.size !== 2) return;
  const entries = loadHistory();
  const [ts1, ts2] = Array.from(selectedToCompare);
  const itemA = entries.find((e) => e.ts === ts1);
  const itemB = entries.find((e) => e.ts === ts2);
  if (!itemA || !itemB) return;

  const diff = computeComparison(itemA, itemB);
  const u = speedUnitLabel();

  els.compareContent.innerHTML = `
    <table class="compare-table">
      <thead>
        <tr>
          <th>Metric</th>
          <th>Run A (${fmtDateTime(itemA.ts)}) ${itemA.tag ? `[${itemA.tag}]` : ''}</th>
          <th>Run B (${fmtDateTime(itemB.ts)}) ${itemB.tag ? `[${itemB.tag}]` : ''}</th>
          <th>Delta (B vs A)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Download</td>
          <td>${fmtMbps(itemA.down)} ${u}</td>
          <td>${fmtMbps(itemB.down)} ${u}</td>
          <td class="${diff.down.class}">${diff.down.diff} ${u} (${diff.down.pct})</td>
        </tr>
        <tr>
          <td>Upload</td>
          <td>${fmtMbps(itemA.up)} ${u}</td>
          <td>${fmtMbps(itemB.up)} ${u}</td>
          <td class="${diff.up.class}">${diff.up.diff} ${u} (${diff.up.pct})</td>
        </tr>
        <tr>
          <td>Ping</td>
          <td>${fmtMs(itemA.ping)} ms</td>
          <td>${fmtMs(itemB.ping)} ms</td>
          <td class="${diff.ping.class}">${diff.ping.diff} ms (${diff.ping.pct})</td>
        </tr>
        <tr>
          <td>Jitter</td>
          <td>${fmtMs(itemA.jitter)} ms</td>
          <td>${fmtMs(itemB.jitter)} ms</td>
          <td class="${diff.jitter.class}">${diff.jitter.diff} ms (${diff.jitter.pct})</td>
        </tr>
        <tr>
          <td>Packet Loss</td>
          <td>${itemA.loss != null ? fmtPct(itemA.loss) + '%' : '0.0%'}</td>
          <td>${itemB.loss != null ? fmtPct(itemB.loss) + '%' : '0.0%'}</td>
          <td class="${diff.loss.class}">${diff.loss.diff}%</td>
        </tr>
        <tr>
          <td>Loaded RTT</td>
          <td>${itemA.loadedRtt != null ? fmtMs(itemA.loadedRtt) + ' ms' : '—'}</td>
          <td>${itemB.loadedRtt != null ? fmtMs(itemB.loadedRtt) + ' ms' : '—'}</td>
          <td class="${diff.loaded.class}">${diff.loaded.diff !== '—' ? diff.loaded.diff + ' ms' : '—'}</td>
        </tr>
      </tbody>
    </table>
  `;

  els.compareModal.hidden = false;
  els.compareBackdrop.hidden = false;
});

els.compareClose.addEventListener('click', () => {
  els.compareModal.hidden = true;
  els.compareBackdrop.hidden = true;
});
els.compareBackdrop.addEventListener('click', () => {
  els.compareModal.hidden = true;
  els.compareBackdrop.hidden = true;
});

// ---- Feature 7: Fullscreen Kiosk / TV NOC Mode -----------------------------

let kioskTimer = null;
let kioskCountdownSeconds = 0;
let wakeLock = null;

async function requestScreenWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (_) {}
}

function releaseScreenWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function toggleKioskMode(force = null) {
  const active = force !== null ? force : !document.body.classList.contains('kiosk-mode');
  if (active) {
    document.body.classList.add('kiosk-mode');
    requestScreenWakeLock();
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
    updateKioskHud();
  } else {
    document.body.classList.remove('kiosk-mode');
    releaseScreenWakeLock();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    if (kioskTimer) {
      clearInterval(kioskTimer);
      kioskTimer = null;
    }
    els.kioskHud.hidden = true;
  }
}

function parseKioskInterval() {
  const val = getSetting('kioskInterval') || 'off';
  const mins = { '5m': 5, '15m': 15, '30m': 30, '60m': 60 }[val];
  return mins ? mins * 60 : 0;
}

function scheduleKioskLoop() {
  if (kioskTimer) {
    clearInterval(kioskTimer);
    kioskTimer = null;
  }
  const intervalSec = parseKioskInterval();
  if (!intervalSec) {
    els.kioskHud.hidden = true;
    return;
  }

  kioskCountdownSeconds = intervalSec;
  updateKioskHud();

  kioskTimer = setInterval(() => {
    kioskCountdownSeconds--;
    if (kioskCountdownSeconds <= 0) {
      clearInterval(kioskTimer);
      kioskTimer = null;
      start();
    } else {
      updateKioskHud();
    }
  }, 1000);
}

function updateKioskHud() {
  const intervalSec = parseKioskInterval();
  if (!intervalSec) {
    els.kioskHud.hidden = true;
    return;
  }
  els.kioskHud.hidden = false;
  const m = Math.floor(kioskCountdownSeconds / 60);
  const s = kioskCountdownSeconds % 60;
  els.kioskCountdown.textContent = `Next test in ${m}:${s < 10 ? '0' : ''}${s}`;
}

els.kioskBtn.addEventListener('click', () => toggleKioskMode());
els.kioskExitBtn.addEventListener('click', () => toggleKioskMode(false));

document.addEventListener('keydown', (e) => {
  if ((e.key === 'f' || e.key === 'F') && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    toggleKioskMode();
  }
  if (e.key === 'Escape') {
    if (!els.disputeModal.hidden) closeDisputeModal(els.disputeModal, els.disputeBackdrop);
    if (!els.monitorModal.hidden) closeMonitor();
    if (!els.compareModal.hidden) {
      els.compareModal.hidden = true;
      els.compareBackdrop.hidden = true;
    }
  }
});

// Drawer (history)
function inertTargets() {
  return [document.querySelector('.topbar'), document.querySelector('.app')].filter(Boolean);
}

function openDrawer() {
  renderHistoryList();
  els.drawer.hidden = false;
  els.backdrop.hidden = false;
  for (const el of inertTargets()) el.inert = true;
  requestAnimationFrame(() => {
    els.drawer.classList.add('open');
    els.backdrop.classList.add('open');
  });
  els.drawerClose.focus();
}

function closeDrawer() {
  els.drawer.classList.remove('open');
  els.backdrop.classList.remove('open');
  for (const el of inertTargets()) el.inert = false;
  setTimeout(() => {
    els.drawer.hidden = true;
    els.backdrop.hidden = true;
  }, 240);
  els.historyBtn.focus();
}

els.historyBtn.addEventListener('click', openDrawer);
els.drawerClose.addEventListener('click', closeDrawer);
els.backdrop.addEventListener('click', closeDrawer);
els.clearBtn.addEventListener('click', () => {
  clearHistory();
  selectedToCompare.clear();
  renderHistoryList();
});

// Share dialog
function flashBtn(btn, text, restore) {
  btn.textContent = text;
  setTimeout(() => { btn.textContent = restore; }, 1800);
}

function openShare() {
  if (!lastResult) return;
  drawCard(els.shareCard, lastResult);
  els.shareCaption.value = defaultCaption(lastResult);
  renderNetworkButtons(
    els.shareNets,
    () => els.shareCaption.value,
    () => copyCardToClipboard(els.shareCard),
    (ok) => {
      els.shareNote.textContent = ok
        ? 'Card image copied to clipboard! Paste it into your post.'
        : 'Clipboard unavailable — use "Download image" and attach it to the post.';
    },
  );
  els.shareModal.hidden = false;
  els.shareBackdrop.hidden = false;
  for (const el of inertTargets()) el.inert = true;
  requestAnimationFrame(() => {
    els.shareModal.classList.add('open');
    els.shareBackdrop.classList.add('open');
  });
  els.shareClose.focus();
}

function closeShare() {
  els.shareModal.classList.remove('open');
  els.shareBackdrop.classList.remove('open');
  for (const el of inertTargets()) el.inert = false;
  setTimeout(() => {
    els.shareModal.hidden = true;
    els.shareBackdrop.hidden = true;
  }, 240);
  els.shareBtn.focus();
}

els.shareBtn.addEventListener('click', openShare);
els.shareClose.addEventListener('click', closeShare);
els.shareBackdrop.addEventListener('click', closeShare);
els.shareDownload.addEventListener('click', () => {
  if (lastResult) downloadCard(els.shareCard, lastResult);
});
els.shareCopyImg.addEventListener('click', async () => {
  const ok = await copyCardToClipboard(els.shareCard);
  flashBtn(els.shareCopyImg, ok ? 'Copied ✓' : 'Copy failed', 'Copy image');
});
els.shareNative.addEventListener('click', () => {
  if (lastResult) nativeShare(els.shareCard, lastResult, els.shareCaption.value);
});
window.addEventListener('themechange', () => {
  if (!els.shareModal.hidden && lastResult) drawCard(els.shareCard, lastResult);
});

// ---- Settings ---------------------------------------------------------------

function syncSettingsControls() {
  const s = getSettings();
  for (const seg of document.querySelectorAll('.seg[data-setting]')) {
    const key = seg.dataset.setting;
    for (const opt of seg.querySelectorAll('.seg-opt')) {
      opt.setAttribute('aria-pressed', String(opt.dataset.value === s[key]));
    }
  }
  els.dateFormat.value = s.date;
  if (els.kioskIntervalSelect) els.kioskIntervalSelect.value = s.kioskInterval || 'off';
  applyServerToUI();
  syncSoundBtn();
}

function applySpeedUnitLabels() {
  const label = speedUnitLabel();
  for (const el of document.querySelectorAll('.js-speed-unit')) el.textContent = label;
  if (els.liveUnit.textContent === 'Mbps' || els.liveUnit.textContent === 'Kbps') {
    els.liveUnit.textContent = label;
  }
}

function refreshDisplaysForSettings() {
  applySpeedUnitLabels();
  if (lastResult) {
    els.downVal.textContent = fmtMbps(lastResult.down);
    els.upVal.textContent = fmtMbps(lastResult.up);
    els.pingVal.textContent = fmtMs(lastResult.ping);
    els.jitterVal.textContent = fmtMs(lastResult.jitter);
    els.lossVal.textContent = lastResult.loss != null ? fmtPct(lastResult.loss) : '—';
    if (!els.details.hidden) fillDetails(lastResult);
    if (els.qualitySection && !els.qualitySection.hidden) {
      renderQualityCard(els.qualitySection, lastResult);
    }
  }
  renderHistoryList();
  renderIntelFromCache();
  if (!els.shareModal.hidden && lastResult) drawCard(els.shareCard, lastResult);
  syncSoundBtn();
}

let settingsLastFocus = null;
function openSettings() {
  settingsLastFocus = document.activeElement;
  syncSettingsControls();
  els.settingsServerSelect.hidden = true;
  els.settingsChangeServer.textContent = 'Change Server';
  els.settingsModal.hidden = false;
  els.settingsBackdrop.hidden = false;
  for (const el of inertTargets()) el.inert = true;
  requestAnimationFrame(() => {
    els.settingsModal.classList.add('open');
    els.settingsBackdrop.classList.add('open');
  });
  els.settingsClose.focus();
}

function closeSettings() {
  els.settingsModal.classList.remove('open');
  els.settingsBackdrop.classList.remove('open');
  for (const el of inertTargets()) el.inert = false;
  setTimeout(() => {
    els.settingsModal.hidden = true;
    els.settingsBackdrop.hidden = true;
  }, 240);
  if (settingsLastFocus) settingsLastFocus.focus();
}

els.settingsBtn.addEventListener('click', openSettings);
els.settingsClose.addEventListener('click', closeSettings);
els.settingsBackdrop.addEventListener('click', closeSettings);

for (const seg of document.querySelectorAll('.seg[data-setting]')) {
  seg.addEventListener('click', (e) => {
    const opt = e.target.closest('.seg-opt');
    if (opt) setSetting(seg.dataset.setting, opt.dataset.value);
  });
}
els.dateFormat.addEventListener('change', () => setSetting('date', els.dateFormat.value));
if (els.kioskIntervalSelect) {
  els.kioskIntervalSelect.addEventListener('change', () => {
    setSetting('kioskInterval', els.kioskIntervalSelect.value);
    scheduleKioskLoop();
  });
}

window.addEventListener('settingschange', () => {
  syncSettingsControls();
  refreshDisplaysForSettings();
});

// Initial paint
setState('idle');
setReading('—', '');
syncSettingsControls();
applySpeedUnitLabels();
renderHistoryList();
