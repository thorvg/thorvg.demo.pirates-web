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
let unlocked = false;
function unlock(): void {
  unlocked = true;
  if (ctx.state === 'suspended') void ctx.resume().then(() => { if (musicOn) startMusic(); });
  else if (musicOn) startMusic();
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

// ---------------------------------------------------------------------------
// Background music: an original swashbuckling theme in D minor, 6/8 time.
// Driving string ostinato, brass melody, string pad and timpani, synthesized
// and scheduled ahead of time on the audio clock.

const music = ctx.createGain();
const MUSIC_VOLUME = 0.32;
music.gain.value = MUSIC_VOLUME;
music.connect(master);

const EIGHTH = 0.2;  // dotted quarter = 100 bpm
const BAR = 6;       // eighths per bar

const midi = (m: number) => 440.0 * Math.pow(2.0, (m - 69) / 12.0);

// Pad voicing and ostinato root per chord.
const CHORDS: Record<string, { pad: number[]; root: number }> = {
  Dm: { pad: [50, 53, 57], root: 38 },
  Bb: { pad: [50, 53, 58], root: 34 },
  C:  { pad: [48, 52, 55], root: 36 },
  Gm: { pad: [50, 55, 58], root: 43 },
  A:  { pad: [49, 52, 57], root: 33 },
  F:  { pad: [48, 53, 57], root: 41 },
};

const NOTE: Record<string, number> = {
  G4: 67, A4: 69, Bb4: 70, C5: 72, 'C#5': 73, D5: 74, E5: 76, F5: 77, G5: 79, A5: 81,
};

// Each bar: chord, then melody as "note:eighths" (a "-" note rests).
const INTRO = ['Dm', 'Dm', 'Bb', 'A'].map((chord) => ({ chord, melody: '' }));
const THEME = [
  // A: the call to arms
  ['Dm', 'D5:2 A4:1 D5:2 F5:1'],
  ['Dm', 'E5:2 D5:1 C5:2 A4:1'],
  ['Bb', 'Bb4:2 D5:1 F5:3'],
  ['C',  'E5:2 C5:1 G4:3'],
  ['Dm', 'D5:2 A4:1 D5:2 F5:1'],
  ['Gm', 'G5:2 F5:1 E5:1 D5:1 Bb4:1'],
  ['A',  'C#5:2 E5:1 A5:3'],
  ['A',  'G5:1 F5:1 E5:1 C#5:3'],
  // B: open sea
  ['F',  'A5:3 F5:3'],
  ['C',  'G5:2 E5:1 C5:3'],
  ['Dm', 'F5:2 D5:1 A4:3'],
  ['Bb', 'Bb4:2 C5:1 D5:3'],
  ['Gm', 'G5:2 F5:1 E5:2 D5:1'],
  ['Dm', 'F5:2 E5:1 D5:3'],
  ['A',  'E5:2 C#5:1 A4:1 C#5:1 E5:1'],
  ['Dm', 'D5:6'],
].map(([chord, melody]) => ({ chord, melody }));

function voice(out: AudioNode, t: number, peak: number, attack: number, hold: number, release: number): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.setValueAtTime(peak, t + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  gain.connect(out);
  return gain;
}

function strings(t: number, note: number, accent: boolean): void {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = accent ? 1400 : 900;
  filter.connect(voice(music, t, accent ? 0.22 : 0.13, 0.006, 0.05, 0.12));
  for (const detune of [-7, 7]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = midi(note);
    osc.detune.value = detune;
    osc.connect(filter);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}

function brass(t: number, note: number, duration: number): void {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 2.0;
  // Opening filter sweep gives the horn its "blat".
  filter.frequency.setValueAtTime(500, t);
  filter.frequency.exponentialRampToValueAtTime(2600, t + 0.06);
  filter.frequency.exponentialRampToValueAtTime(1300, t + 0.3);
  filter.connect(voice(music, t, 0.16, 0.03, Math.max(0.0, duration - 0.12), 0.1));
  const vibrato = ctx.createOscillator();
  vibrato.frequency.value = 5.5;
  const depth = ctx.createGain();
  depth.gain.value = duration > 0.4 ? 12 : 0;
  vibrato.connect(depth);
  for (const [type, detune, level] of [['sawtooth', -5, 1.0], ['sawtooth', 5, 1.0], ['square', 0, 0.4]] as const) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = midi(note);
    osc.detune.value = detune;
    depth.connect(osc.detune);
    const mix = ctx.createGain();
    mix.gain.value = level;
    osc.connect(mix).connect(filter);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }
  vibrato.start(t);
  vibrato.stop(t + duration + 0.05);
}

function pad(t: number, notes: number[]): void {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 800;
  const length = BAR * EIGHTH;
  filter.connect(voice(music, t, 0.05, 0.25, length - 0.35, 0.3));
  for (const note of notes) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = midi(note);
    osc.connect(filter);
    osc.start(t);
    osc.stop(t + length + 0.15);
  }
}

