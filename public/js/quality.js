// SpeedUndo Quality & Bufferbloat Scoring Engine.
// Calculates scientific Bufferbloat letter grade (A+ to F) and real-world
// suitability ratings for Gaming, Video Conferencing, and 4K Streaming.

import { fmtMs, fmtPct } from './format.js';

export function calculateBufferbloat(ping, loadedRtt) {
  if (ping == null || loadedRtt == null || !Number.isFinite(ping) || !Number.isFinite(loadedRtt)) {
    return {
      delta: null,
      grade: '—',
      label: 'Untested',
      desc: 'Loaded latency probe was not captured.',
      class: 'grade-neutral',
    };
  }

  const delta = Math.max(0, loadedRtt - ping);

  if (delta <= 5) {
    return {
      delta,
      grade: 'A+',
      label: 'Zero Bloat',
      desc: `+${fmtMs(delta)} ms under load. Active Queue Management (SQM/CAKE) optimal.`,
      class: 'grade-aplus',
    };
  }
  if (delta <= 18) {
    return {
      delta,
      grade: 'A',
      label: 'Minimal Bloat',
      desc: `+${fmtMs(delta)} ms under load. Imperceptible queueing during heavy transfers.`,
      class: 'grade-a',
    };
  }
  if (delta <= 40) {
    return {
      delta,
      grade: 'B',
      label: 'Moderate Bloat',
      desc: `+${fmtMs(delta)} ms under load. Minor latency increase during simultaneous downloads.`,
      class: 'grade-b',
    };
  }
  if (delta <= 80) {
    return {
      delta,
      grade: 'C',
      label: 'Noticeable Bloat',
      desc: `+${fmtMs(delta)} ms under load. Fast-paced games will feel input delay when others use Wi-Fi.`,
      class: 'grade-c',
    };
  }
  if (delta <= 160) {
    return {
      delta,
      grade: 'D',
      label: 'High Bloat',
      desc: `+${fmtMs(delta)} ms under load. Substantial buffer delay. Enable SQM on your router.`,
      class: 'grade-d',
    };
  }
  return {
    delta,
    grade: 'F',
    label: 'Severe Bloat',
    desc: `+${fmtMs(delta)} ms under load. Extreme buffer saturation causes heavy lag spikes.`,
    class: 'grade-f',
  };
}

