// M-Lab NDT7 measurement engine module.
// Implements M-Lab Locate API v2 + NDT7 WebSocket protocol (net.measurementlab.ndt.v7).
// Zero external dependencies — runs natively in all modern browsers.

import { median, meanAbsDiff } from './format.js';

const NDT7_SUBPROTOCOL = 'net.measurementlab.ndt.v7';
const LOCATE_URL = 'https://locate.measurementlab.net/v2/nearest/ndt/ndt7';
const SAMPLE_MS = 100;
const RAMP_SEC = 1.5;
const TEST_DURATION_MS = 10000; // 10 seconds per phase (standard NDT7 duration)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomBuffer(size) {
  const buf = new Uint8Array(size);
  const step = 65536;
  for (let o = 0; o < size; o += step) {
    crypto.getRandomValues(buf.subarray(o, Math.min(o + step, size)));
  }
  return buf.buffer;
}

let cachedMlabServer = null;
let cachedMlabAt = 0;

/**
 * Validate that the M-Lab JWT access token in the URL is still unexpired.
 * Tokens typically expire in ~10 minutes.
 */
function isTokenValid(url) {
  if (!url) return false;
  try {
    const params = new URL(url).searchParams;
    const token = params.get('access_token');
    if (!token) return false;
    let b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const jsonStr = (typeof atob !== 'undefined') ? atob(b64) : Buffer.from(b64, 'base64').toString();
    const payload = JSON.parse(jsonStr);
    // Token must have at least 45 seconds of life left
    return Boolean(payload.exp && (payload.exp - Math.floor(Date.now() / 1000) > 45));
  } catch (_) {
    return false;
  }
}

function getStoredMlabServer() {
  try {
    const raw = sessionStorage.getItem('speedundo.mlab_server');
    if (!raw) return null;
    const { server } = JSON.parse(raw);
    if (server && isTokenValid(server.downloadUrl)) return server;
    sessionStorage.removeItem('speedundo.mlab_server');
  } catch (_) {}
  return null;
}

function setStoredMlabServer(server) {
  try {
    sessionStorage.setItem('speedundo.mlab_server', JSON.stringify({ server, ts: Date.now() }));
  } catch (_) {}
}

/**
 * Discover the nearest M-Lab server via Locate API v2.
 * Caches server metadata to avoid hammering the M-Lab Locate API (which triggers HTTP 429).
 */
