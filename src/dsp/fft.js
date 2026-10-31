// 基数2の反復型FFT（複素数・インプレース）。サイズごとに回転因子とビット反転表を使い回す。

const plans = new Map();

function getPlan(n) {
  let plan = plans.get(n);
  if (plan) return plan;
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of 2: ${n}`);
  const rev = new Uint32Array(n);
  let bits = 0;
  while ((1 << bits) < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  plan = { rev, cos, sin };
  plans.set(n, plan);
  return plan;
}

/**
 * re/im を上書きしてFFTする。inverse=true のときは逆変換（1/n のスケーリング込み）。
 * @param {Float64Array} re
 * @param {Float64Array} im
 * @param {boolean} [inverse]
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  const { rev, cos, sin } = getPlan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = wr * re[b] - wi * im[b];
        const ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
