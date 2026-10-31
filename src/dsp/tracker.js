// フレームごとのピッチ推定を、表示に使える安定した値にする。
// - 直前の音から jumpCents 以上離れた推定は、confirmFrames 回続くまで採用しない（他の楽器の音や単発のオクターブ誤りを捨てる）
// - 採用した値の直近 medianFrames 個の中央値を出す（メーターの細かいぶれを抑える）
// - 音が途切れても holdMs の間は最後の値を保持する

import { freqToNote } from './notes.js';

/**
 * @typedef {object} TrackerOptions
 * @property {number} [jumpCents=50]
 * @property {number} [confirmFrames=3]
 * @property {number} [medianFrames=5]
 * @property {number} [holdMs=300]
 */

export class PitchTracker {
  /** @param {TrackerOptions} [options] */
  constructor(options = {}) {
    this.options = { jumpCents: 50, confirmFrames: 3, medianFrames: 5, holdMs: 300, ...options };
    this.reset();
  }

  reset() {
    /** 採用中の音の、直近の推定値（半音単位の対数周波数） */
    this.recent = [];
    /** 別の音への切り替え候補 */
    this.candidate = [];
    this.lastVoicedTime = -Infinity;
    this.output = null;
  }

  /**
   * @param {number} freq    0 なら無音・音程なし
   * @param {number} time    秒
   * @param {number} [a4=440]
   * @returns {{ freq: number, note: ReturnType<typeof freqToNote>, accepted: boolean, held: boolean } | null}
   *   accepted: このフレームの推定を採用したか（false なら外れ値として捨てたか保持中）
   */
  update(freq, time, a4 = 440) {
    const o = this.options;
    let accepted = false;
    if (freq > 0) {
      const m = 12 * Math.log2(freq / 440);
      const near = (ref) => Math.abs(m - ref) * 100 <= o.jumpCents;
      if (this.recent.length && near(median(this.recent))) {
        this.push(this.recent, m, o.medianFrames);
        this.candidate = [];
        accepted = true;
      } else {
        if (this.candidate.length && !near(median(this.candidate))) this.candidate = [];
        this.candidate.push(m);
        if (this.candidate.length >= o.confirmFrames) {
          this.recent = this.candidate.slice(-o.medianFrames);
          this.candidate = [];
          accepted = true;
        }
      }
      if (accepted) this.lastVoicedTime = time;
    }

    if (!this.recent.length || time - this.lastVoicedTime > o.holdMs / 1000) {
      if (this.recent.length) this.recent = [];
      return null;
    }
    const f = 440 * Math.pow(2, median(this.recent) / 12);
    return { freq: f, note: freqToNote(f, a4), accepted, held: !accepted };
  }

  /** 表示中の音の周波数（なければ null） */
  currentFreq() {
    return this.recent.length ? 440 * Math.pow(2, median(this.recent) / 12) : null;
  }

  push(arr, v, max) {
    arr.push(v);
    if (arr.length > max) arr.shift();
  }
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
