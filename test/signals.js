// テスト用の合成信号

/**
 * 倍音を持つ音を作る
 * @param {object} p
 * @param {number} p.f0
 * @param {number} p.sampleRate
 * @param {number} p.seconds
 * @param {number[]} p.amps         1次から順の振幅
 * @param {number} [p.inharmonicity=0] 弦の B 係数: f_k = k f0 √(1 + B k²)
 * @param {number} [p.noise=0]      白色ノイズの振幅(RMS)
 * @param {number} [p.vibratoCents=0]
 * @param {number} [p.vibratoHz=5]
 * @param {number} [p.seed=1]
 */
export function tone({ f0, sampleRate, seconds, amps, inharmonicity = 0, noise = 0, vibratoCents = 0, vibratoHz = 5, seed = 1 }) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const phases = amps.map((_, i) => (i * 0.7) % (2 * Math.PI));
  let rand = seed >>> 0;
  const random = () => {
    rand = (rand * 1664525 + 1013904223) >>> 0;
    return rand / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const fNow = f0 * Math.pow(2, (vibratoCents * Math.sin(2 * Math.PI * vibratoHz * t)) / 1200);
    let v = 0;
    for (let k = 0; k < amps.length; k++) {
      const h = k + 1;
      const fk = fNow * h * Math.sqrt(1 + inharmonicity * h * h);
      phases[k] += (2 * Math.PI * fk) / sampleRate;
      v += amps[k] * Math.sin(phases[k]);
    }
    if (noise > 0) {
      // Box-Muller
      const u1 = Math.max(1e-12, random()), u2 = random();
      v += noise * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    out[i] = v;
  }
  return out;
}

export const dbToAmp = (db) => Math.pow(10, db / 20);
