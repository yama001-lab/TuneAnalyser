// 1〜N次倍音の振幅を測る。基本周波数の整数倍の付近を Goertzel 法で細かく探し、最大値を採る。
// 弦のインハーモニシティ（高次ほど少し高くなる）と f0 推定誤差を吸収するため ±searchCents を探索する。

const hannCache = new Map();

function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
    if (hannCache.size > 64) hannCache.delete(hannCache.keys().next().value);
  }
  return w;
}

/** 窓掛け済み信号 x の周波数 f (Hz) における正弦波振幅（ピーク値）を返す */
function goertzelAmplitude(x, n, f, sampleRate, windowSum) {
  const w = (2 * Math.PI * f) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / windowSum;
}

/**
 * @typedef {object} Harmonic
 * @property {number} n        倍音次数（1=基音）
 * @property {number} freq     実測ピーク周波数(Hz)
 * @property {number} amp      振幅（ピーク値、フルスケール=1）
 * @property {number} dbfs     振幅の dBFS
 * @property {number} relDb    基音に対する相対レベル(dB)
 * @property {number} share    1〜N次の合計エネルギーに占める割合(0..1)
 */

/**
 * @param {Float32Array|Float64Array} buffer  末尾が最新の時間波形
 * @param {number} sampleRate
 * @param {number} f0
 * @param {object} [options]
 * @param {number} [options.count=5]        何次まで測るか
 * @param {number} [options.periods=6]      解析窓に含める基本周期の数
 * @param {number} [options.maxWindow=8192] 解析窓の上限サンプル数
 * @param {number} [options.searchCents=15] 整数倍からの探索幅(セント)
 * @returns {{ harmonics: Harmonic[], windowSize: number } | null}
 */
export function measureHarmonics(buffer, sampleRate, f0, options = {}) {
  const { count = 5, periods = 6, maxWindow = 8192, searchCents = 15 } = options;
  if (!(f0 > 0)) return null;
  const n = Math.min(buffer.length, maxWindow, Math.max(512, Math.round((periods * sampleRate) / f0)));
  const w = hann(n);
  const x = new Float64Array(n);
  const offset = buffer.length - n;
  let windowSum = 0;
  for (let i = 0; i < n; i++) {
    x[i] = buffer[offset + i] * w[i];
    windowSum += w[i];
  }

  const steps = 6;
  const harmonics = [];
  for (let k = 1; k <= count; k++) {
    const center = k * f0;
    if (center >= sampleRate * 0.45) {
      harmonics.push({ n: k, freq: center, amp: 0 });
      continue;
    }
    // 粗い探索 → 最大点の周りで放物線補間
    let bestI = 0, bestAmp = -1;
    const amps = [];
    for (let i = -steps; i <= steps; i++) {
      const f = center * Math.pow(2, (searchCents * i) / steps / 1200);
      const a = goertzelAmplitude(x, n, f, sampleRate, windowSum);
      amps.push(a);
      if (a > bestAmp) { bestAmp = a; bestI = i; }
    }
    let shift = 0;
    let amp = bestAmp;
    const idx = bestI + steps;
    if (idx > 0 && idx < amps.length - 1) {
      const [a, b, c] = [amps[idx - 1], amps[idx], amps[idx + 1]].map((v) => 20 * Math.log10(v + 1e-20));
      const denom = a - 2 * b + c;
      if (denom < 0) {
        shift = (0.5 * (a - c)) / denom;
        amp = Math.pow(10, (b - 0.25 * (a - c) * shift) / 20);
      }
    }
    const freq = center * Math.pow(2, (searchCents * (bestI + shift)) / steps / 1200);
    harmonics.push({ n: k, freq, amp });
  }

  const fundamental = harmonics[0].amp;
  const total = harmonics.reduce((s, h) => s + h.amp * h.amp, 0);
  for (const h of harmonics) {
    h.dbfs = 20 * Math.log10(h.amp + 1e-20);
    h.relDb = 20 * Math.log10((h.amp + 1e-20) / (fundamental + 1e-20));
    h.share = total > 0 ? (h.amp * h.amp) / total : 0;
  }
  return { harmonics, windowSize: n };
}

/**
 * f の半分を基音とみなしたとき、奇数次（f/2, 3f/2, 5f/2, 7f/2）に偶数次（f, 2f, 3f, 4f）と比べて
 * どれだけエネルギーがあるかを調べる。多ければ本当の基音は f/2（オクターブ上に誤検出している）。
 * スマホ内蔵マイクは低域が弱く、コントラバスの基音と3次倍音が小さいと YIN が半分の周期を選びやすい。
 * @returns {{ ratioDb: number, oddCount: number }}
 *   ratioDb: 奇数次÷偶数次のエネルギー比(dB)
 *   oddCount: 最も強い偶数次から -35dB 以内にある奇数次の本数（他の楽器の音が1本だけ重なった場合と区別する）
 */
export function subOctaveEvidence(buffer, sampleRate, f) {
  const m = measureHarmonics(buffer, sampleRate, f / 2, { count: 8, searchCents: 10 });
  if (!m) return { ratioDb: -Infinity, oddCount: 0 };
  let odd = 0, even = 0, maxEven = 0;
  for (const h of m.harmonics) {
    if (h.n % 2) odd += h.amp * h.amp;
    else {
      even += h.amp * h.amp;
      maxEven = Math.max(maxEven, h.amp);
    }
  }
  const floor = maxEven * Math.pow(10, -35 / 20);
  const oddCount = m.harmonics.filter((h) => h.n % 2 && h.amp >= floor).length;
  return { ratioDb: 10 * Math.log10((odd + 1e-30) / (even + 1e-30)), oddCount };
}

/**
 * 倍音のピーク周波数から基本周波数を推定し直す（f_k / k の、振幅で重み付けした中央値）。
 * 倍音ごとの狭い帯域だけを見るので、倍音の間にある他の楽器の音の影響を受けにくい。
 * 中央値なので、たまたま他の楽器の音が重なった倍音が1本あっても引きずられない。
 * @param {Harmonic[]} harmonics
 * @param {number} [floorDb=-40] 最も強い倍音からこれ以上弱い倍音は使わない
 */
export function refineF0(harmonics, floorDb = -40) {
  const maxAmp = Math.max(...harmonics.map((h) => h.amp));
  if (!(maxAmp > 0)) return 0;
  const floor = maxAmp * Math.pow(10, floorDb / 20);
  const est = harmonics
    .filter((h) => h.amp >= floor && h.amp > 0)
    .map((h) => ({ f: h.freq / h.n, w: h.amp }))
    .sort((a, b) => a.f - b.f);
  const total = est.reduce((s, e) => s + e.w, 0);
  let acc = 0;
  for (const e of est) {
    acc += e.w;
    if (acc >= total / 2) return e.f;
  }
  return 0;
}
