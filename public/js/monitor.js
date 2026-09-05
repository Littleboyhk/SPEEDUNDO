// SpeedUndo Continuous Ping Pulse & Line Stability Monitor.
// Runs background micro-pings every 1.5s, plots a live rolling oscilloscope
// of round-trip latency, detects micro-spikes and packet drops, and keeps a log.

import { fmtMs, meanAbsDiff } from './format.js';
import { playProbeTick } from './audio.js';

export class PingMonitor {
  constructor(canvasEl, listEl, statsEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl ? canvasEl.getContext('2d') : null;
    this.listEl = listEl;
    this.statsEl = statsEl;

    this.running = false;
    this.timer = null;
    this.history = []; // { ts, rtt, dropped }
    this.maxPoints = 80; // Rolling points on canvas
    this.logs = []; // Anomaly entries

    this.minPing = Infinity;
    this.maxPing = 0;
    this.totalPings = 0;
    this.droppedPings = 0;
    this.sumPing = 0;

    this.onResize = this.resize.bind(this);
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onResize);
    }
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(300, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(120, Math.floor(rect.height * dpr));
    this.draw();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.probe();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  clear() {
    this.history = [];
    this.logs = [];
    this.minPing = Infinity;
    this.maxPing = 0;
    this.totalPings = 0;
    this.droppedPings = 0;
    this.sumPing = 0;
    if (this.listEl) this.listEl.innerHTML = '<p class="monitor-empty">No anomalies recorded. Line is steady.</p>';
    this.updateStats();
    this.draw();
  }

  async probe() {
    if (!this.running) return;

    const startT = performance.now();
    let rtt = null;
    let dropped = false;

    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 2000);
      const target = `https://speed.cloudflare.com/__down?bytes=0&_t=${Date.now()}`;
      const res = await fetch(target, {
        method: 'GET',
        cache: 'no-store',
        mode: 'cors',
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        rtt = performance.now() - startT;
        playProbeTick();
      } else {
        dropped = true;
      }
    } catch (_) {
      dropped = true;
    }

    this.totalPings++;
    const nowTs = Date.now();

    if (dropped) {
      this.droppedPings++;
      this.history.push({ ts: nowTs, rtt: null, dropped: true });
      this.logAnomaly('DROP', 'Packet timed out / connection dropped (>2000ms)');
    } else {
      this.sumPing += rtt;
      if (rtt < this.minPing) this.minPing = rtt;
      if (rtt > this.maxPing) this.maxPing = rtt;

      // Spike detection: if rtt > 120ms or > 2.5x the rolling average
      const avg = this.sumPing / (this.totalPings - this.droppedPings);
      if (rtt > 120 || (this.totalPings > 5 && rtt > avg * 2.2)) {
        this.logAnomaly('SPIKE', `High latency spike: ${fmtMs(rtt)} ms (baseline ~${fmtMs(avg)} ms)`);
      }
      this.history.push({ ts: nowTs, rtt, dropped: false });
    }

    if (this.history.length > this.maxPoints) {
      this.history.shift();
    }

    this.updateStats(rtt, dropped);
    this.draw();

    if (this.running) {
      this.timer = setTimeout(() => this.probe(), 1500);
    }
  }

  logAnomaly(type, msg) {
    const timeStr = new Date().toLocaleTimeString();
    const item = { time: timeStr, type, msg };
    this.logs.unshift(item);
    if (this.logs.length > 50) this.logs.pop();

    if (!this.listEl) return;
    const empty = this.listEl.querySelector('.monitor-empty');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = `monitor-log-item log-${type.toLowerCase()}`;
    row.innerHTML = `
      <span class="log-badge badge-${type.toLowerCase()}">${type}</span>
      <span class="log-time">${timeStr}</span>
      <span class="log-msg">${msg}</span>
    `;
    this.listEl.prepend(row);
  }

  updateStats(latestRtt, dropped) {
    if (!this.statsEl) return;
    const validRtts = this.history.filter((h) => !h.dropped && h.rtt != null).map((h) => h.rtt);
    const avg = validRtts.length ? this.sumPing / (this.totalPings - this.droppedPings) : 0;
    const jitter = validRtts.length > 1 ? meanAbsDiff(validRtts) : 0;
    const lossPct = this.totalPings ? ((this.droppedPings / this.totalPings) * 100).toFixed(1) : '0.0';
    const curText = dropped ? 'TIMEOUT' : (latestRtt != null ? `${fmtMs(latestRtt)} ms` : '—');

    this.statsEl.innerHTML = `
      <div class="stat-pill"><span class="pill-lbl">CURRENT</span><span class="pill-val">${curText}</span></div>
      <div class="stat-pill"><span class="pill-lbl">MIN</span><span class="pill-val">${this.minPing < Infinity ? fmtMs(this.minPing) + ' ms' : '—'}</span></div>
      <div class="stat-pill"><span class="pill-lbl">AVG</span><span class="pill-val">${avg ? fmtMs(avg) + ' ms' : '—'}</span></div>
      <div class="stat-pill"><span class="pill-lbl">MAX</span><span class="pill-val">${this.maxPing ? fmtMs(this.maxPing) + ' ms' : '—'}</span></div>
      <div class="stat-pill"><span class="pill-lbl">JITTER</span><span class="pill-val">${jitter ? fmtMs(jitter) + ' ms' : '—'}</span></div>
      <div class="stat-pill"><span class="pill-lbl">DROPS</span><span class="pill-val ${this.droppedPings > 0 ? 'text-warn' : ''}">${this.droppedPings} (${lossPct}%)</span></div>
    `;
  }

  draw() {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, w, h);

    // Background grid
    ctx.strokeStyle = 'rgba(148, 178, 224, 0.08)';
    ctx.lineWidth = 1 * dpr;
    const gridLines = 4;
    for (let i = 1; i < gridLines; i++) {
      const y = (h / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (this.history.length < 2) return;

    // Find scale ceiling
    const valid = this.history.filter((d) => !d.dropped && d.rtt != null).map((d) => d.rtt);
    const maxVal = Math.max(100, ...valid) * 1.15;

    const stepX = w / (this.maxPoints - 1);
    const offsetX = (this.maxPoints - this.history.length) * stepX;

    // Draw trace path
    ctx.beginPath();
    let started = false;

    for (let i = 0; i < this.history.length; i++) {
      const pt = this.history[i];
      const x = offsetX + i * stepX;
      if (pt.dropped || pt.rtt == null) {
        // Red drop marker
        ctx.fillStyle = '#D03B3B';
        ctx.fillRect(x - 2 * dpr, 0, 4 * dpr, h);
        started = false;
        continue;
      }

      const y = h - (pt.rtt / maxVal) * (h - 20 * dpr) - 10 * dpr;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.strokeStyle = '#BE861A'; // latency amber
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Pulse dot on latest point
    const lastPt = this.history[this.history.length - 1];
    if (lastPt && !lastPt.dropped && lastPt.rtt != null) {
      const lx = w - 1;
      const ly = h - (lastPt.rtt / maxVal) * (h - 20 * dpr) - 10 * dpr;
      ctx.fillStyle = '#F0B429';
      ctx.beginPath();
      ctx.arc(lx - 2 * dpr, ly, 4 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  exportCsv() {
    if (!this.history.length) return;
    let csv = 'Timestamp,ISO_Time,RTT_ms,Status\n';
    this.history.forEach((h) => {
      const iso = new Date(h.ts).toISOString();
      csv += `${h.ts},"${iso}",${h.dropped ? '' : (h.rtt?.toFixed(2) || '')},${h.dropped ? 'DROPPED' : 'OK'}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SpeedUndo_PingPulse_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
