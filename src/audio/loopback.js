// スピーカー → マイクの往復遅延を測る。短いチャープを鳴らし、録音中の位置を相互相関で探す。
// 測れるのは「出力遅延＋入力遅延＋音の伝わる時間（10cmで約0.3ms）」の合計。

/** 1k→6kHz、20ms のチャープ（Hann 包絡） */
export function makeChirp(sampleRate, { seconds = 0.02, f1 = 1000, f2 = 6000, amp = 0.8 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const k = (f2 - f1) / seconds;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = amp * env * Math.sin(2 * Math.PI * (f1 * t + 0.5 * k * t * t));
  }
  return out;
}

/**
 * recorded の中から template の位置を探す
 * @returns {{ index: number, score: number }} score はピーク÷相関の RMS（大きいほど確か。8以上を目安）
 */
export function findTemplate(recorded, template) {
  const lags = recorded.length - template.length;
  if (lags <= 0) return { index: -1, score: 0 };
  const corr = new Float64Array(lags);
  let best = 0, bestIdx = -1, sumSq = 0;
  for (let l = 0; l < lags; l++) {
    let s = 0;
    for (let i = 0; i < template.length; i++) s += recorded[l + i] * template[i];
    corr[l] = s;
    sumSq += s * s;
    if (Math.abs(s) > best) { best = Math.abs(s); bestIdx = l; }
  }
  const rms = Math.sqrt(sumSq / lags);
  return { index: bestIdx, score: rms > 0 ? best / rms : 0 };
}

export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
