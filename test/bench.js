// 精度と処理時間の一覧を表示する（npm run bench）
import { AnalysisEngine } from '../src/engine.js';
import { centsBetween, midiToFreq } from '../src/dsp/notes.js';
import { tone, dbToAmp } from './signals.js';

const sampleRate = 48000;
const amps = [0, -3, -6, -9, -12].map(dbToAmp).map((a) => a * 0.2);
const rows = [];
for (const [name, midi] of [['B0', 23], ['E1', 28], ['A1', 33], ['D2', 38], ['G2', 43], ['G3', 55], ['G4', 67]]) {
  const f0 = midiToFreq(midi);
  const sig = tone({ f0, sampleRate, seconds: 2, amps, noise: 0.005 });
  const engine = new AnalysisEngine(sampleRate);
  const times = [];
  let last;
  for (let i = 0; i + 1024 <= sig.length; i += 1024) {
    engine.push(sig.subarray(i, i + 1024));
    last = engine.analyze();
    times.push(last.procMs);
  }
  times.sort((a, b) => a - b);
  const d = engine.windowDelay(last.harmonicWindow);
  rows.push({
    note: name,
    f0: f0.toFixed(2),
    detected: last.note?.name,
    errCents: centsBetween(last.freq, f0).toFixed(3),
    H2relDb: last.harmonics[1].relDb.toFixed(2),
    H5relDb: last.harmonics[4].relDb.toFixed(2),
    procMedianMs: times[times.length >> 1].toFixed(2),
    procMaxMs: times[times.length - 1].toFixed(2),
    pitchWinMs: (d.pitchWindow * 1000).toFixed(0),
    harmWinMs: ((last.harmonicWindow / sampleRate) * 1000).toFixed(0),
  });
}
console.table(rows);
