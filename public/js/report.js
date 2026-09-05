// SpeedUndo ISP Dispute Report Generator.
// Formats a verified, timestamped network diagnostic audit suitable for
// ISP support tickets, SLA violation claims, and technician escalation.

import { fmtMbps, fmtMs, fmtPct, fmtDateTime, speedUnitLabel } from './format.js';
import { calculateBufferbloat } from './quality.js';

export function generateReportMarkdown(result) {
  const ts = fmtDateTime(result.ts);
  const isp = result.geo?.isp || 'Unknown Provider';
  const asn = result.geo?.asn || 'Unknown ASN';
  const location = [result.geo?.city, result.geo?.region, result.geo?.country].filter(Boolean).join(', ');
  const ip = result.meta?.ip || result.geo?.ip || 'Undisclosed (Client)';
  const colo = result.meta?.colo || result.server || 'Direct Edge';
  const bloat = calculateBufferbloat(result.ping, result.loadedRtt);

  let diagnosis = [];
  if (result.loss > 1.0) {
    diagnosis.push(`- **CRITICAL PACKET LOSS (${fmtPct(result.loss)}%):** Exceeds standard residential SLA threshold (<0.5%). Indicates physical layer faults, coaxial noise, fiber degradation, or upstream peering congestion.`);
  }
  if (bloat.grade === 'D' || bloat.grade === 'F') {
    diagnosis.push(`- **SEVERE BUFFERBLOAT (${bloat.grade} / +${fmtMs(bloat.delta)} ms):** Router or ISP CMTS / DSLAM buffer queue saturation. Real-time latency balloons under load, causing severe packet drops and gaming/conferencing disconnects.`);
  }
  if (result.jitter > 15.0) {
    diagnosis.push(`- **HIGH JITTER (${fmtMs(result.jitter)} ms):** Excessive latency variance indicating intermittent link congestion or Wi-Fi channel interference.`);
  }
  if (!diagnosis.length) {
    diagnosis.push(`- **NOMINAL LINE HEALTH:** Latency, jitter, and packet delivery are within optimal operating parameters for this test cycle.`);
  }

  return `================================================================================
SPEEDUNDO CERTIFIED NETWORK TELEMETRY AUDIT
Reference Timestamp: ${ts}
================================================================================

1. SUBSCRIBER & CONNECTION IDENTIFIERS
--------------------------------------------------------------------------------
Internet Service Provider : ${isp}
Autonomous System (ASN)   : ${asn}
Geographic Location       : ${location}
External Client IP        : ${ip}
Edge Measurement Target   : ${colo}

2. TELEMETRY MEASUREMENTS
--------------------------------------------------------------------------------
Download Throughput       : ${fmtMbps(result.down)} ${speedUnitLabel().toUpperCase()}
Upload Throughput         : ${fmtMbps(result.up)} ${speedUnitLabel().toUpperCase()}
Idle Round-Trip Latency   : ${fmtMs(result.ping)} ms
Successive Jitter         : ${fmtMs(result.jitter)} ms
Packet Loss Rate          : ${result.loss != null ? fmtPct(result.loss) + '%' : '0.0%'}
Loaded RTT (Bufferbloat)  : ${result.loadedRtt != null ? fmtMs(result.loadedRtt) + ' ms' : 'N/A'}
Bufferbloat Delta         : ${bloat.delta != null ? '+' + fmtMs(bloat.delta) + ' ms (' + bloat.grade + ')' : 'N/A'}

3. DIAGNOSTIC FINDINGS & SLA ASSESSMENT
--------------------------------------------------------------------------------
${diagnosis.join('\n')}

================================================================================
Generated with SpeedUndo (Precision Network Meter)
https://speedundo.hk2704331.workers.dev
================================================================================`;
}

export function openDisputeModal(modalEl, backdropEl, result) {
  if (!modalEl || !result) return;
  const rawText = generateReportMarkdown(result);
  const previewEl = modalEl.querySelector('#disputePreview');
  if (previewEl) {
    previewEl.textContent = rawText;
  }

  modalEl.hidden = false;
  if (backdropEl) backdropEl.hidden = false;
}

export function closeDisputeModal(modalEl, backdropEl) {
  if (modalEl) modalEl.hidden = true;
  if (backdropEl) backdropEl.hidden = true;
}

export function copyDisputeReport(result) {
  const text = generateReportMarkdown(result);
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('Clipboard API unavailable'));
}

export function downloadDisputeReport(result) {
  const text = generateReportMarkdown(result);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `SpeedUndo_ISP_Dispute_${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
