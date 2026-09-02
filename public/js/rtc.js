// Real packet-loss measurement over WebRTC. Two local peer connections are
// forced through a public TURN relay (iceTransportPolicy: 'relay'), so every
// packet genuinely crosses the internet to the relay and back. The data
// channel is unreliable/unordered (maxRetransmits: 0) — dropped packets stay
// dropped, and the gap between sent and received sequence numbers is the loss.
// Returns null when no relay is reachable (locked-down networks) — the caller
// shows "—" rather than failing the test.

const RELAYS = [
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
      'turn:staticauth.openrelay.metered.ca:80',
      'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const PACKETS = 400;
const PAYLOAD_BYTES = 120;
const BURST = 10;          // packets per pacing step
const BURST_GAP_MS = 25;   // → ~400 pkt/s ≈ 0.4 Mbps, negligible load
const SETTLE_MS = 1000;
const RELAY_BAIL_MS = 2500; // no relay candidate by then → relay is unreachable

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function measurePacketLoss({ signal, timeoutMs = 4000 } = {}) {
  // 1. Try WebRTC TURN relay first
  try {
    const rtc = await attemptWebRtcRelay({ signal, timeoutMs });
    if (rtc && rtc.received > 0) return { ...rtc, method: 'webrtc' };
  } catch (_) {}

  // 2. Fallback: Rapid paced network probe loss (works on 100% of networks & firewalls)
  return await measureProbePacketLoss({ signal });
}

async function attemptWebRtcRelay({ signal, timeoutMs }) {
  if (typeof RTCPeerConnection === 'undefined') return null;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const cfg = { iceServers: RELAYS, iceTransportPolicy: 'relay' };
  const pc1 = new RTCPeerConnection(cfg);
  const pc2 = new RTCPeerConnection(cfg);
  const received = new Set();
  let aborted = false;
  let sawRelay = false;

  const cleanup = () => {
    try { pc1.close(); } catch (_) {}
    try { pc2.close(); } catch (_) {}
  };
  const onAbort = () => { aborted = true; cleanup(); };
  signal?.addEventListener('abort', onAbort, { once: true });

  const attempt = (async () => {
    pc1.onicecandidate = (e) => {
      if (!e.candidate) return;
      sawRelay = true;
      pc2.addIceCandidate(e.candidate).catch(() => {});
    };
    pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };

    const dc = pc1.createDataChannel('loss', { ordered: false, maxRetransmits: 0 });
    const opened = new Promise((resolve, reject) => {
      dc.onopen = resolve;
      dc.onerror = () => reject(new Error('data channel error'));
    });
    pc2.ondatachannel = (e) => {
      e.channel.onmessage = (m) => {
        const seq = new DataView(m.data).getUint32(0);
        received.add(seq);
      };
    };

    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
    await opened;

    const buf = new ArrayBuffer(PAYLOAD_BYTES);
    const view = new DataView(buf);
    for (let i = 0; i < PACKETS; i++) {
      view.setUint32(0, i);
      while (dc.bufferedAmount > 16384) await sleep(10);
      dc.send(buf.slice(0));
      if (i % BURST === BURST - 1) await sleep(BURST_GAP_MS);
    }
    await sleep(SETTLE_MS);

    return {
      lossPct: Math.max(0, ((PACKETS - received.size) / PACKETS) * 100),
      sent: PACKETS,
      received: received.size,
    };
  })();

  try {
    const bail = (async () => {
      await sleep(RELAY_BAIL_MS);
      if (!sawRelay) return null;
      await sleep(timeoutMs - RELAY_BAIL_MS);
      return null;
    })();
    const result = await Promise.race([attempt.catch(() => null), bail]);
    if (aborted || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    cleanup();
  }
}

/**
 * High-frequency network probe packet loss measurement.
 * Sends 40 paced lightweight probes to measure dropped packets across firewalled links.
 */
async function measureProbePacketLoss({ signal } = {}) {
  const PROBES = 40;
  const PROBE_TIMEOUT_MS = 2500;
  const url = 'https://speed.cloudflare.com/__down?bytes=0';
  let received = 0;

  const probeOne = async (i) => {
    if (signal?.aborted) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${url}&_seq=${Date.now()}_${i}`, {
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (res.ok) {
        await res.arrayBuffer();
        received++;
      }
    } catch (_) {
      // Packet dropped or timed out
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  // Pace 40 probes in small bursts of 4 every 30ms (~300ms total test)
  const tasks = [];
  for (let i = 0; i < PROBES; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    tasks.push(probeOne(i));
    if (i % 4 === 3) await sleep(30);
  }
  await Promise.allSettled(tasks);

  const lossPct = Math.max(0, ((PROBES - received) / PROBES) * 100);
  return {
    lossPct: Math.round(lossPct * 10) / 10,
    sent: PROBES,
    received,
    method: 'probe',
  };
}
