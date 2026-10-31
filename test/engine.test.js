import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisEngine } from '../src/engine.js';
import { centsBetween, freqToNote, midiToFreq } from '../src/dsp/notes.js';
import { tone, dbToAmp, addInterference } from './signals.js';

// コントラバス開放弦（A=440）と高めの音
const NOTES = {
  B0: midiToFreq(23), E1: midiToFreq(28), A1: midiToFreq(33), D2: midiToFreq(38),
  G2: midiToFreq(43), D3: midiToFreq(50), G4: midiToFreq(67),
};

// 実際の弓奏に近い倍音配分（基音を 0dB とした相対値）
const BOWED = [0, -3, -6, -9, -12].map(dbToAmp).map((a) => a * 0.2);

function analyzeTone(sig, sampleRate, opts) {
  const engine = new AnalysisEngine(sampleRate, opts);
  // 実機と同じく 1024 サンプルずつ流し込み、最後の解析結果を見る
  let last = null;
  const results = [];
  for (let i = 0; i + 1024 <= sig.length; i += 1024) {
    engine.push(sig.subarray(i, i + 1024));
    last = engine.analyze();
    results.push(last);
  }
  return { last, results, engine };
}

for (const sampleRate of [44100, 48000]) {
  for (const [name, f0] of Object.entries(NOTES)) {
    test(`${name} (${f0.toFixed(2)}Hz) @${sampleRate}Hz: ピッチ誤差 0.5セント未満`, () => {
      const sig = tone({ f0, sampleRate, seconds: 0.5, amps: BOWED });
      const { last } = analyzeTone(sig, sampleRate);
      assert.ok(last.voiced, 'voiced');
      assert.equal(last.note.name, name);
      const err = centsBetween(last.freq, f0);
      assert.ok(Math.abs(err) < 0.5, `error ${err.toFixed(3)} cents`);
    });
  }
}

