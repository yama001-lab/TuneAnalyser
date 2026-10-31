// 検証用の最小UI。マイク（またはテスト信号）→ AudioWorklet → 解析エンジン → 表示。

import { AnalysisEngine } from './engine.js';
import { midiToFreq } from './dsp/notes.js';
import { makeChirp, findTemplate, median } from './audio/loopback.js';

const HOP = 1024;
const $ = (id) => document.getElementById(id);

const state = {
  ctx: null,
  stream: null,
  source: null,
  node: null,
  engine: null,
  mode: null,          // 'mic' | 'test'
  trackSettings: null,
  deviceLabel: '',
  latest: null,
  lastVoiced: null,    // 最後に音程が取れたフレーム（記録用）
  procTimes: [],       // 直近の処理時間(ms)
  hopIntervals: [],    // ブロック到着間隔(ms)
  lastArrival: 0,
  history: [],         // { t, cents, midi }
  recorder: null,      // 往復遅延計測中の録音
  loopback: null,      // 往復遅延の結果
  testInfo: null,
};

function setStatus(text) {
  $('status').textContent = text;
}

async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const sel = $('device');
  const current = sel.value;
  sel.innerHTML = '<option value="">（既定のマイク）</option>';
  for (const d of devices.filter((d) => d.kind === 'audioinput')) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `マイク ${sel.length}`;
    sel.append(opt);
  }
  sel.value = current;
}

async function setupContext() {
  await stop();
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(new URL('./audio/capture-worklet.js', import.meta.url));
  const node = new AudioWorkletNode(ctx, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { hopSize: HOP },
  });
  // ノードを処理させ続けるため、無音で出力先につないでおく
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  node.port.onmessage = onBlock;
  state.ctx = ctx;
  state.node = node;
  state.engine = new AnalysisEngine(ctx.sampleRate, { a4: Number($('a4').value) || 440 });
  state.procTimes = [];
  state.hopIntervals = [];
  state.history = [];
  state.lastVoiced = null;
  state.lastArrival = 0;
  if (ctx.state !== 'running') await ctx.resume();
  return ctx;
}

async function startMic() {
  try {
    setStatus('マイクを準備中…');
    const deviceId = $('device').value;
    // 自動ゲイン・ノイズ抑制・エコー除去は倍音バランスを崩し、往復遅延の計測も邪魔するので切る
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const ctx = await setupContext();
    state.stream = stream;
    const track = stream.getAudioTracks()[0];
    state.trackSettings = track.getSettings ? track.getSettings() : {};
    state.deviceLabel = track.label;
    state.source = ctx.createMediaStreamSource(stream);
    state.source.connect(state.node);
    state.mode = 'mic';
    state.testInfo = null;
    setStatus(`マイク: ${track.label || '不明'} / ${ctx.sampleRate}Hz`);
    await listDevices();
  } catch (err) {
    setStatus(`マイクを開けませんでした: ${err.name} ${err.message}`);
    console.error(err);
  }
}

const PROFILES = {
  bowed: [0, -3, -6, -9, -12],
  phone: [-20, 0, -2, -5, -8],
};

async function startTest() {
  const ctx = await setupContext();
  const midi = Number($('testNote').value);
  const f0 = midiToFreq(midi, Number($('a4').value) || 440);
  const rel = PROFILES[$('testProfile').value];
  const amps = rel.map((db) => 0.2 * Math.pow(10, db / 20));
  const real = new Float32Array(amps.length + 1);
  const imag = new Float32Array(amps.length + 1);
  amps.forEach((a, i) => { imag[i + 1] = a; });
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
  osc.frequency.value = f0;
  osc.connect(state.node);
  osc.start();
  state.source = osc;
  state.mode = 'test';
  state.deviceLabel = 'テスト信号';
  state.trackSettings = null;
  const relToH1 = rel.map((db) => db - rel[0]);
  state.testInfo = { f0, relDb: relToH1 };
  setStatus(`テスト信号: ${f0.toFixed(2)}Hz、期待する基音比 ${relToH1.map((v) => `${v >= 0 ? '+' : ''}${v}`).join(' / ')} dB`);
}

async function stop() {
  if (state.source) {
    try { state.source.disconnect(); } catch {}
    if (state.source.stop) try { state.source.stop(); } catch {}
  }
  state.stream?.getTracks().forEach((t) => t.stop());
  if (state.ctx) await state.ctx.close();
  Object.assign(state, { ctx: null, stream: null, source: null, node: null, mode: null, latest: null });
  setStatus('停止中');
}

function onBlock(ev) {
  const { frame, samples } = ev.data;
  const t = performance.now();
  if (state.lastArrival) pushLimited(state.hopIntervals, t - state.lastArrival, 200);
  state.lastArrival = t;
  if (state.recorder) state.recorder.chunks.push({ frame, samples: samples.slice() });
  const engine = state.engine;
  if (!engine) return;
  engine.push(samples, frame);
  const r = engine.analyze();
  pushLimited(state.procTimes, r.procMs, 300);
  state.latest = r;
  if (r.voiced) state.lastVoiced = r;
  // 揺らぎは、外れ値として捨てられなかったフレームだけで計算する
  if (r.voiced && r.stable?.accepted) {
    state.history.push({ t: frame / engine.sampleRate, cents: r.note.cents, midi: r.stable.note.midi });
  }
  const cutoff = frame / engine.sampleRate - 1;
  while (state.history.length && state.history[0].t < cutoff) state.history.shift();
}

