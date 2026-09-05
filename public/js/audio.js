// SpeedUndo Web Audio Synthesizer — Zero-dependency retro-bench soundscape.
// Uses native Web Audio API to create mechanical relay clicks, throughput
// velocity frequency sweep hum, latency probe ticks, and a completion chime.

import { getSetting } from './settings.js';

let ctx = null;
let sweepOsc = null;
let sweepGain = null;
let sweepFilter = null;
let isAudioAllowed = false;

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!ctx) {
    ctx = new AudioCtx();
  }
  if (ctx.state === 'suspended' && isAudioAllowed) {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

// User gesture unlocks audio context
export function unlockAudio() {
  isAudioAllowed = true;
  const c = getAudioContext();
  if (c && c.state === 'suspended') {
    c.resume().catch(() => {});
  }
}

function isMuted() {
  return getSetting('sound') === 'off';
}

function getMasterVolume() {
  const v = Number(getSetting('volume'));
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.35;
}

// Mechanical relay click (two micro-impulses with slight spring resonance)
export function playRelayClick(down = true) {
  if (isMuted()) return;
  const c = getAudioContext();
  if (!c) return;

  const now = c.currentTime;
  const master = getMasterVolume();

  // Primary impulse
  const osc1 = c.createOscillator();
  const gain1 = c.createGain();
  osc1.type = 'triangle';
  osc1.frequency.setValueAtTime(down ? 880 : 660, now);
  osc1.frequency.exponentialRampToValueAtTime(80, now + 0.025);

  gain1.gain.setValueAtTime(0.4 * master, now);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.025);

  osc1.connect(gain1);
  gain1.connect(c.destination);
  osc1.start(now);
  osc1.stop(now + 0.03);

  // Secondary mechanical contact click
  const osc2 = c.createOscillator();
  const gain2 = c.createGain();
  osc2.type = 'square';
  osc2.frequency.setValueAtTime(down ? 220 : 180, now + 0.008);
  osc2.frequency.exponentialRampToValueAtTime(40, now + 0.035);

  gain2.gain.setValueAtTime(0.2 * master, now + 0.008);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.035);

  osc2.connect(gain2);
  gain2.connect(c.destination);
  osc2.start(now + 0.008);
  osc2.stop(now + 0.04);
}

// Latency probe tick: ultra-short 12ms high-precision ping
export function playProbeTick() {
  if (isMuted()) return;
  const c = getAudioContext();
  if (!c) return;

  const now = c.currentTime;
  const master = getMasterVolume();

  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1400, now);
  osc.frequency.exponentialRampToValueAtTime(900, now + 0.015);

  gain.gain.setValueAtTime(0.15 * master, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);

  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.018);
}

// Continuous velocity sweep hum during Download / Upload
export function startThroughputSweep(kind = 'down') {
  stopThroughputSweep();
  if (isMuted()) return;
  const c = getAudioContext();
  if (!c) return;

  const now = c.currentTime;
  const master = getMasterVolume();

  sweepOsc = c.createOscillator();
  sweepGain = c.createGain();
  sweepFilter = c.createBiquadFilter();

  // Warm phosphor-like tone
  sweepOsc.type = kind === 'down' ? 'sine' : 'triangle';
  sweepOsc.frequency.setValueAtTime(160, now);

  sweepFilter.type = 'lowpass';
  sweepFilter.frequency.setValueAtTime(600, now);

  sweepGain.gain.setValueAtTime(0.001, now);
  sweepGain.gain.linearRampToValueAtTime(0.18 * master, now + 0.2);

  sweepOsc.connect(sweepFilter);
  sweepFilter.connect(sweepGain);
  sweepGain.connect(c.destination);

  sweepOsc.start(now);
}

export function updateThroughputSweep(mbps) {
  if (!sweepOsc || !ctx || isMuted()) return;
  const now = ctx.currentTime;
  // Map 0 - 1000 Mbps log scale to 160Hz - 720Hz
  const safeMbps = Math.max(0.1, Number(mbps) || 0);
  const norm = Math.min(1, Math.log10(safeMbps + 1) / 3); // 0 to 1
  const freq = 160 + norm * 560;

  sweepOsc.frequency.setTargetAtTime(freq, now, 0.08);
  if (sweepFilter) {
    sweepFilter.frequency.setTargetAtTime(500 + norm * 1200, now, 0.08);
  }
}

export function stopThroughputSweep() {
  if (!sweepGain || !ctx) {
    sweepOsc = null;
    sweepGain = null;
    sweepFilter = null;
    return;
  }
  const now = ctx.currentTime;
  try {
    sweepGain.gain.linearRampToValueAtTime(0.0001, now + 0.15);
    if (sweepOsc) {
      sweepOsc.stop(now + 0.18);
    }
  } catch (_) {}
  sweepOsc = null;
  sweepGain = null;
  sweepFilter = null;
}

// Resonant phosphor two-tone chord on test completion
export function playCompletionChime() {
  if (isMuted()) return;
  const c = getAudioContext();
  if (!c) return;

  const now = c.currentTime;
  const master = getMasterVolume();

  const notes = [
    { freq: 523.25, time: 0.0, dur: 0.4 }, // C5
    { freq: 659.25, time: 0.09, dur: 0.45 }, // E5
    { freq: 783.99, time: 0.18, dur: 0.7 }, // G5
    { freq: 1046.50, time: 0.27, dur: 0.9 }, // C6
  ];

  notes.forEach((n) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(n.freq, now + n.time);

    gain.gain.setValueAtTime(0.001, now + n.time);
    gain.gain.linearRampToValueAtTime(0.22 * master, now + n.time + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + n.time + n.dur);

    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(now + n.time);
    osc.stop(now + n.time + n.dur + 0.05);
  });
}