test('E1: 倍音の相対レベルを ±0.5dB で再現', () => {
  const sampleRate = 48000;
  const rel = [0, -3, -6, -9, -12];
  const sig = tone({ f0: NOTES.E1, sampleRate, seconds: 0.5, amps: rel.map(dbToAmp).map((a) => a * 0.2) });
  const { last } = analyzeTone(sig, sampleRate);
  for (let k = 0; k < 5; k++) {
    const h = last.harmonics[k];
    assert.ok(Math.abs(h.relDb - rel[k]) < 0.5, `H${k + 1}: ${h.relDb.toFixed(2)} dB (expected ${rel[k]})`);
  }
  const shareSum = last.harmonics.reduce((s, h) => s + h.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
});

test('E1: スマホ内蔵マイク想定（基音が -20dB しか入らない）でも オクターブ誤りしない', () => {
  const sampleRate = 48000;
  const rel = [-20, 0, -2, -5, -8];
  const sig = tone({ f0: NOTES.E1, sampleRate, seconds: 0.5, amps: rel.map(dbToAmp).map((a) => a * 0.2) });
  const { last } = analyzeTone(sig, sampleRate);
  assert.equal(last.note.name, 'E1');
  assert.ok(Math.abs(centsBetween(last.freq, NOTES.E1)) < 1);
  assert.ok(Math.abs(last.harmonics[0].relDb - 0) < 0.5);
  assert.ok(Math.abs(last.harmonics[1].relDb - 20) < 0.7, `H2 rel ${last.harmonics[1].relDb}`);
});

test('E1: 基音なし（ミッシングファンダメンタル）でも E1 と判定', () => {
  const sampleRate = 48000;
  const sig = tone({ f0: NOTES.E1, sampleRate, seconds: 0.5, amps: [0, 0.2, 0.15, 0.1, 0.08] });
  const { last } = analyzeTone(sig, sampleRate);
  assert.equal(last.note.name, 'E1');
});

test('E1: ノイズ（SN比 約20dB）下で誤差 2セント未満', () => {
  const sampleRate = 48000;
  const sig = tone({ f0: NOTES.E1, sampleRate, seconds: 0.5, amps: BOWED, noise: 0.02 });
  const { last } = analyzeTone(sig, sampleRate);
  assert.equal(last.note.name, 'E1');
  assert.ok(Math.abs(centsBetween(last.freq, NOTES.E1)) < 2, `${centsBetween(last.freq, NOTES.E1)}`);
});

test('E1: 弦のインハーモニシティ（B=3e-4）があっても 5次まで ±0.5dB', () => {
  const sampleRate = 48000;
  const rel = [0, -4, -8, -6, -10];
  const sig = tone({ f0: NOTES.E1, sampleRate, seconds: 0.5, amps: rel.map(dbToAmp).map((a) => a * 0.2), inharmonicity: 3e-4 });
  const { last } = analyzeTone(sig, sampleRate);
  assert.equal(last.note.name, 'E1');
  for (let k = 0; k < 5; k++) {
    assert.ok(Math.abs(last.harmonics[k].relDb - rel[k]) < 0.5, `H${k + 1}: ${last.harmonics[k].relDb.toFixed(2)}`);
  }
});

test('ヴィブラート（±20セント, 5Hz）の揺れを追える', () => {
  const sampleRate = 48000;
  const sig = tone({ f0: NOTES.A1, sampleRate, seconds: 1.5, amps: BOWED, vibratoCents: 20, vibratoHz: 5 });
  const { results } = analyzeTone(sig, sampleRate);
  const cents = results.filter((r) => r.voiced).map((r) => centsBetween(r.freq, NOTES.A1));
  const range = Math.max(...cents) - Math.min(...cents);
  // 窓（約67ms）で平均されるぶん振れ幅は少し小さくなる
  assert.ok(range > 25 && range < 42, `range ${range.toFixed(1)} cents`);
});

test('無音・小音量は voiced=false', () => {
  const sampleRate = 48000;
  const { last } = analyzeTone(new Float32Array(sampleRate / 2), sampleRate);
  assert.equal(last.voiced, false);
  const quiet = tone({ f0: NOTES.E1, sampleRate, seconds: 0.5, amps: [0.0005] });
  assert.equal(analyzeTone(quiet, sampleRate).last.voiced, false);
});

test('基準ピッチ A=442 でセントが変わる', () => {
  const n = freqToNote(440, 442);
  assert.equal(n.name, 'A4');
  assert.ok(Math.abs(n.cents - centsBetween(440, 442)) < 1e-9);
  assert.ok(Math.abs(freqToNote(midiToFreq(28, 442), 442).cents) < 1e-9);
});

// ---- オクターブ誤り（実機で A線が A2 と表示された件） ----

// 内蔵マイクで基音が弱く、さらに奇数次倍音も弱いと、YIN は周期の半分を選びやすい
const WEAK_ODD = [-30, 0, -25, -4, -25, -8].map(dbToAmp).map((a) => a * 0.2);

for (const [name, midi] of [['E1', 28], ['A1', 33], ['D2', 38]]) {
  for (const noise of [0, 0.03]) {
    test(`${name}: 基音と奇数次倍音が弱くても 1オクターブ上と誤らない (noise ${noise})`, () => {
      const sampleRate = 48000;
      const f0 = midiToFreq(midi);
      const sig = tone({ f0, sampleRate, seconds: 0.6, amps: WEAK_ODD, noise });
      const { results } = analyzeTone(sig, sampleRate);
      const voiced = results.filter((r) => r.voiced);
      assert.ok(voiced.length > 10);
      for (const r of voiced) assert.equal(r.note.name, name);
    });
  }
}

for (const [name, midi, amps] of [
  ['A2', 45, BOWED],
  ['A2', 45, [0, -12, -20, -25, -30].map(dbToAmp).map((a) => a * 0.2)],
  ['D3', 50, BOWED],
  ['G4', 67, [0.2]],
]) {
  test(`${name}: 本当に高い音を 1オクターブ下と誤らない`, () => {
    const sampleRate = 48000;
    const sig = tone({ f0: midiToFreq(midi), sampleRate, seconds: 0.6, amps, noise: 0.03 });
    const { results } = analyzeTone(sig, sampleRate);
    for (const r of results.filter((r) => r.voiced)) assert.equal(r.note.name, name);
  });
}

// ---- 他の楽器の音が鳴っている環境 ----

test('A1: 他の楽器の音(-6dB)が混ざっても表示用ピッチは A1 のまま、ぶれ 5セント未満', () => {
  const sampleRate = 48000;
  const f0 = midiToFreq(33);
  const sig = tone({ f0, sampleRate, seconds: 4, amps: [-24, -9, -7, -6, -7, -8].map(dbToAmp).map((a) => a * 0.2), noise: 0.003 });
  addInterference(sig, sampleRate, -6);
  const { results } = analyzeTone(sig, sampleRate);
  const shown = results.slice(15).map((r) => r.stable);
  assert.ok(shown.every((s) => s && s.note.name === 'A1'), 'A1 以外が表示された');
  const cents = shown.map((s) => centsBetween(s.freq, f0));
  const mean = cents.reduce((a, b) => a + b, 0) / cents.length;
  const sd = Math.sqrt(cents.reduce((a, c) => a + (c - mean) ** 2, 0) / cents.length);
  assert.ok(sd < 5, `sd ${sd.toFixed(2)} cents`);
});

test('E1: 弦のインハーモニシティ（B=3e-4）があってもピッチ誤差 3セント未満', () => {
  const sampleRate = 48000;
  const f0 = midiToFreq(28);
  const sig = tone({ f0, sampleRate, seconds: 0.5, amps: BOWED, inharmonicity: 3e-4 });
  const { last } = analyzeTone(sig, sampleRate);
  assert.ok(Math.abs(centsBetween(last.freq, f0)) < 3, `${centsBetween(last.freq, f0)}`);
});

test('音を変えたら 200ms 以内に表示が切り替わる（前の弦が鳴り残っていても）', () => {
  const sampleRate = 48000;
  const seg = 0.6;
  const seq = [['A1', 33], ['D2', 38], ['G2', 43], ['A2', 45], ['A1', 33], ['E1', 28]];
  const n = Math.round(seg * sampleRate);
  const sig = new Float32Array(n * seq.length + n);
  for (const profile of [[-24, -9, -7, -6, -7, -8], [0, -3, -6, -9, -12]]) {
  sig.fill(0);
  const amps = profile.map(dbToAmp).map((a) => a * 0.2);
  seq.forEach(([, midi], i) => {
    // 弓で弾いている区間 + その後、開放弦が -6dB から減衰しながら鳴り残る
    const t = tone({ f0: midiToFreq(midi), sampleRate, seconds: seg * 2, amps, noise: 0.002, seed: i + 1 });
    for (let j = 0; j < t.length; j++) {
      const ring = j < n ? 1 : 0.5 * Math.exp(-(j - n) / sampleRate / 0.5);
      if (i * n + j < sig.length) sig[i * n + j] += t[j] * ring;
    }
  });
  const engine = new AnalysisEngine(sampleRate);
  const shown = [];
  for (let i = 0; i + 1024 <= sig.length; i += 1024) {
    engine.push(sig.subarray(i, i + 1024));
    shown.push({ t: (i + 1024) / sampleRate, name: engine.analyze().stable?.note.name });
  }
  seq.forEach(([name], i) => {
    const from = i * seg + 0.2, to = (i + 1) * seg;
    const inSeg = shown.filter((s) => s.t >= from && s.t < to);
    const wrong = inSeg.filter((s) => s.name !== name);
    assert.equal(wrong.length, 0, `${name}: ${wrong.map((s) => `${s.t.toFixed(2)}s ${s.name}`).join(', ')}`);
  });
  }
});
