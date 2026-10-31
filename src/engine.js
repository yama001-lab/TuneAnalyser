// 解析エンジン本体。サンプル列を受け取り、ピッチ・倍音・処理時間をまとめて返す。
// DOMやWeb Audioに依存しないので Node のテストからもそのまま使える。

import { Yin } from './dsp/yin.js';
import { measureHarmonics } from './dsp/harmonics.js';
import { freqToNote } from './dsp/notes.js';

const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

/**
 * @typedef {object} EngineOptions
 * @property {number} [a4=440]           基準ピッチ
 * @property {number} [minFreq=30]
 * @property {number} [maxFreq=1200]
 * @property {number} [yinThreshold=0.12]
 * @property {number} [minClarity=0.8]   これ未満は「音程なし」とみなす
 * @property {number} [gateDb=-60]       これ未満の音量は無音とみなす(dBFS RMS)
 * @property {number} [harmonicCount=5]
 */

export class AnalysisEngine {
  /**
   * @param {number} sampleRate
   * @param {EngineOptions} [options]
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.options = {
      a4: 440, minFreq: 30, maxFreq: 1200, yinThreshold: 0.12,
      minClarity: 0.8, gateDb: -60, harmonicCount: 5, ...options,
    };
    this.yin = new Yin(sampleRate, {
      minFreq: this.options.minFreq,
      maxFreq: this.options.maxFreq,
      threshold: this.options.yinThreshold,
    });
    // 倍音解析は最大 8192 サンプル、YIN は frameSize を使う。大きい方を保持
    this.bufferSize = Math.max(8192, this.yin.frameSize);
    this.buffer = new Float32Array(this.bufferSize);
    this.linear = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.filled = 0;
    /** 直近に push したサンプルの、オーディオコンテキスト上のフレーム番号（末尾の次） */
    this.endFrame = 0;
  }

  setA4(a4) {
    this.options.a4 = a4;
  }

  /**
   * @param {Float32Array} samples
   * @param {number} [startFrame] 先頭サンプルのフレーム番号（遅延計測用、省略可）
   */
  push(samples, startFrame) {
    const size = this.bufferSize;
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % size;
    }
    this.filled = Math.min(size, this.filled + samples.length);
    this.endFrame = startFrame !== undefined ? startFrame + samples.length : this.endFrame + samples.length;
  }

  /** リングバッファを時系列順に並べた配列（末尾が最新） */
  latest() {
    const size = this.bufferSize;
    const head = this.writePos;
    this.linear.set(this.buffer.subarray(head), 0);
    this.linear.set(this.buffer.subarray(0, head), size - head);
    return this.linear;
  }

  /**
   * 現時点のバッファを解析する
   * @returns {AnalysisResult}
   */
  analyze() {
    const t0 = now();
    const o = this.options;
    const result = {
      endFrame: this.endFrame,
      rmsDb: -Infinity,
      freq: 0,
      clarity: 0,
      note: null,
      harmonics: null,
      harmonicWindow: 0,
      voiced: false,
      procMs: 0,
    };
    if (this.filled < this.yin.frameSize) {
      result.procMs = now() - t0;
      return result;
    }
    const data = this.latest();

    // 音量は YIN と同じ長さの区間で
    let sum = 0;
    const from = data.length - this.yin.frameSize;
    for (let i = from; i < data.length; i++) sum += data[i] * data[i];
    result.rmsDb = 10 * Math.log10(sum / this.yin.frameSize + 1e-20);

    if (result.rmsDb >= o.gateDb) {
      const pitch = this.yin.detect(data);
      if (pitch && pitch.freq > 0) {
        result.freq = pitch.freq;
        result.clarity = pitch.clarity;
        result.voiced = pitch.clarity >= o.minClarity;
        if (result.voiced) {
          result.note = freqToNote(pitch.freq, o.a4);
          const valid = this.filled < data.length ? data.subarray(data.length - this.filled) : data;
          const h = measureHarmonics(valid, this.sampleRate, pitch.freq, { count: o.harmonicCount });
          if (h) {
            result.harmonics = h.harmonics;
            result.harmonicWindow = h.windowSize;
          }
        }
      }
    }
    result.procMs = now() - t0;
    return result;
  }

  /**
   * 解析窓による遅れ（秒）。窓の中心が「いま」からどれだけ前か、で見積もる。
   * pitch: YIN の窓、harmonics: 倍音窓（基音が低いほど長い）
   */
  windowDelay(harmonicWindow = 0) {
    return {
      pitch: this.yin.frameSize / 2 / this.sampleRate,
      harmonics: harmonicWindow / 2 / this.sampleRate,
      pitchWindow: this.yin.frameSize / this.sampleRate,
    };
  }
}

/**
 * @typedef {object} AnalysisResult
 * @property {number} endFrame
 * @property {number} rmsDb
 * @property {number} freq
 * @property {number} clarity
 * @property {{name:string,midi:number,cents:number,target:number}|null} note
 * @property {import('./dsp/harmonics.js').Harmonic[]|null} harmonics
 * @property {number} harmonicWindow
 * @property {boolean} voiced
 * @property {number} procMs
 */
