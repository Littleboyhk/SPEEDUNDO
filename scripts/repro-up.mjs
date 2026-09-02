// Reproduces engine.js throughputPhase('up') against the LIVE Worker:
// 4 parallel streams, 8 MiB blobs, 15 s window, credit bytes ONLY on a
// completed 2xx response, abort in-flight requests at the deadline (no credit).
// Prints total credited bytes + mbps — mimicking exactly what the browser does.
const URL = 'https://speedundo.hk2704331.workers.dev/up';
const UP_STREAMS = 4;
const UP_WINDOW_MS = 15000;
const UP_BLOB_BYTES = (Number(process.argv[2]) || 8) * 1024 * 1024;

const blob = new Uint8Array(UP_BLOB_BYTES); // zeros are fine for timing
let credited = 0;
let completed = 0;
let deadlineAborted = 0;
let failed = 0;

const start = Date.now();
const deadline = start + UP_WINDOW_MS;

async function one() {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), remaining);
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: blob,
      signal: ac.signal,
    });
    const j = await res.json();
    if (res.ok) { credited += (j.received ?? blob.byteLength); completed++; }
    else failed++;
  } catch (e) {
    if (ac.signal.aborted) deadlineAborted++;
    else failed++;
  } finally {
    clearTimeout(timer);
  }
}

async function worker() {
  while (Date.now() < deadline) await one();
}

const t0 = Date.now();
await Promise.allSettled(Array.from({ length: UP_STREAMS }, worker));
const durSec = (Date.now() - t0) / 1000;
const mbps = credited > 0 ? (credited * 8) / durSec / 1e6 : 0;

console.log(JSON.stringify({
  completedRequests: completed,
  deadlineAborted,
  failed,
  creditedBytes: credited,
  durSec: +durSec.toFixed(2),
  mbps: +mbps.toFixed(2),
}, null, 2));
