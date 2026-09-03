// Automated security verification suite for SpeedUndo
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function request(path, opts = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, opts);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function run() {
  console.log('--- Starting server for security test suite ---');
  const serverProc = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
  });

  try {
    // Wait for server to listen
    let connected = false;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      try {
        const res = await fetch(`${BASE}/`);
        if (res.status === 200) {
          connected = true;
          break;
        }
      } catch (_) {}
    }
    if (!connected) throw new Error('Server did not start in time');
    console.log('Server is running. Executing test assertions...\n');

    let passed = 0;
    let total = 0;

    function assert(name, condition, details) {
      total++;
      if (condition) {
        console.log(`PASS [${total}] ${name}`);
        passed++;
      } else {
        console.error(`FAIL [${total}] ${name}`);
        if (details) console.error(`   Details:`, details);
        process.exitCode = 1;
      }
    }

    // 1. Static file confinement & source code disclosure
    const r1 = await request('/server.js');
    assert('Source code /server.js is blocked', r1.status === 403 || r1.status === 404, `status: ${r1.status}`);

    const r2 = await request('/package.json');
    assert('Sensitive /package.json is blocked', r2.status === 403 || r2.status === 404, `status: ${r2.status}`);

    const r3 = await request('/wrangler.jsonc');
    assert('Config file /wrangler.jsonc is blocked', r3.status === 403 || r3.status === 404, `status: ${r3.status}`);

    const r4 = await request('/../server.js');
    assert('Path traversal /../server.js is blocked', r4.status === 403 || r4.status === 404, `status: ${r4.status}`);

    const r5 = await request('/');
    assert('Legitimate static / (index.html) loads successfully', r5.status === 200, `status: ${r5.status}`);
    assert('Security header X-Content-Type-Options is present', r5.headers.get('x-content-type-options') === 'nosniff');
    assert('Security header X-Frame-Options is present', r5.headers.get('x-frame-options') === 'SAMEORIGIN');
    assert('CSP header is present on HTML', Boolean(r5.headers.get('content-security-policy')));

    // 2. SVG XSS & escaping
    const rSvg1 = await request('/api/badge.svg?city=%3Cscript%3Ealert(1)%3C/script%3E');
    assert('SVG badge returns 200', rSvg1.status === 200);
    assert('SVG escapes <script>', !rSvg1.text.includes('<script>') && rSvg1.text.includes('&lt;script&gt;'));
    assert('SVG CSP restricts script execution', rSvg1.headers.get('content-security-policy') === "default-src 'none'; style-src 'unsafe-inline'");
    assert('SVG nosniff header is present', rSvg1.headers.get('x-content-type-options') === 'nosniff');

    const rSvg2 = await request('/api/badge.svg?isp=%22%3E%3Cimg%20src=x%20onerror=alert(2)%3E');
    assert('SVG escapes quotes and tag brackets', !rSvg2.text.includes('<img') && rSvg2.text.includes('&quot;&gt;&lt;img'));

    // 3. Bandwidth clamping on /down
    const rDown = await request('/down?bytes=1000000000', { method: 'HEAD' });
    const clampedLen = Number(rDown.headers.get('content-length'));
    assert('Download size clamped to <= 50MB (got ' + clampedLen + ')', clampedLen <= 50000000 && clampedLen > 0);

    // 4. CORS exposure safety
    const rCorsEvil = await request('/down?bytes=0', {
      method: 'HEAD',
      headers: { Origin: 'https://evil-tracker.com' },
    });
    const exposedEvil = rCorsEvil.headers.get('access-control-expose-headers') || '';
    assert('External origin cannot read cf-meta-ip in CORS headers', !exposedEvil.includes('cf-meta-ip'));

    const rCorsLocal = await request('/down?bytes=0', {
      method: 'HEAD',
      headers: { Origin: `http://localhost:${PORT}` },
    });
    const exposedLocal = rCorsLocal.headers.get('access-control-expose-headers') || '';
    assert('Same-origin/local caller can access cf-meta-ip in CORS headers', exposedLocal.includes('cf-meta-ip'));

    // 5. Rate limiting on /api/submit
    const dummyPayload = {
      isp: 'TestISP',
      city: 'TestCity',
      down: 100,
      up: 50,
      ping: 10,
    };
    let submitStatus = [];
    for (let i = 0; i < 6; i++) {
      const res = await request('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dummyPayload),
      });
      submitStatus.push(res.status);
    }
    assert('First 5 submissions succeed (200)', submitStatus.slice(0, 5).every((s) => s === 200), submitStatus);
    assert('6th rapid submission is rate limited (429)', submitStatus[5] === 429, `Got: ${submitStatus[5]}`);

    console.log(`\nResults: ${passed} / ${total} tests passed.`);
  } finally {
    serverProc.kill();
  }
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