export async function discoverMlabServer({ signal } = {}) {
  // Check memory cache
  if (cachedMlabServer && isTokenValid(cachedMlabServer.downloadUrl)) {
    return cachedMlabServer;
  }
  // Check session storage cache
  const stored = getStoredMlabServer();
  if (stored) {
    cachedMlabServer = stored;
    cachedMlabAt = Date.now();
    return stored;
  }

  let res;
  try {
    res = await fetch(LOCATE_URL, {
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (stored) return stored;
    throw err;
  }

  // Handle M-Lab rate-limit (HTTP 429)
  if (res.status === 429) {
    throw new Error('M-Lab Locate API rate limit reached (HTTP 429).');
  }

  if (!res.ok) throw new Error(`M-Lab Locate API failed: HTTP ${res.status}`);
  const json = await res.json();
  const results = json.results || [];
  if (!results.length) throw new Error('No available M-Lab servers found nearby.');

  // Pick first (nearest) server result
  const s = results[0];
  const dlUrl = s.urls?.['wss:///ndt/v7/download'] || s.urls?.['ws:///ndt/v7/download'];
  const upUrl = s.urls?.['wss:///ndt/v7/upload'] || s.urls?.['ws:///ndt/v7/upload'];

  if (!dlUrl || !upUrl) {
    throw new Error('M-Lab Locate API did not return valid NDT7 endpoints.');
  }

  const server = {
    machine: s.machine || s.hostname,
    city: s.location?.city || 'Nearby Edge',
    country: s.location?.country || '',
    downloadUrl: dlUrl,
    uploadUrl: upUrl,
    raw: s,
  };

  cachedMlabServer = server;
  cachedMlabAt = Date.now();
  setStoredMlabServer(server);

  return server;
}

/**
 * Quick ping and jitter measurement.
 * Uses a zero-rate-limit CORS endpoint to measure true client-to-edge latency
 * without exhausting M-Lab's strict Locate API quota.
 */
export async function measureMlabPing(server, { emit, signal }) {
  const samples = [];
  const PING_PROBES = 6;
  const probeUrl = 'https://speed.cloudflare.com/__down?bytes=0';

  for (let i = 0; i < PING_PROBES; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const t0 = performance.now();
    try {
      const res = await fetch(`${probeUrl}&_p=${Date.now()}_${i}`, {
        cache: 'no-store',
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.arrayBuffer();
      const rtt = performance.now() - t0;
      samples.push(rtt);
      const kept = samples.length > 1 ? samples.slice(1) : samples;
      emit?.('ping', median(kept), samples.length, PING_PROBES);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
    }
    await sleep(60);
  }

  const kept = samples.length > 1 ? samples.slice(1) : samples;
  if (!kept.length) {
    throw new Error('Could not reach network endpoint for latency measurement.');
  }
  return {
    ping: median(kept),
    jitter: meanAbsDiff(kept),
  };
}

/**
 * Execute NDT7 WebSocket Download test.
 */
export async function runMlabDownload(server, { emit, signal }) {
  return new Promise((resolve, reject) => {
    let ws = null;
    let sampler = null;
    let durationTimer = null;
    let settled = false;

    let totalBytes = 0;
    const start = performance.now();
    const samples = [];
    const rtts = [];
    let retrans = null;
    let segsOut = null;
    let ema = 0;

    const cleanup = () => {
      if (sampler) clearInterval(sampler);
      if (durationTimer) clearTimeout(durationTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(); } catch (_) {}
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();

      const end = performance.now();
      const dur = Math.max((end - start) / 1000, 0.1);

      if (totalBytes === 0) {
        return reject(new Error('No download data received from M-Lab server.'));
      }

      // Calculate steady-state Mbps excluding ramp-up
      const rampSec = Math.min(RAMP_SEC, dur * 0.3);
      const perSec = [];
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        if (b.t <= rampSec) continue;
        const dt = b.t - a.t;
        if (dt <= 0) continue;
        perSec.push(((b.cum - a.cum) * 8) / dt / 1e6);
      }

      const mbps = perSec.length
        ? perSec.reduce((sum, v) => sum + v, 0) / perSec.length
        : (totalBytes * 8 / dur / 1e6);
      const peak = perSec.length ? Math.max(...perSec) : mbps;
      const loadedRtt = rtts.length ? median(rtts) : null;
      const loss = (retrans != null && segsOut > 0) ? (retrans / segsOut) * 100 : null;

      resolve({
        mbps,
        peak,
        bytes: totalBytes,
        dur,
        loadedRtt,
        loss,
      });
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      ws = new WebSocket(server.downloadUrl, NDT7_SUBPROTOCOL);
      ws.binaryType = 'arraybuffer';
    } catch (err) {
      cleanup();
      return reject(err);
    }

    ws.onopen = () => {
      // Start real-time 100ms sampler
      sampler = setInterval(() => {
        const now = performance.now();
        const t = (now - start) / 1000;
        samples.push({ t, cum: totalBytes });

        // 400ms sliding window for smooth, stable rate calculation
        const ref = samples[Math.max(0, samples.length - 5)] || { t: 0, cum: 0 };
        const dt = t - ref.t;
        if (dt <= 0) return;
        const v = ((totalBytes - ref.cum) * 8) / dt / 1e6;
        ema = ema === 0 ? v : ema + 0.2 * (v - ema);
        emit?.('sample', 'down', t, v);
        emit?.('live', 'down', ema);
      }, SAMPLE_MS);

      // Enforce 10s test duration if server doesn't close first
      durationTimer = setTimeout(() => {
        finish();
      }, TEST_DURATION_MS);
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const json = JSON.parse(event.data);
          if (json.TCPInfo) {
            if (json.TCPInfo.RTT) rtts.push(json.TCPInfo.RTT / 1000);
            if (json.TCPInfo.TotalRetrans != null) retrans = json.TCPInfo.TotalRetrans;
            if (json.TCPInfo.SegsOut != null) segsOut = json.TCPInfo.SegsOut;
          }
        } catch (_) {}
      } else {
        totalBytes += event.data.byteLength || event.data.size || 0;
      }
    };

    ws.onerror = (err) => {
      if (!settled && totalBytes === 0) {
        cleanup();
        reject(new Error('WebSocket connection to M-Lab failed.'));
      }
    };

    ws.onclose = () => {
      finish();
    };
  });
}

/**
 * Execute NDT7 WebSocket Upload test.
 */
export async function runMlabUpload(server, { emit, signal }) {
  return new Promise((resolve, reject) => {
    let ws = null;
    let sampler = null;
    let pumpTimer = null;
    let durationTimer = null;
    let settled = false;

    let totalSent = 0;
    let serverReportedBytes = 0;
    const start = performance.now();
    const samples = [];
    let ema = 0;

    // Steady 32 KB chunk size to avoid buffer burst spikes
    const CHUNK_SIZE = 32768;
    const TARGET_BUFFER = 256 * 1024;
    const chunk = randomBuffer(CHUNK_SIZE);

    const cleanup = () => {
      if (sampler) clearInterval(sampler);
      if (pumpTimer) clearTimeout(pumpTimer);
      if (durationTimer) clearTimeout(durationTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(); } catch (_) {}
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();

      const end = performance.now();
      const dur = Math.max((end - start) / 1000, 0.1);
      const effectiveBytes = serverReportedBytes || Math.max(totalSent - (ws ? ws.bufferedAmount : 0), 0);

      if (effectiveBytes === 0) {
        return reject(new Error('No upload data moved to M-Lab server.'));
      }

      // Calculate steady-state Mbps excluding ramp-up
      const rampSec = Math.min(RAMP_SEC, dur * 0.3);
      const perSec = [];
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        if (b.t <= rampSec) continue;
        const dt = b.t - a.t;
        if (dt <= 0) continue;
        perSec.push(((b.cum - a.cum) * 8) / dt / 1e6);
      }

      const mbps = perSec.length
        ? perSec.reduce((sum, v) => sum + v, 0) / perSec.length
        : (effectiveBytes * 8 / dur / 1e6);
      const peak = perSec.length ? Math.max(...perSec) : mbps;

      resolve({
        mbps,
        peak,
        bytes: effectiveBytes,
        dur,
      });
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      ws = new WebSocket(server.uploadUrl, NDT7_SUBPROTOCOL);
      ws.binaryType = 'arraybuffer';
    } catch (err) {
      cleanup();
      return reject(err);
    }

    // Keep WebSocket outgoing buffer steadily saturated (~256 KB)
    const pump = () => {
      if (settled || !ws || ws.readyState !== WebSocket.OPEN) return;
      while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < TARGET_BUFFER) {
        ws.send(chunk);
        totalSent += CHUNK_SIZE;
      }
      if (ws.readyState === WebSocket.OPEN) {
        pumpTimer = setTimeout(pump, 5);
      }
    };

    ws.onopen = () => {
      pump();

      // Start real-time 100ms sampler
      sampler = setInterval(() => {
        const now = performance.now();
        const t = (now - start) / 1000;
        // Continuous bytes sent onto the wire from the browser
        const onWire = Math.max(0, totalSent - ws.bufferedAmount);
        samples.push({ t, cum: onWire });

        // 400ms sliding window for steady, non-oscillating needle velocity
        const ref = samples[Math.max(0, samples.length - 5)] || { t: 0, cum: 0 };
        const dt = t - ref.t;
        if (dt <= 0) return;
        const v = ((onWire - ref.cum) * 8) / dt / 1e6;
        ema = ema === 0 ? v : ema + 0.2 * (v - ema);
        emit?.('sample', 'up', t, v);
        emit?.('live', 'up', ema);
      }, SAMPLE_MS);

      durationTimer = setTimeout(() => {
        finish();
      }, TEST_DURATION_MS);
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const json = JSON.parse(event.data);
          if (json.TCPInfo?.BytesReceived) {
            serverReportedBytes = json.TCPInfo.BytesReceived;
          } else if (json.AppInfo?.NumBytes) {
            serverReportedBytes = json.AppInfo.NumBytes;
          }
        } catch (_) {}
      }
    };

    ws.onerror = (err) => {
      if (!settled && totalSent === 0) {
        cleanup();
        reject(new Error('WebSocket upload connection to M-Lab failed.'));
      }
    };

    ws.onclose = () => {
      finish();
    };
  });
}
