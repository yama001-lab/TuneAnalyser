// YIN 基本周波数推定（de Cheveigné & Kawahara, 2002）。
// 差分関数の相互相関項をFFTで計算するので、E1(41Hz)を扱える長い窓でも軽い。

import { fft, nextPow2 } from './fft.js';

/**
 * @typedef {object} YinOptions
 * @property {number} [minFreq=30]   検出する最低周波数(Hz)。5弦のB0(30.9Hz)まで想定
 * @property {number} [maxFreq=1200] 検出する最高周波数(Hz)
 * @property {number} [threshold=0.12] 累積平均正規化差分(CMNDF)の閾値
 */

export class Yin {
  /**
   * @param {number} sampleRate
   * @param {YinOptions} [options]
   */
  constructor(sampleRate, options = {}) {
    const { minFreq = 30, maxFreq = 1200, threshold = 0.12 } = options;
    this.sampleRate = sampleRate;
    this.threshold = threshold;
    this.tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
    this.tauMax = Math.ceil(sampleRate / minFreq);
    // 積分窓は最長周期以上にする（最低音で約1周期分の比較）
    this.windowSize = this.tauMax;
    /** 1回の推定に必要なサンプル数 */
    this.frameSize = this.windowSize + this.tauMax + 1;
    this.fftSize = nextPow2(this.frameSize + this.windowSize);
    this.reA = new Float64Array(this.fftSize);
    this.imA = new Float64Array(this.fftSize);
    this.reB = new Float64Array(this.fftSize);
    this.imB = new Float64Array(this.fftSize);
    this.diff = new Float64Array(this.tauMax + 2);
    this.cmndf = new Float64Array(this.tauMax + 2);
  }

  /**
   * frame の末尾 frameSize サンプルからピッチを推定する。
   * @param {Float32Array|Float64Array} frame
   * @returns {{ freq: number, clarity: number, tau: number } | null}
   *   clarity は 1 - CMNDF最小値（1に近いほど周期性が明瞭）
   */
  detect(frame) {
    const { windowSize: W, tauMax, tauMin, fftSize: L } = this;
    if (frame.length < this.frameSize) return null;
    const offset = frame.length - this.frameSize;
    const { reA, imA, reB, imB, diff, cmndf } = this;

    reA.fill(0); imA.fill(0); reB.fill(0); imB.fill(0);
    for (let i = 0; i < this.frameSize; i++) reA[i] = frame[offset + i];
    for (let i = 0; i < W; i++) reB[i] = frame[offset + i];

    // c[τ] = Σ_{j<W} x[j]·x[j+τ] を FFT で
    fft(reA, imA);
    fft(reB, imB);
    for (let k = 0; k < L; k++) {
      const ar = reA[k], ai = imA[k], br = reB[k], bi = -imB[k];
      reA[k] = ar * br - ai * bi;
      imA[k] = ar * bi + ai * br;
    }
    fft(reA, imA, true);

    // d(τ) = e(0) + e(τ) - 2c(τ)。e(τ) は窓をずらした二乗和（逐次更新）
    let e0 = 0;
    for (let j = 0; j < W; j++) {
      const v = frame[offset + j];
      e0 += v * v;
    }
    if (e0 <= 1e-12) return null;
    let eTau = e0;
    diff[0] = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      const out = frame[offset + tau - 1];
      const inn = frame[offset + tau - 1 + W];
      eTau += inn * inn - out * out;
      diff[tau] = Math.max(0, e0 + eTau - 2 * reA[tau]);
    }

    // 累積平均正規化差分
    cmndf[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += diff[tau];
      cmndf[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
    }

    // 閾値を下回る最初の谷を探す（なければ全体の最小値）
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmndf[tau] < this.threshold) {
        while (tau + 1 <= tauMax && cmndf[tau + 1] < cmndf[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let minVal = Infinity;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (cmndf[tau] < minVal) {
          minVal = cmndf[tau];
          best = tau;
        }
      }
    }
    if (best <= tauMin || best >= tauMax) {
      // 範囲の端は真の谷か判定できない
      return { freq: 0, clarity: 0, tau: 0 };
    }

    // 生の差分関数で放物線補間（CMNDFより偏りが少ない）
    const a = diff[best - 1], b = diff[best], c = diff[best + 1];
    const denom = a - 2 * b + c;
    const shift = denom > 0 ? (0.5 * (a - c)) / denom : 0;
    const tau = best + Math.max(-1, Math.min(1, shift));
    return {
      freq: this.sampleRate / tau,
      clarity: Math.max(0, Math.min(1, 1 - cmndf[best])),
      tau,
    };
  }
}
