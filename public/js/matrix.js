// SpeedUndo Global Ping Matrix & DNS Benchmark.
// Measures multi-region transit latency, evaluates DNS-over-HTTPS (DoH) resolver
// speeds (Cloudflare, Google, Quad9), and verifies native IPv6 connectivity.

import { fmtMs, median } from './format.js';

export const GLOBAL_HUBS = [
  { id: 'us-east', name: 'US East (Ashburn)', pingUrl: 'https://speed.cloudflare.com/__down?bytes=0' },
  { id: 'eu-west', name: 'Europe (London)', pingUrl: 'https://lon.speedtest.clouvider.net/backend/empty.php?cors=true' },
  { id: 'asia-east', name: 'Asia East (Tokyo)', pingUrl: 'https://librespeed.a573.net/backend/empty.php?cors=true' },
  { id: 'asia-south', name: 'Asia South (Singapore)', pingUrl: 'https://sgp.speedtest.clouvider.net/backend/empty.php?cors=true' },
  { id: 'oceania', name: 'Oceania (Sydney)', pingUrl: 'https://syd.speedtest.clouvider.net/backend/empty.php?cors=true' },
  { id: 'us-west', name: 'US West (San Jose)', pingUrl: 'https://la.speedtest.clouvider.net/backend/empty.php?cors=true' },
];

export const DNS_PROVIDERS = [
  {
    id: 'cloudflare',
    name: 'Cloudflare (1.1.1.1)',
    tag: 'Privacy First',
    url: 'https://cloudflare-dns.com/dns-query?name=cloudflare.com&type=A',
    headers: { 'Accept': 'application/dns-json' },
  },
  {
    id: 'google',
    name: 'Google Public DNS (8.8.8.8)',
    tag: 'Global Anycast',
    url: 'https://dns.google/resolve?name=google.com&type=A',
    headers: { 'Accept': 'application/json' },
  },
  {
    id: 'quad9',
    name: 'Quad9 (9.9.9.9)',
    tag: 'Threat Blocking',
    url: 'https://dns.quad9.net/dns-query?name=quad9.net&type=A',
    headers: { 'Accept': 'application/dns-json' },
  },
];

async function measureEndpointPing(url, samples = 3) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3500);
      const sep = url.includes('?') ? '&' : '?';
      await fetch(`${url}${sep}_t=${Date.now()}_${i}`, {
        method: 'GET',
        cache: 'no-store',
        mode: 'cors',
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      times.push(performance.now() - t0);
    } catch (_) {
      // ignore single drop
    }
  }
  return times.length ? median(times) : null;
}

export async function runGlobalPingMatrix(onProgress) {
  const results = [];
  for (const hub of GLOBAL_HUBS) {
    if (onProgress) onProgress(hub.id, 'measuring');
    const rtt = await measureEndpointPing(hub.pingUrl, 3);
    results.push({ ...hub, rtt });
    if (onProgress) onProgress(hub.id, 'done', rtt);
  }
  return results;
}

export async function runDnsBenchmark(onProgress) {
  const results = [];
  for (const dns of DNS_PROVIDERS) {
    if (onProgress) onProgress(dns.id, 'measuring');
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 3000);
        await fetch(`${dns.url}&_cb=${Date.now()}_${i}`, {
          method: 'GET',
          headers: dns.headers,
          cache: 'no-store',
          mode: 'cors',
          signal: ctrl.signal,
        });
        clearTimeout(timeout);
        samples.push(performance.now() - t0);
      } catch (_) {}
    }
    const rtt = samples.length ? median(samples) : null;
    results.push({ ...dns, rtt });
    if (onProgress) onProgress(dns.id, 'done', rtt);
  }
  return results;
}

export async function checkIpv6Support() {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2500);
    // Cloudflare IPv6 test target
    const res = await fetch('https://speed.cloudflare.com/cdn-cgi/trace', {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const text = await res.text();
      const ipLine = text.split('\n').find((l) => l.startsWith('ip='));
      if (ipLine) {
        const ip = ipLine.split('=')[1] || '';
        return ip.includes(':') ? 'IPv6 Native' : 'IPv4 Only';
      }
    }
  } catch (_) {}
  return 'IPv4 Detected';
}

export function renderMatrixView(containerEl, matrixResults, dnsResults, ipv6Status) {
  if (!containerEl) return;

  const maxPing = Math.max(150, ...(matrixResults || []).map((r) => r.rtt || 0));

  let matrixHtml = `
    <div class="matrix-grid-section">
      <div class="matrix-head">
        <h3 class="matrix-subhead">Global Transit Latency (Multi-Hub)</h3>
        <span class="matrix-tag">${ipv6Status || 'Detecting stack...'}</span>
      </div>
      <div class="matrix-bars">
  `;

  for (const item of matrixResults || []) {
    const rttStr = item.rtt != null ? `${fmtMs(item.rtt)} ms` : 'Offline / Blocked';
    const pct = item.rtt != null ? Math.min(100, (item.rtt / maxPing) * 100) : 0;
    let colorClass = 'bar-good';
    if (item.rtt > 220) colorClass = 'bar-critical';
    else if (item.rtt > 120) colorClass = 'bar-warn';
    else if (item.rtt > 60) colorClass = 'bar-fair';

    matrixHtml += `
      <div class="matrix-row">
        <span class="matrix-name">${item.name}</span>
        <div class="matrix-bar-track">
          <div class="matrix-bar-fill ${colorClass}" style="width: ${Math.max(4, pct)}%"></div>
        </div>
        <span class="matrix-val">${rttStr}</span>
      </div>
    `;
  }
  matrixHtml += `</div></div>`;

  // DNS Benchmark Section
  const validDns = (dnsResults || []).filter((d) => d.rtt != null);
  const bestDns = validDns.length ? [...validDns].sort((a, b) => a.rtt - b.rtt)[0] : null;

  let dnsHtml = `
    <div class="dns-grid-section">
      <div class="matrix-head">
        <h3 class="matrix-subhead">DNS-over-HTTPS (DoH) Resolver Speed</h3>
        ${bestDns ? `<span class="dns-best-badge">Fastest: ${bestDns.name.split('(')[0].trim()} (${fmtMs(bestDns.rtt)} ms)</span>` : ''}
      </div>
      <div class="dns-cards">
  `;

  for (const dns of dnsResults || []) {
    const isBest = bestDns && bestDns.id === dns.id;
    const rttStr = dns.rtt != null ? `${fmtMs(dns.rtt)} ms` : 'Unreachable';
    dnsHtml += `
      <div class="dns-card ${isBest ? 'dns-card-best' : ''}">
        <div class="dns-card-head">
          <span class="dns-name">${dns.name}</span>
          <span class="dns-tag">${dns.tag}</span>
        </div>
        <div class="dns-val-row">
          <span class="dns-val">${rttStr}</span>
          ${isBest ? '<span class="dns-check">★ RECOMMENDED</span>' : ''}
        </div>
      </div>
    `;
  }
  dnsHtml += `</div></div>`;

  containerEl.innerHTML = `
    <div class="matrix-container">
      ${matrixHtml}
      ${dnsHtml}
      <div class="matrix-actions">
        <button type="button" id="matrixRefreshBtn" class="btn btn-ghost">Re-run Matrix & DNS Benchmark</button>
      </div>
    </div>
  `;
}
