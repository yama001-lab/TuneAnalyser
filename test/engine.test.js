import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisEngine } from '../src/engine.js';
import { centsBetween, freqToNote, midiToFreq } from '../src/dsp/notes.js';
import { tone, dbToAmp } from './signals.js';

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
