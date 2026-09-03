// Worker unit test suite verifying security mitigations in src/worker.js
import worker from '../src/worker.js';

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

async function run() {
  console.log('--- Testing src/worker.js security fixes ---');

  // 1. Test /down clamping
  const reqDown = new Request('https://speedundo.workers.dev/down?bytes=1000000000', {
    method: 'HEAD',
    headers: { 'CF-Connecting-IP': '1.2.3.4' },
  });
  const resDown = await worker.fetch(reqDown, {}, {});
  const len = Number(resDown.headers.get('content-length'));
  assert('Worker clamps /down to <= 50MB (got ' + len + ')', len <= 50000000 && len > 0);

  // 2. Test CORS security on /down
  const reqCorsEvil = new Request('https://speedundo.workers.dev/down?bytes=0', {
    method: 'HEAD',
    headers: { 'Origin': 'https://evil.com', 'CF-Connecting-IP': '1.2.3.4' },
  });
  const resCorsEvil = await worker.fetch(reqCorsEvil, {}, {});
  const exposedEvil = resCorsEvil.headers.get('access-control-expose-headers') || '';
  assert('Worker does not expose cf-meta-ip to third-party CORS origins', !exposedEvil.includes('cf-meta-ip'));

  const reqCorsSame = new Request('https://speedundo.workers.dev/down?bytes=0', {
    method: 'HEAD',
    headers: { 'Host': 'speedundo.workers.dev', 'Origin': 'https://speedundo.workers.dev', 'CF-Connecting-IP': '1.2.3.4' },
  });
  const resCorsSame = await worker.fetch(reqCorsSame, {}, {});
  const exposedSame = resCorsSame.headers.get('access-control-expose-headers') || '';
  assert('Worker exposes cf-meta-ip to matching origin', exposedSame.includes('cf-meta-ip'));

  // 3. Test SVG XSS sanitization & headers
  const mockEnv = {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          batch: async () => [],
        }),
      }),
      batch: async () => [],
    },
  };
  const reqSvg = new Request('https://speedundo.workers.dev/api/badge.svg?city=%3Cscript%3Ealert(1)%3C/script%3E&isp=%22%3E%3Cimg%20src=x%3E');
  const resSvg = await worker.fetch(reqSvg, mockEnv, {});
  const svgText = await resSvg.text();
  assert('Worker SVG badge returns 200', resSvg.status === 200);
  assert('Worker SVG escapes <img', !svgText.includes('<img') && svgText.includes('&quot;&gt;&lt;img'));
  assert('Worker SVG CSP is present', resSvg.headers.get('content-security-policy') === "default-src 'none'; style-src 'unsafe-inline'");
  assert('Worker SVG nosniff is present', resSvg.headers.get('x-content-type-options') === 'nosniff');

  // 4. Test rate limiting on /api/submit
  const submitBody = JSON.stringify({ isp: 'Test', city: 'City', down: 100 });
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const reqSubmit = new Request('https://speedundo.workers.dev/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
      body: submitBody,
    });
    const resSubmit = await worker.fetch(reqSubmit, mockEnv, {});
    statuses.push(resSubmit.status);
  }
  assert('Worker allows first 5 submissions', statuses.slice(0, 5).every((s) => s === 200), statuses);
  assert('Worker rate-limits 6th submission with 429', statuses[5] === 429, statuses[5]);

  console.log(`\nWorker Results: ${passed} / ${total} tests passed.`);
}

run().catch((err) => {
  console.error('Worker test failed:', err);
  process.exit(1);
});
