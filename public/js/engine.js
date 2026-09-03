// Measurement engine. Phases: meta → ping → download → upload → loss → done.
// Emits UI-agnostic events; owns all network activity and the math.
//
// Throughput method: N parallel streams against the test target for a fixed
// 15 s window, bytes counted continuously, sampled every 100 ms. The reported
// figure is total bytes over the window with the TCP ramp (first 1.5 s)
// excluded. Mbps are decimal (bytes × 8 / 1e6), matching how ISPs advertise.
//
// Resilience (the test must complete on real-world networks everywhere):
// dropped ping probes are retried, streams survive transient errors with a
// short backoff, and every phase runs under a watchdog signal so a hung
// socket can never wedge the test.

import { median, meanAbsDiff } from './format.js';
import { detectIsp } from './geo.js';
import { measurePacketLoss } from './rtc.js';
import { discoverMlabServer, measureMlabPing, runMlabDownload, runMlabUpload } from './ndt7.js';

export const SERVERS = [
  {
    id: 'auto',
    label: '⚡ Auto (Optimal & Lowest Latency)',
    hasMeta: true,
    internet: true,
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Global Edge (330+ Cities · Anycast)',
    ping: () => 'https://speed.cloudflare.com/__down?bytes=0',
    down: (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`,
    up: 'https://speed.cloudflare.com/__up',
    hasMeta: true,
    internet: true,
  },
  {
    id: 'mlab',
    label: 'Google / M-Lab NDT7 (Global Transit & ISPs)',
    hasMeta: true,
    internet: true,
    protocol: 'ndt7',
  },
  {
    id: 'tokyo',
    label: 'Tokyo, Japan (A573 · Asia-Pacific 10G)',
    ping: 'https://librespeed.a573.net/backend/empty.php?cors=true',
    down: (bytes) => `https://librespeed.a573.net/backend/garbage.php?cors=true&ckSize=${Math.max(1, Math.min(50, Math.round(bytes / 1048576)))}`,
    up: 'https://librespeed.a573.net/backend/empty.php?cors=true',
    hasMeta: false,
    internet: true,
  },
  {
    id: 'london',
    label: 'London, UK (Clouvider 10G · Europe)',
    ping: 'https://lon.speedtest.clouvider.net/backend/empty.php?cors=true',
    down: (bytes) => `https://lon.speedtest.clouvider.net/backend/garbage.php?cors=true&ckSize=${Math.max(1, Math.min(50, Math.round(bytes / 1048576)))}`,
    up: 'https://lon.speedtest.clouvider.net/backend/empty.php?cors=true',
    hasMeta: false,
    internet: true,
  },
  {
    id: 'us-west',
    label: 'Los Angeles, USA (Sharktech 10G · North America West)',
    ping: 'https://laxspeed.sharktech.net/backend/empty.php?cors=true',
    down: (bytes) => `https://laxspeed.sharktech.net/backend/garbage.php?cors=true&ckSize=${Math.max(1, Math.min(50, Math.round(bytes / 1048576)))}`,
    up: 'https://laxspeed.sharktech.net/backend/empty.php?cors=true',
    hasMeta: false,
    internet: true,
  },
  {
    id: 'us-midwest',
    label: 'Chicago, USA (Sharktech 10G · North America Central)',
    ping: 'https://chispeed.sharktech.net/backend/empty.php?cors=true',
    down: (bytes) => `https://chispeed.sharktech.net/backend/garbage.php?cors=true&ckSize=${Math.max(1, Math.min(50, Math.round(bytes / 1048576)))}`,
    up: 'https://chispeed.sharktech.net/backend/empty.php?cors=true',
    hasMeta: false,
    internet: true,
  },
  {
    id: 'local',
    label: 'This server (Local LAN / Router Benchmark)',
    ping: () => '/down?bytes=0',
    down: (bytes) => `/down?bytes=${bytes}`,
    up: '/up',
    hasMeta: false,
    internet: false,
  },
];

export async function autoSelectBestServer(opts = {}) {
  const signal = opts.signal;
  // Probe top global edge candidates in parallel with 2.5s timeout
  const candidates = [
    SERVERS.find((s) => s.id === 'cloudflare'),
    SERVERS.find((s) => s.id === 'mlab'),
    SERVERS.find((s) => s.id === 'tokyo'),
    SERVERS.find((s) => s.id === 'london'),
    SERVERS.find((s) => s.id === 'us-west'),
  ].filter(Boolean);

  const probes = candidates.map(async (srv) => {
    const t0 = performance.now();
    try {
      if (srv.id === 'mlab') {
        const mServer = await discoverMlabServer({ signal, timeoutMs: 2200 });
        const pingMs = await measureMlabPing(mServer, { signal });
        const rtt = pingMs?.ping || (performance.now() - t0);
        return { srv, rtt };
      }
      const pingUrl = typeof srv.ping === 'function' ? srv.ping() : (srv.ping || srv.down(0));
      const child = signal ? AbortSignal.any([signal, AbortSignal.timeout(2200)]) : AbortSignal.timeout(2200);
      const res = await fetch(pingUrl, { cache: 'no-store', signal: child });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { srv, rtt: performance.now() - t0 };
    } catch (_) {
      return { srv, rtt: Infinity };
    }
  });

  const results = await Promise.all(probes);
  const valid = results.filter((r) => Number.isFinite(r.rtt) && r.rtt < Infinity).sort((a, b) => a.rtt - b.rtt);
  return valid.length ? valid[0] : { srv: candidates[0], rtt: null };
}

const PING_COUNT = 10;
const PING_MAX_ATTEMPTS = 14;   // lossy networks may drop a few probes
const PING_TIMEOUT_MS = 5000;
const DOWN_STREAMS = 5;
const DOWN_WINDOW_MS = 15000;   // ≥15 s steady sampling for a stable figure
const DOWN_REQUEST_BYTES = 25_000_000;
const UP_STREAMS = 4;
const UP_WINDOW_MS = 15000;
// 1 MiB per request (was 8 MiB). Upload bytes are credited only when a request
// completes within the window; a single 8 MiB blob across 4 parallel streams
// needs a ~17 Mbps uplink just to finish ONE request in 15 s, so slower (or
// asymmetric) links credited zero and the phase failed with "No data moved".
// 1 MiB completes many times over even on ~2 Mbps up, giving reliable, more
// accurate crediting. (Loopback/local dev hid this — it has ~infinite uplink.)
const UP_BLOB_BYTES = 1 * 1024 * 1024;
const SAMPLE_MS = 100;
const RAMP_SEC = 1.5;
const LOADED_PING_GAP_MS = 750;
const PHASE_SETTLE_MS = 300;
const STREAM_RETRY_MS = 400;    // backoff after a transient stream error
const PHASE_GRACE_MS = 4000;    // watchdog: reap sockets hung past the window
// Headline = mean of the per-second steady-state rates (post TCP ramp), not a
// byte/time average. A byte/time average drifts for the whole window when the
// link is still warming up or gently throttling (the "number won't settle"
// complaint); averaging per-second rates converges on the achieved rate — the
// number the line is actually sustaining, like speedtest.net reports.
const STEADY_SAMPLE_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomBlob(size) {
  const buf = new Uint8Array(size);
  const step = 65536; // crypto.getRandomValues per-call cap
  for (let o = 0; o < size; o += step) {
    crypto.getRandomValues(buf.subarray(o, Math.min(o + step, size)));
  }
  // text/plain keeps cross-origin POSTs "simple" (no CORS preflight),
  // which the public speed-test endpoints are not guaranteed to answer.
  return new Blob([buf], { type: 'text/plain' });
}

class PhaseError extends Error {
  constructor(phase, message) {
    super(message);
    this.phase = phase;
  }
}

export class SpeedTest {
  /**
   * @param {object} server  entry from SERVERS
   * @param {object} on      callbacks: phase(name), ping(ms, i, n),
   *   sample(kind, tSec, mbps), live(kind, mbps), meta(obj), done(result),
   *   error(err), aborted()
   */
  constructor(server, on = {}) {
    this.server = server;
    this.on = on;
    this.ctrl = new AbortController();
    this.running = false;
  }

  abort() {
    this.ctrl.abort();
  }

  get signal() {
    return this.ctrl.signal;
  }

  emit(name, ...args) {
    if (typeof this.on[name] === 'function') this.on[name](...args);
  }

  // A child AbortSignal that fires on user abort OR after timeoutMs. Lets a
  // single hung request (common on flaky mobile links) die without taking the
  // whole test down, while user aborts still propagate instantly.
  childSignal(timeoutMs) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    this.signal.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    return {
      signal: ctrl.signal,
      abort: () => ctrl.abort(),
      release: () => {
        if (timer) clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
      },
    };
  }

  async run() {
    if (this.running) return;
    this.running = true;
    const result = {
      ts: Date.now(),
      server: this.server.id,
      selectedServerId: this.server.id,
      autoServer: false,
      autoRtt: null,
      ping: null, jitter: null,
      down: null, downPeak: null, downBytes: 0, downDur: 0,
      up: null, upPeak: null, upBytes: 0, upDur: 0,
      loadedRtt: null,
      loss: null, lossSent: 0, lossReceived: 0, lossMethod: null,
      meta: null,
      geo: null, // {isp, asn, city, region, country, postal} from geo.js
    };
    try {
      if (this.server.id === 'auto') {
        this.emit('phase', 'meta');
        const autoResult = await autoSelectBestServer({ signal: this.signal });
        if (autoResult?.srv) {
          this.server = autoResult.srv;
          result.selectedServerId = autoResult.srv.id;
          result.autoServer = true;
          result.autoRtt = autoResult.rtt;
          this.emit('server_selected', autoResult.srv, autoResult.rtt);
        }
      }

      // ISP/city lookup runs alongside the whole test; awaited before 'done'.
      const geoPromise = detectIsp({ signal: this.signal })
        .then((g) => { if (g) this.emit('isp', g); return g; })
        .catch(() => null);

      if (this.server.protocol === 'ndt7') {
        return await this.runNdt7(result, geoPromise);
      }
      return await this.runHttp(result, geoPromise);
    } catch (err) {
      if (this.signal.aborted || err?.name === 'AbortError') {
        this.emit('aborted');
      } else {
        this.emit('error', err, err instanceof PhaseError ? err.phase : null);
      }
      return null;
    } finally {
      this.running = false;
    }
  }

  // ---- HTTP / Cloudflare protocol runner ----------------------------------

  async runHttp(result, geoPromise) {
    this.emit('phase', 'meta');
    result.meta = await this.fetchMeta();
    if (result.meta) this.emit('meta', result.meta);

    this.emit('phase', 'ping');
    const { ping, jitter } = await this.pingPhase();
    result.ping = ping;
    result.jitter = jitter;

    await sleep(PHASE_SETTLE_MS);
    this.emit('phase', 'download');
    const down = await this.throughputPhase('down');
    Object.assign(result, {
      down: down.mbps, downPeak: down.peak,
      downBytes: down.bytes, downDur: down.dur,
      loadedRtt: down.loadedRtt,
    });

    await sleep(PHASE_SETTLE_MS);
    this.emit('phase', 'upload');
    const up = await this.throughputPhase('up');
    Object.assign(result, {
      up: up.mbps, upPeak: up.peak, upBytes: up.bytes, upDur: up.dur,
    });

    if (this.server.internet) {
      this.emit('phase', 'loss');
      const loss = await measurePacketLoss({ signal: this.signal });
      if (loss) {
        result.loss = Math.round(loss.lossPct * 100) / 100;
        result.lossSent = loss.sent;
        result.lossReceived = loss.received;
        result.lossMethod = 'webrtc';
        this.emit('loss', { ...loss, method: 'webrtc' });
      } else {
        this.emit('loss', null);
      }
    }

    result.geo = await geoPromise;
    this.emit('phase', 'done');
    this.emit('done', result);
    return result;
  }

  // ---- M-Lab NDT7 protocol runner -----------------------------------------

  async runNdt7(result, geoPromise) {
    try {
      this.emit('phase', 'meta');
      const mlabServer = await discoverMlabServer({ signal: this.signal });
      result.meta = {
        colo: mlabServer.city,
        city: mlabServer.city,
        country: mlabServer.country,
        machine: mlabServer.machine,
        serverName: `M-Lab (${mlabServer.city})`,
      };
      if (result.meta) this.emit('meta', result.meta);

      this.emit('phase', 'ping');
      const { ping, jitter } = await measureMlabPing(mlabServer, {
        emit: this.emit.bind(this),
        signal: this.signal,
      });
      result.ping = ping;
      result.jitter = jitter;

      await sleep(PHASE_SETTLE_MS);
      this.emit('phase', 'download');
      const down = await runMlabDownload(mlabServer, {
        emit: this.emit.bind(this),
        signal: this.signal,
      });
      Object.assign(result, {
        down: down.mbps,
        downPeak: down.peak,
        downBytes: down.bytes,
        downDur: down.dur,
        loadedRtt: down.loadedRtt,
      });

      await sleep(PHASE_SETTLE_MS);
      this.emit('phase', 'upload');
      const up = await runMlabUpload(mlabServer, {
        emit: this.emit.bind(this),
        signal: this.signal,
        streams: UP_STREAMS,
      });
      Object.assign(result, {
        up: up.mbps,
        upPeak: up.peak,
        upBytes: up.bytes,
        upDur: up.dur,
      });

      // Packet loss: prefer TCPInfo retransmit metric if reported, otherwise relay
      if (down.loss != null) {
        result.loss = Math.round(down.loss * 100) / 100;
        result.lossMethod = 'tcp_info';
        this.emit('loss', { lossPct: result.loss, method: 'tcp_info' });
      } else if (this.server.internet) {
        this.emit('phase', 'loss');
        const loss = await measurePacketLoss({ signal: this.signal });
        if (loss) {
          result.loss = Math.round(loss.lossPct * 100) / 100;
          result.lossSent = loss.sent;
          result.lossReceived = loss.received;
          result.lossMethod = 'webrtc';
          this.emit('loss', { ...loss, method: 'webrtc' });
        } else {
          this.emit('loss', null);
        }
      }

      result.geo = await geoPromise;
      this.emit('phase', 'done');
      this.emit('done', result);
      return result;
    } catch (err) {
      if (this.signal.aborted || err?.name === 'AbortError') throw err;
      console.warn('M-Lab endpoint rate limited or unavailable, falling back to Cloudflare edge:', err);
      // Seamlessly fall back to Cloudflare edge so the test succeeds
      const cfServer = SERVERS.find((s) => s.id === 'cloudflare') || SERVERS[1];
      this.server = cfServer;
      result.server = 'cloudflare';
      return await this.runHttp(result, geoPromise);
    }
  }

  // ---- meta ---------------------------------------------------------------

  async fetchMeta() {
    try {
      const res = await fetch(this.server.down(0), {
        cache: 'no-store', signal: this.signal,
      });
      const h = res.headers;
      const grab = (...names) => {
        for (const n of names) { const v = h.get(n); if (v) return v; }
        return null;
      };
      const meta = {
        ip: grab('cf-meta-ip'),
        colo: grab('cf-meta-colo', 'colo'),
        city: grab('cf-meta-city', 'city'),
        country: grab('cf-meta-country', 'country'),
        asn: grab('cf-meta-asn', 'asn'),
      };
      return Object.values(meta).some(Boolean) ? meta : null;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // Metadata is cosmetic — if even this failed, the ping phase will
      // produce the real, actionable error.
      return null;
    }
  }

  // ---- latency ------------------------------------------------------------

  async pingOnce(timeoutMs) {
    const child = timeoutMs ? this.childSignal(timeoutMs) : null;
    const t0 = performance.now();
    try {
      const pingUrl = typeof this.server.ping === 'function'
        ? this.server.ping()
        : (this.server.ping || this.server.down(0));
      const res = await fetch(pingUrl, {
        cache: 'no-store', signal: child ? child.signal : this.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.arrayBuffer();
      return performance.now() - t0;
    } finally {
      child?.release();
    }
  }

  async pingPhase() {
    const samples = [];
    let attempts = 0;
    // Lossy links drop probes; keep going until we have enough clean samples
    // or the attempt budget runs out. Only give up when nothing gets through.
    while (samples.length < PING_COUNT && attempts < PING_MAX_ATTEMPTS) {
      if (this.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      attempts++;
      let ms;
      try {
        ms = await this.pingOnce(PING_TIMEOUT_MS);
      } catch (err) {
        if (this.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        continue;
      }
      samples.push(ms);
      // First sample carries connection + TLS setup; report progress with it
      // but keep it out of the statistics.
      const kept = samples.length > 1 ? samples.slice(1) : samples;
      this.emit('ping', median(kept), samples.length, PING_COUNT);
    }
    const kept = samples.length > 1 ? samples.slice(1) : samples;
    if (!kept.length) {
      throw new PhaseError('ping', 'The test server did not respond.');
    }
    return { ping: median(kept), jitter: meanAbsDiff(kept) };
  }

  // ---- throughput (shared by download & upload) ----------------------------

  async throughputPhase(kind) {
    const isDown = kind === 'down';
    const windowMs = isDown ? DOWN_WINDOW_MS : UP_WINDOW_MS;
    const streams = isDown ? DOWN_STREAMS : UP_STREAMS;

    let bytes = 0;
    let lastByteAt = 0; // performance.now() when the most recent bytes were credited
    const counter = { add: (n) => { bytes += n; lastByteAt = performance.now(); } };
    const start = performance.now();
    const deadline = start + windowMs;
    const samples = []; // {t, v, cum} at ~100 ms cadence
    // Watchdog: everything in this phase dies at window + grace, so one
    // stalled socket (frozen mobile link, mid-test network change) can't hang
    // the test forever. User abort propagates through the same signal.
    const phase = this.childSignal(windowMs + PHASE_GRACE_MS);
    const lastErr = { message: null };

    let ema = 0;
    const sampler = setInterval(() => {
      const now = performance.now();
      const t = (now - start) / 1000;
      samples.push({ t, cum: bytes });

      // 400ms sliding window prevents momentary ACK pauses from causing needle oscillation
      const ref = samples[Math.max(0, samples.length - 5)] || { t: 0, cum: 0 };
      const dt = t - ref.t;
      if (dt <= 0) return;
      const v = ((bytes - ref.cum) * 8) / dt / 1e6;
      ema = ema === 0 ? v : ema + 0.18 * (v - ema);
      this.emit('sample', kind, t, v);
      this.emit('live', kind, ema);
    }, SAMPLE_MS);

    // Loaded-latency probe rides along with the download phase only.
    const loaded = [];
    const loadedProbe = isDown ? (async () => {
      await sleep(1000); // let the streams saturate first
      while (performance.now() < deadline - 400 && !this.signal.aborted) {
        try { loaded.push(await this.pingOnce(PING_TIMEOUT_MS)); } catch (_) { break; }
        await sleep(LOADED_PING_GAP_MS);
      }
    })() : Promise.resolve();

    const workers = [];
    for (let i = 0; i < streams; i++) {
      workers.push(isDown
        ? this.downStream(counter, deadline, phase.signal, lastErr)
        : this.upStream(counter, deadline, phase.signal, lastErr));
    }
    await Promise.allSettled(workers);
    clearInterval(sampler);
    await loadedProbe.catch(() => {});
    phase.release();
    if (this.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const end = performance.now();
    if (bytes === 0) {
      throw new PhaseError(isDown ? 'download' : 'upload',
        lastErr.message || 'No data moved during the test window.');
    }
    // Upload credits bytes only when the server confirms receipt (on response),
    // so the window can close with an in-flight request whose time we must not
    // count against zero bytes. Measure to the last confirmed byte. For
    // download, bytes are counted continuously so lastByteAt ≈ the deadline —
    // no change in behaviour there.
    const dur = ((bytes > 0 ? lastByteAt : end) - start) / 1000;

    // Steady-state headline: compute sustained rate across the post-ramp window.
    // Measuring cumulative bytes moved over the steady duration eliminates TCP window
    // oscillation and steppy chunk-completion artifacts.
    const rampSec = Math.min(RAMP_SEC, dur * 0.3);
    const rampSample = samples.find((s) => s.t >= rampSec) || samples[0];
    const lastSample = samples[samples.length - 1];
    let mbps;
    if (lastSample && rampSample && lastSample.t > rampSample.t && lastSample.cum > rampSample.cum) {
      mbps = ((lastSample.cum - rampSample.cum) * 8) / (lastSample.t - rampSample.t) / 1e6;
    } else {
      mbps = (bytes * 8) / dur / 1e6;
    }

    // Peak rate calculated over rolling 500 ms window
    let peak = mbps;
    for (let i = 5; i < samples.length; i++) {
      const a = samples[i - 5];
      const b = samples[i];
      const dt = b.t - a.t;
      if (dt > 0) {
        const rate = ((b.cum - a.cum) * 8) / dt / 1e6;
        if (rate > peak) peak = rate;
      }
    }

    // TCP packet-loss fallback was removed: it ran an 8 s post-phase download
    // (a hidden extra transfer after the download window), which polluted the
    // trace and delayed upload. Packet loss already has the WebRTC primary;
    // when that is unavailable we simply report loss as unavailable rather
    // than burn another multi-second transfer on a degraded TCP estimate.
    return {
      mbps, peak: peak || mbps, bytes, dur, tcp: null,
      loadedRtt: loaded.length ? median(loaded) : null,
    };
  }

  // A stream survives transient errors: one failed request logs the reason,
  // backs off briefly, and tries again while the window is open — a single
  // hiccup on a flaky link no longer kills a whole stream (or the phase).
  async downStream(counter, deadline, phaseSignal, lastErr) {
    while (performance.now() < deadline && !phaseSignal.aborted) {
      try {
        const res = await fetch(this.server.down(DOWN_REQUEST_BYTES), {
          cache: 'no-store', signal: phaseSignal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            counter.add(value.byteLength);
            if (performance.now() >= deadline) {
              await reader.cancel();
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        if (phaseSignal.aborted) return;
        lastErr.message = err?.message || 'Network error.';
        await sleep(STREAM_RETRY_MS);
      }
    }
  }

  upStream(counter, deadline, phaseSignal, lastErr) {
    // One blob is generated lazily and shared across all requests.
    if (!this._blob) this._blob = randomBlob(UP_BLOB_BYTES);
    const url = this.server.up;
    const blob = this._blob;

    // Bytes are credited only when the server RESPONDS — i.e. after it has
    // drained the whole body — so the figure is authoritative and can never run
    // ahead of what the receiver actually got. (The old path counted
    // xhr.upload.onprogress e.loaded, i.e. bytes buffered into the local OS
    // socket, which inflated upload speed on fast links.) A request still in
    // flight when the window closes is aborted and contributes nothing.
    const one = () => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let deadlineHit = false;
      xhr.open('POST', url, true);
      const onAbort = () => xhr.abort();
      const timer = setTimeout(() => {
        deadlineHit = true;
        xhr.abort();
      }, Math.max(0, deadline - performance.now()));
      xhr.onloadend = () => {
        clearTimeout(timer);
        phaseSignal.removeEventListener('abort', onAbort);
        if (phaseSignal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        if (deadlineHit) { resolve(); return; } // window closed mid-send — unconfirmed
        if (xhr.status >= 200 && xhr.status < 400) {
          // Prefer the server's own received-byte count; fall back to the blob
          // size (a 2xx means the whole body was received either way).
          let received = blob.size;
          try {
            const j = JSON.parse(xhr.responseText);
            if (j && Number.isFinite(j.received)) received = j.received;
          } catch (_) { /* non-JSON body (e.g. CF __up) → use blob size */ }
          counter.add(received);
          resolve();
        } else {
          reject(new Error(`Upload failed (${xhr.status || 'network error'})`));
        }
      };
      phaseSignal.addEventListener('abort', onAbort, { once: true });
      xhr.send(blob);
    });

    return (async () => {
      while (performance.now() < deadline && !phaseSignal.aborted) {
        try {
          await one();
        } catch (err) {
          if (phaseSignal.aborted) return;
          lastErr.message = err?.message || 'Network error.';
          await sleep(STREAM_RETRY_MS);
        }
      }
    })();
  }
}