function pushLimited(arr, v, max) {
  arr.push(v);
  if (arr.length > max) arr.shift();
}

// ---- 往復遅延 ----

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function measureLoopback() {
  const ctx = state.ctx;
  if (!ctx || state.mode !== 'mic') {
    $('loopbackResult').textContent = '先に「マイク開始」を押してください。';
    return;
  }
  const fs = ctx.sampleRate;
  const chirp = makeChirp(fs);
  const buf = ctx.createBuffer(1, chirp.length, fs);
  buf.copyToChannel(chirp, 0);
  const results = [];
  const scores = [];
  $('loopbackResult').textContent = '計測中…';
  for (let trial = 0; trial < 5; trial++) {
    state.recorder = { chunks: [] };
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.3;
    src.start(t0);
    const playFrame = Math.round(t0 * fs);
    await wait(1100);
    const chunks = state.recorder.chunks;
    state.recorder = null;
    if (!chunks.length) continue;
    const first = chunks[0].frame;
    const total = chunks[chunks.length - 1].frame + chunks[chunks.length - 1].samples.length - first;
    const rec = new Float32Array(total);
    for (const c of chunks) rec.set(c.samples, c.frame - first);
    // 再生予定時刻から 600ms 後までを探す
    const from = Math.max(0, playFrame - first);
    const to = Math.min(rec.length, from + Math.round(0.6 * fs) + chirp.length);
    const { index, score } = findTemplate(rec.subarray(from, to), chirp);
    scores.push(score);
    if (index >= 0 && score >= 8) results.push((index / fs) * 1000);
    $('loopbackResult').textContent = `計測中… ${trial + 1}/5`;
  }
  if (!results.length) {
    state.loopback = { ok: false, scores };
    $('loopbackResult').textContent = `検出できませんでした（スコア ${scores.map((s) => s.toFixed(1)).join(', ')}、8以上で成功）。音量を上げて再試行してください。`;
    return;
  }
  state.loopback = {
    ok: true,
    medianMs: median(results),
    minMs: Math.min(...results),
    maxMs: Math.max(...results),
    trialsMs: results,
    scores,
    outputLatencyMs: (ctx.outputLatency || 0) * 1000,
    baseLatencyMs: (ctx.baseLatency || 0) * 1000,
  };
  const lb = state.loopback;
  $('loopbackResult').textContent = `往復 ${lb.medianMs.toFixed(1)} ms（${results.length}/5回成功、${lb.minMs.toFixed(1)}〜${lb.maxMs.toFixed(1)} ms）`;
}

// ---- 表示 ----

function fmt(v, digits = 1, unit = '') {
  return Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '--';
}

function latencyRows() {
  const ctx = state.ctx;
  const engine = state.engine;
  if (!ctx || !engine) return [];
  const r = state.latest;
  const d = engine.windowDelay(r?.harmonicWindow || 0);
  const proc = [...state.procTimes].sort((a, b) => a - b);
  const procMed = proc.length ? proc[proc.length >> 1] : NaN;
  const procMax = proc.length ? proc[proc.length - 1] : NaN;
  const hopMed = state.hopIntervals.length ? median(state.hopIntervals) : NaN;
  const trackLatency = state.trackSettings?.latency;
  // 入力側の遅延: 往復計測があれば (往復 − 出力遅延)、なければブラウザ申告値
  let inputMs = NaN, inputSrc = '';
  if (state.loopback?.ok) {
    inputMs = state.loopback.medianMs - state.loopback.outputLatencyMs;
    inputSrc = '往復−出力遅延';
  } else if (Number.isFinite(trackLatency)) {
    inputMs = trackLatency * 1000;
    inputSrc = 'ブラウザ申告';
  }
  const hopMs = (HOP / ctx.sampleRate) * 1000;
  const totalPitch = inputMs + hopMs / 2 + d.pitch * 1000 + procMed + 1000 / 60;
  return [
    ['サンプルレート', `${ctx.sampleRate} Hz`],
    ['baseLatency', fmt(ctx.baseLatency * 1000, 1, ' ms')],
    ['outputLatency', fmt((ctx.outputLatency ?? NaN) * 1000, 1, ' ms')],
    ['入力トラック latency', fmt((trackLatency ?? NaN) * 1000, 1, ' ms')],
    ['ブロック長 / 到着間隔', `${fmt(hopMs, 1, ' ms')} / ${fmt(hopMed, 1, ' ms')}`],
    ['ピッチ解析窓', `${fmt(d.pitchWindow * 1000, 0, ' ms')}（遅れ約 ${fmt(d.pitch * 1000, 0, ' ms')}）`],
    ['倍音解析窓', r?.harmonicWindow ? `${fmt((r.harmonicWindow / ctx.sampleRate) * 1000, 0, ' ms')}（遅れ約 ${fmt(d.harmonics * 1000, 0, ' ms')}）` : '--'],
    ['処理時間 中央値 / 最大', `${fmt(procMed, 2, ' ms')} / ${fmt(procMax, 2, ' ms')}`],
    ['往復遅延（実測）', state.loopback?.ok ? fmt(state.loopback.medianMs, 1, ' ms') : '未計測'],
    ['音→表示 の推定', Number.isFinite(totalPitch) ? `約 ${fmt(totalPitch, 0, ' ms')}（入力遅延は${inputSrc}）` : '入力遅延が不明（往復遅延を測ってください）'],
  ];
}

