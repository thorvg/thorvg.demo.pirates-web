// Sound effects are synthesized with WebAudio, so no audio assets are shipped.

export type SoundName = 'cannon' | 'hit' | 'sink' | 'splash' | 'pickup' | 'gameover';

const ctx = new AudioContext();
const master = ctx.createGain();
master.gain.value = 0.6;
// A compressor keeps overlapping explosions from clipping.
master.connect(ctx.createDynamicsCompressor()).connect(ctx.destination);

const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
{
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; ++i) data[i] = Math.random() * 2.0 - 1.0;
}

// browsers keep the context suspended until a user gesture
function unlock(): void {
  if (ctx.state === 'suspended') void ctx.resume();
  window.removeEventListener('keydown', unlock);
  window.removeEventListener('pointerdown', unlock);
}
window.addEventListener('keydown', unlock);
window.addEventListener('pointerdown', unlock);

/** Gain node with a quick attack and an exponential decay to silence. */
function envelope(out: AudioNode, t: number, peak: number, attack: number, decay: number): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  gain.connect(out);
  return gain;
}

function burst(out: AudioNode, t: number, duration: number, type: BiquadFilterType, from: number, to: number, q = 1.0): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  source.playbackRate.value = 0.8 + Math.random() * 0.4;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + duration);
  source.connect(filter).connect(out);
  source.start(t, Math.random());
  source.stop(t + duration);
  return source;
}

function tone(out: AudioNode, t: number, duration: number, type: OscillatorType, from: number, to = from): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + duration);
  osc.connect(out);
  osc.start(t);
  osc.stop(t + duration);
}

const SYNTHS: Record<SoundName, (out: AudioNode, t: number) => void> = {
  cannon: (out, t) => {
    tone(envelope(out, t, 1.0, 0.005, 0.35), t, 0.4, 'sine', 120, 38);
    burst(envelope(out, t, 0.9, 0.003, 0.55), t, 0.6, 'lowpass', 2200, 180);
  },
  hit: (out, t) => {
    burst(envelope(out, t, 0.9, 0.002, 0.2), t, 0.25, 'bandpass', 1400, 500, 1.5);
    tone(envelope(out, t, 0.7, 0.003, 0.18), t, 0.2, 'triangle', 190, 70);
  },
  sink: (out, t) => {
    burst(envelope(out, t, 1.0, 0.01, 1.6), t, 1.7, 'lowpass', 900, 70);
    tone(envelope(out, t, 0.8, 0.01, 1.2), t, 1.3, 'sine', 70, 28);
    burst(envelope(out, t + 0.35, 0.35, 0.3, 1.2), t + 0.35, 1.6, 'bandpass', 700, 250, 0.8);
  },
  splash: (out, t) => {
    burst(envelope(out, t, 0.6, 0.015, 0.5), t, 0.55, 'bandpass', 2600, 500, 0.9);
    tone(envelope(out, t, 0.25, 0.005, 0.12), t, 0.15, 'sine', 320, 110);
  },
  pickup: (out, t) => {
    [660, 880, 1320].forEach((freq, i) => tone(envelope(out, t + i * 0.08, 0.35, 0.005, 0.22), t + i * 0.08, 0.25, 'triangle', freq));
  },
  gameover: (out, t) => {
    [392, 330, 262, 196].forEach((freq, i) => {
      const start = t + i * 0.28;
      tone(envelope(out, start, 0.25, 0.01, i === 3 ? 0.9 : 0.3), start, i === 3 ? 0.95 : 0.32, 'square', freq, i === 3 ? freq * 0.94 : freq);
    });
  },
};

/** `pan` ranges from -1 (left) to 1 (right). */
export function playSound(name: SoundName, volume = 1.0, pan = 0.0): void {
  if (ctx.state !== 'running' || volume <= 0.0) return;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1.0, Math.min(1.0, pan));
  gain.connect(panner).connect(master);
  SYNTHS[name](gain, ctx.currentTime);
}
