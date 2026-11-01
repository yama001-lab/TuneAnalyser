// 解析エンジン本体。サンプル列を受け取り、ピッチ・倍音・処理時間をまとめて返す。
// DOMやWeb Audioに依存しないので Node のテストからもそのまま使える。

import { Yin } from './dsp/yin.js';
import { measureHarmonics, subOctaveEvidence, refineF0 } from './dsp/harmonics.js';
import { freqToNote } from './dsp/notes.js';
import { PitchTracker } from './dsp/tracker.js';

// 新しい音の（重ならない）倍音が表示中の音より何倍(パワー比)強ければ切り替えるか
const KEEP_MARGIN = 2;

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
 * @property {number} [subOctaveDb=-27] 1オクターブ下の奇数次倍音がこれ以上あれば、下のオクターブを採用
 * @property {number} [subOctaveMaxFreq=160] 下のオクターブ候補がこれ以下(Hz)のときだけ確かめる（内蔵マイクで基音が弱るのは低音域）
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
      minClarity: 0.8, gateDb: -60, harmonicCount: 5, subOctaveDb: -27, subOctaveMaxFreq: 160, ...options,
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
    this.tracker = new PitchTracker(options.tracker);
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
      yinFreq: 0,
      clarity: 0,
      note: null,
      harmonics: null,
      harmonicWindow: 0,
      voiced: false,
      stable: null,
      trackKept: false,
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
      const valid = this.filled < data.length ? data.subarray(data.length - this.filled) : data;
      let pitch = this.yin.detect(data);
      if (pitch && pitch.freq > 0) pitch = this.checkOctaveBelow(pitch, valid);
      if (pitch && pitch.freq > 0) {
        result.freq = pitch.freq;
        result.clarity = pitch.clarity;
        result.voiced = pitch.clarity >= o.minClarity;
        result.yinFreq = pitch.freq;
        if (result.voiced) {
          const h = measureHarmonics(valid, this.sampleRate, pitch.freq, { count: o.harmonicCount });
          if (h) {
            result.harmonics = h.harmonics;
            result.harmonicWindow = h.windowSize;
            // 倍音から求め直した値が YIN と大きく食い違わなければ、そちらを採用（他の楽器の音に強い）
            const refined = refineF0(h.harmonics);
            if (refined > 0 && Math.abs(1200 * Math.log2(refined / pitch.freq)) < 30) result.freq = refined;
          }
          const resolved = this.resolveWithTrack(valid, result.freq);
          if (resolved) {
            result.freq = resolved.freq;
            result.harmonics = resolved.harmonics;
            result.harmonicWindow = resolved.windowSize;
            result.trackKept = resolved.kept;
          }
          result.note = freqToNote(result.freq, o.a4);
        }
      }
    }
    result.stable = this.tracker.update(result.voiced ? result.freq : 0, this.endFrame / this.sampleRate, o.a4);
    result.procMs = now() - t0;
    return result;
  }

  /**
   * YIN が本当の周期の半分を選んだ（1オクターブ上に誤検出した）可能性を調べる。
   * 2τ にも周期性の谷があり、かつ f/2 の奇数倍にエネルギーがあれば f/2 を採用する。
   */
  checkOctaveBelow(pitch, buffer) {
    const o = this.options;
    const half = pitch.freq / 2;
    if (half < o.minFreq || half > o.subOctaveMaxFreq || pitch.clarity < o.minClarity) return pitch;
    const below = this.yin.candidateAt(pitch.tau * 2);
    if (!below || below.clarity < o.minClarity) return pitch;
    const { ratioDb, oddCount } = subOctaveEvidence(buffer, this.sampleRate, pitch.freq);
    return ratioDb >= o.subOctaveDb && oddCount >= 2 ? below : pitch;
  }

  /**
   * いま表示中の音と違う音が検出されたとき、どちらを採るかを倍音で決める。
   * 他の楽器の音や鳴り残った弦の音が混ざると、YIN は2つの音の共通の周期（例: A1 と D2 から D1）を選ぶことがある。
   * そこで検出値の 1〜3 倍を「新しい音」の候補とし、表示中の音と重ならない倍音（その音にしかない倍音）の
   * 強さを比べる。表示中の音の方が強ければ表示中の音を続け、新しい音が強ければ一番もっともらしい候補に置き換える。
   * @returns {{ freq: number, harmonics: import('./dsp/harmonics.js').Harmonic[], windowSize: number, kept: boolean } | null}
   *   null は検出値をそのまま使う
   */
  resolveWithTrack(buffer, freq) {
    const track = this.tracker.currentFreq();
    if (!track || Math.abs(1200 * Math.log2(freq / track)) <= this.tracker.options.jumpCents) return null;
    const { harmonicCount: count, maxFreq, subOctaveDb } = this.options;
    const power = (list) => list.reduce((sum, h) => sum + h.amp * h.amp, 0);
    const ownOf = (m, f, other) => m.harmonics.filter((h) => !isMultiple(h.n * f, other));

    // 検出値の倍音のうち、k 倍の音でも表示中の音でも説明できない倍音がほとんどなければ、k 倍の音が本体
    // （C1 と出たが実際は D2 と G2 が混ざっていた、など）。判定基準はオクターブ下の確認と同じ
    let base = freq;
    const raw = measureHarmonics(buffer, this.sampleRate, freq, { count: 6 });
    if (!raw) return null;
    for (const k of [3, 2]) {
      if (freq * k > maxFreq) continue;
      const rest = raw.harmonics.filter((h) => !isMultiple(h.n * freq, track));
      const explained = rest.filter((h) => h.n % k === 0);
      const other = rest.filter((h) => h.n % k !== 0);
      if (!explained.length || power(explained) <= 0) continue;
      const floor = Math.max(...explained.map((h) => h.amp)) * Math.pow(10, -35 / 20);
      const ratioDb = 10 * Math.log10((power(other) + 1e-30) / power(explained));
      if (!(ratioDb >= subOctaveDb && other.filter((h) => h.amp >= floor).length >= 2)) {
        base = freq * k;
        break;
      }
    }
    // 表示中の音の整数倍（オクターブ上など）は倍音では区別できないのでトラッカーに任せる
    if (isMultiple(base, track)) return null;
    const m = measureHarmonics(buffer, this.sampleRate, base, { count });
    if (!m) return null;
    const own = ownOf(m, base, track);
    if (!own.length) return null;
    const best = { f: base, m, own, power: power(own) };

    const mine = measureHarmonics(buffer, this.sampleRate, track, { count });
    if (!mine) return null;
    const trackOwn = ownOf(mine, track, best.f);
    let switchTo = false;
    if (!trackOwn.length) {
      // 新しい音が表示中の音の 1/k（D2 → D1 など）。新しい音にしかない倍音がはっきりあるときだけ切り替える
      const shared = best.m.harmonics.filter((h) => isMultiple(h.n * best.f, track));
      const floor = Math.max(...shared.map((h) => h.amp)) * Math.pow(10, -35 / 20);
      const ratioDb = 10 * Math.log10((best.power + 1e-30) / (power(shared) + 1e-30));
      switchTo = ratioDb >= subOctaveDb && best.own.filter((h) => h.amp >= floor).length >= 2;
    } else {
      switchTo = power(trackOwn) * KEEP_MARGIN < best.power;
    }
    const chosen = switchTo ? best.m : mine;
    const center = switchTo ? best.f : track;
    const refined = refineF0(chosen.harmonics);
    const f = refined > 0 && Math.abs(1200 * Math.log2(refined / center)) < 30 ? refined : center;
    return { freq: f, harmonics: chosen.harmonics, windowSize: chosen.windowSize, kept: !switchTo };
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
 * @property {number} freq     倍音から求め直した基本周波数（求められなければ YIN の値）
 * @property {number} yinFreq  YIN の推定値
 * @property {number} clarity
 * @property {{name:string,midi:number,cents:number,target:number}|null} note
 * @property {import('./dsp/harmonics.js').Harmonic[]|null} harmonics
 * @property {number} harmonicWindow
 * @property {boolean} voiced
 * @property {{freq:number,note:{name:string,midi:number,cents:number,target:number},accepted:boolean,held:boolean}|null} stable
 *   表示用の安定したピッチ（外れ値除去＋中央値）。freq/note はフレームごとの生の推定
 * @property {boolean} trackKept  他の音を検出したが、表示中の音がまだ鳴っているので維持した
 * @property {number} procMs
 */

/** f が base の整数倍（±2%）か */
function isMultiple(f, base) {
  const k = Math.round(f / base);
  return k >= 1 && Math.abs(f / (k * base) - 1) < 0.02;
}