function timpani(t: number, note: number, level: number): void {
  tone(envelope(music, t, level, 0.004, 0.7), t, 0.75, 'sine', midi(note) * 1.4, midi(note));
  burst(envelope(music, t, level * 0.5, 0.002, 0.1), t, 0.12, 'lowpass', 400, 120);
}

function crash(t: number): void {
  burst(envelope(music, t, 0.12, 0.004, 1.6), t, 1.7, 'highpass', 6000, 3000, 0.7);
}

function scheduleBar(t: number, bar: { chord: string; melody: string }, first: boolean, last: boolean): void {
  const chord = CHORDS[bar.chord];
  pad(t, chord.pad);
  for (let i = 0; i < BAR; ++i) {
    strings(t + i * EIGHTH, chord.root + (i % 3 === 0 ? 0 : 12), i % 3 === 0);
  }
  timpani(t, chord.root, 0.5);
  timpani(t + 3 * EIGHTH, chord.root + 7, 0.3);
  if (last) {
    // Timpani roll into the next phrase.
    for (let i = 0; i < 6; ++i) timpani(t + (3 + i * 0.5) * EIGHTH, chord.root + 7, 0.12 + i * 0.04);
  }
  if (first) crash(t);
  let offset = 0;
  for (const token of bar.melody.split(' ').filter(Boolean)) {
    const [name, eighths] = token.split(':');
    const length = Number(eighths);
    if (name !== '-') brass(t + offset * EIGHTH, NOTE[name], length * EIGHTH - 0.02);
    offset += length;
  }
}

let musicOn = true;
let barIndex = 0;
let nextBar = 0;
let timer = 0;

function scheduler(): void {
  while (nextBar < ctx.currentTime + 0.3) {
    const intro = barIndex < INTRO.length;
    const index = intro ? barIndex : (barIndex - INTRO.length) % THEME.length;
    const bars = intro ? INTRO : THEME;
    scheduleBar(nextBar, bars[index], !intro && index % 8 === 0, index % 8 === 7 || (intro && index === INTRO.length - 1));
    nextBar += BAR * EIGHTH;
    ++barIndex;
  }
}

function startMusic(): void {
  if (timer) return;
  barIndex = 0;
  nextBar = ctx.currentTime + 0.1;
  scheduler();
  timer = window.setInterval(scheduler, 50);
}

function stopMusic(): void {
  window.clearInterval(timer);
  timer = 0;
}

/** Turns the background music on or off. */
export function toggleMusic(): void {
  musicOn = !musicOn;
  const t = ctx.currentTime;
  music.gain.cancelScheduledValues(t);
  music.gain.setValueAtTime(music.gain.value, t);
  music.gain.linearRampToValueAtTime(musicOn ? MUSIC_VOLUME : 0.0, t + 0.3);
  if (musicOn) startMusic();
  else window.setTimeout(() => { if (!musicOn) stopMusic(); }, 400);
}

/** Lowers the music while the game over screen is up. */
export function duckMusic(ducked: boolean): void {
  if (!musicOn) return;
  const t = ctx.currentTime;
  music.gain.cancelScheduledValues(t);
  music.gain.setValueAtTime(music.gain.value, t);
  music.gain.linearRampToValueAtTime(ducked ? MUSIC_VOLUME * 0.25 : MUSIC_VOLUME, t + 0.8);
}

// The audio clock stops while the context is suspended, so the score resumes in place.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) void ctx.suspend();
  else if (!unlocked) return;
  else void ctx.resume();
});
