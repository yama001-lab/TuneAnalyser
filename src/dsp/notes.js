// 周波数 ⇔ 音名・セント。音名は国際式（コントラバスの開放E = E1）

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * @param {number} freq
 * @param {number} [a4=440]
 * @returns {{ name: string, midi: number, cents: number, target: number } | null}
 */
export function freqToNote(freq, a4 = 440) {
  if (!(freq > 0)) return null;
  const midiFloat = 69 + 12 * Math.log2(freq / a4);
  const midi = Math.round(midiFloat);
  const cents = (midiFloat - midi) * 100;
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[((midi % 12) + 12) % 12] + octave;
  return { name, midi, cents, target: midiToFreq(midi, a4) };
}

export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/** 2つの周波数の差（セント） */
export function centsBetween(f, ref) {
  return 1200 * Math.log2(f / ref);
}