function render() {
  requestAnimationFrame(render);
  const r = state.latest;
  const voiced = r?.voiced;
  // 表示は外れ値除去・中央値をかけた stable を使う
  const s = r?.stable;
  $('note').textContent = s ? s.note.name : '--';
  $('note').classList.toggle('dim', !s || s.held);
  $('cents').textContent = s ? `${s.note.cents >= 0 ? '+' : ''}${s.note.cents.toFixed(1)} cent` : '-- cent';
  $('centsBar').style.left = s ? `${50 + Math.max(-50, Math.min(50, s.note.cents))}%` : '50%';
  $('freq').textContent = s ? `${s.freq.toFixed(3)} Hz（このフレーム ${r.freq ? r.freq.toFixed(3) : '--'}）` : '--';
  $('clarity').textContent = r?.freq ? r.clarity.toFixed(3) : '--';
  $('level').textContent = r ? fmt(r.rmsDb, 1, ' dBFS') : '--';

  const h = state.history;
  if (h.length > 5 && s) {
    const same = h.filter((p) => p.midi === s.note.midi).map((p) => p.cents);
    const mean = same.reduce((s, v) => s + v, 0) / same.length;
    const sd = Math.sqrt(same.reduce((s, v) => s + (v - mean) ** 2, 0) / same.length);
    $('stability').textContent = `±${sd.toFixed(1)} cent（${same.length}点）`;
  } else {
    $('stability').textContent = '--';
  }

  const tbody = $('harmonics');
  if (voiced && r.harmonics) {
    tbody.innerHTML = r.harmonics.map((x) => `
      <tr><td>${x.n}次</td><td>${x.freq.toFixed(1)} Hz</td>
      <td>${x.relDb >= 0 ? '+' : ''}${x.relDb.toFixed(1)} dB</td>
      <td>${(x.share * 100).toFixed(1)}%</td>
      <td><div class="bar" style="width:${(x.share * 100).toFixed(1)}%"></div></td></tr>`).join('');
  } else {
    tbody.querySelectorAll('tr').forEach((tr) => tr.classList.add('dim'));
  }

  $('latency').innerHTML = latencyRows().map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function report() {
  const ctx = state.ctx;
  const lv = state.lastVoiced;
  const proc = [...state.procTimes].sort((a, b) => a - b);
  const data = {
    time: new Date().toISOString(),
    userAgent: navigator.userAgent,
    mode: state.mode,
    device: state.deviceLabel,
    trackSettings: state.trackSettings,
    sampleRate: ctx?.sampleRate,
    baseLatencyMs: ctx ? ctx.baseLatency * 1000 : null,
    outputLatencyMs: ctx?.outputLatency != null ? ctx.outputLatency * 1000 : null,
    procMedianMs: proc.length ? proc[proc.length >> 1] : null,
    procMaxMs: proc.length ? proc[proc.length - 1] : null,
    loopback: state.loopback,
    test: state.testInfo,
    stability: $('stability').textContent,
    // 押した瞬間に音が出ていなくても、最後に音程が取れたフレームを記録する
    last: lv ? {
      note: lv.note.name,
      cents: +lv.note.cents.toFixed(2),
      freq: +lv.freq.toFixed(3),
      yinFreq: +lv.yinFreq.toFixed(3),
      clarity: +lv.clarity.toFixed(3),
      rmsDb: +lv.rmsDb.toFixed(1),
      shown: lv.stable ? lv.stable.note.name : null,
      harmonicsRelDb: lv.harmonics ? lv.harmonics.map((x) => +x.relDb.toFixed(2)) : null,
    } : null,
  };
  return JSON.stringify(data, null, 2);
}

$('startMic').onclick = startMic;
$('startTest').onclick = startTest;
$('stop').onclick = stop;
$('loopback').onclick = measureLoopback;
$('a4').onchange = () => state.engine?.setA4(Number($('a4').value) || 440);
$('copy').onclick = async () => {
  const text = report();
  $('report').value = text;
  try {
    await navigator.clipboard.writeText(text);
    $('copy').textContent = 'コピーしました';
    setTimeout(() => { $('copy').textContent = '計測結果をコピー'; }, 1500);
  } catch {
    $('report').select();
  }
};
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
listDevices();
requestAnimationFrame(render);

// 自動テスト用
window.__tuneAnalyser = { state, report };
