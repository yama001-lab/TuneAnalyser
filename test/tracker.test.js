import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PitchTracker } from '../src/dsp/tracker.js';

const HOP = 1024 / 48000;

test('単発の外れ値（オクターブ上・他の音）は表示に出ない', () => {
  const t = new PitchTracker();
  const seq = [55, 55, 55, 110, 55, 55, 330, 55, 55.1, 54.9];
  const out = seq.map((f, i) => t.update(f, i * HOP));
  for (const o of out.slice(2)) assert.equal(o.note.name, 'A1');
});

test('別の音が confirmFrames 回続けば切り替わる', () => {
  const t = new PitchTracker({ confirmFrames: 3 });
  let i = 0;
  for (; i < 5; i++) t.update(55, i * HOP);
  assert.equal(t.update(73.42, i++ * HOP).note.name, 'A1');
  assert.equal(t.update(73.42, i++ * HOP).note.name, 'A1');
  assert.equal(t.update(73.42, i++ * HOP).note.name, 'D2');
});

test('音が途切れても holdMs の間は保持し、その後は null', () => {
  const t = new PitchTracker({ holdMs: 300 });
  for (let i = 0; i < 5; i++) t.update(55, i * HOP);
  const held = t.update(0, 4 * HOP + 0.2);
  assert.equal(held.note.name, 'A1');
  assert.equal(held.held, true);
  assert.equal(t.update(0, 4 * HOP + 0.4), null);
});

test('中央値で細かいぶれを抑える', () => {
  const t = new PitchTracker({ medianFrames: 5 });
  const cents = [0, 8, -8, 6, -6, 7, -7];
  let o;
  cents.forEach((c, i) => { o = t.update(55 * Math.pow(2, c / 1200), i * HOP); });
  assert.ok(Math.abs(o.note.cents) < 6.5);
});