export function evaluateSuitability(result) {
  const { ping = 0, jitter = 0, loss = 0, down = 0, up = 0, loadedRtt } = result;
  const bb = calculateBufferbloat(ping, loadedRtt);

  // 1. Gaming
  let gaming = { status: 'Good', rating: 'good', icon: '🎮', label: 'Gaming' };
  if (ping <= 25 && jitter <= 4 && (loss == null || loss <= 0.2) && (bb.grade === 'A+' || bb.grade === 'A')) {
    gaming = { status: 'Optimal', rating: 'optimal', icon: '🎯', label: 'Competitive Gaming', note: 'Esports ready (<25ms, tight jitter)' };
  } else if (ping <= 55 && jitter <= 10 && (loss == null || loss <= 1.5) && bb.grade !== 'F') {
    gaming = { status: 'Good', rating: 'good', icon: '🎮', label: 'Online Gaming', note: 'Smooth multiplayer, low latency' };
  } else if (ping <= 95 && (loss == null || loss <= 3.0)) {
    gaming = { status: 'Fair', rating: 'fair', icon: '🕹️', label: 'Casual Gaming', note: 'Playable, occasional lag bursts' };
  } else {
    gaming = { status: 'Poor', rating: 'poor', icon: '⚠️', label: 'Gaming Lag', note: 'High ping or packet loss causes rubberbanding' };
  }

  // 2. Video Calls / Conferencing
  let calls = { status: 'Good', rating: 'good', icon: '🎧', label: 'Video Calls' };
  if (up >= 8 && jitter <= 6 && (loss == null || loss <= 0.5) && ping <= 80) {
    calls = { status: 'Studio Quality', rating: 'optimal', icon: '🎧', label: 'HD Conferencing', note: 'Crystal clear audio, 1080p video' };
  } else if (up >= 3 && jitter <= 15 && (loss == null || loss <= 2.0)) {
    calls = { status: 'Stable', rating: 'good', icon: '👥', label: 'Zoom / Meet / Teams', note: 'Reliable group video calls' };
  } else if (up >= 1.2 && (loss == null || loss <= 4.0)) {
    calls = { status: 'Fair', rating: 'fair', icon: '📞', label: 'Standard Calls', note: 'Voice clear, video may drop resolution' };
  } else {
    calls = { status: 'Degraded', rating: 'poor', icon: '📵', label: 'Call Drop Risk', note: 'Low upload or packet loss drops speech' };
  }

  // 3. Streaming
  let stream = { status: 'Good', rating: 'good', icon: '📺', label: 'Streaming' };
  if (down >= 50 && (bb.grade === 'A+' || bb.grade === 'A' || bb.grade === 'B')) {
    stream = { status: '4K / 8K Ultra HD', rating: 'optimal', icon: '📺', label: '4K / 8K Streaming', note: 'Instant buffer, multiple 4K streams' };
  } else if (down >= 25) {
    stream = { status: '4K Ready', rating: 'good', icon: '🎬', label: '4K Streaming', note: 'Smooth 4K HDR playback' };
  } else if (down >= 10) {
    stream = { status: 'Full HD 1080p', rating: 'good', icon: '🎞️', label: '1080p Streaming', note: 'Reliable high definition' };
  } else if (down >= 3.5) {
    stream = { status: '720p HD', rating: 'fair', icon: '📹', label: 'Standard Streaming', note: 'Occasional buffer wait times' };
  } else {
    stream = { status: 'Buffering', rating: 'poor', icon: '⏳', label: 'Buffering Risk', note: 'Line speed insufficient for high definition' };
  }

  return { bufferbloat: bb, gaming, calls, stream };
}

export function renderQualityCard(containerEl, result) {
  if (!containerEl) return;
  const evalData = evaluateSuitability(result);
  const { bufferbloat, gaming, calls, stream } = evalData;

  containerEl.innerHTML = `
    <div class="quality-card">
      <div class="quality-bloat">
        <div class="quality-bloat-head">
          <span class="quality-eyebrow">BUFFERBLOAT GRADE</span>
          <span class="quality-delta">${bufferbloat.delta != null ? `+${fmtMs(bufferbloat.delta)} ms` : ''}</span>
        </div>
        <div class="quality-grade-badge ${bufferbloat.class}">
          <span class="quality-grade-letter">${bufferbloat.grade}</span>
          <div class="quality-grade-meta">
            <span class="quality-grade-title">${bufferbloat.label}</span>
            <span class="quality-grade-desc">${bufferbloat.desc}</span>
          </div>
        </div>
      </div>

      <div class="quality-usecases">
        <div class="quality-usecase quality-usecase-${gaming.rating}">
          <div class="usecase-icon">${gaming.icon}</div>
          <div class="usecase-info">
            <span class="usecase-title">${gaming.label}</span>
            <span class="usecase-status status-${gaming.rating}">${gaming.status}</span>
            <span class="usecase-note">${gaming.note}</span>
          </div>
        </div>

        <div class="quality-usecase quality-usecase-${calls.rating}">
          <div class="usecase-icon">${calls.icon}</div>
          <div class="usecase-info">
            <span class="usecase-title">${calls.label}</span>
            <span class="usecase-status status-${calls.rating}">${calls.status}</span>
            <span class="usecase-note">${calls.note}</span>
          </div>
        </div>

        <div class="quality-usecase quality-usecase-${stream.rating}">
          <div class="usecase-icon">${stream.icon}</div>
          <div class="usecase-info">
            <span class="usecase-title">${stream.label}</span>
            <span class="usecase-status status-${stream.rating}">${stream.status}</span>
            <span class="usecase-note">${stream.note}</span>
          </div>
        </div>
      </div>
    </div>
  `;
  containerEl.hidden = false;
}
