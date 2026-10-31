import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChirp, findTemplate, median } from '../src/audio/loopback.js';

test('チャープの位置を雑音・減衰下でもサンプル単位で見つける', () => {
  const sampleRate = 48000;
  const chirp = makeChirp(sampleRate);
  const rec = new Float32Array(sampleRate * 0.6);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
  for (let i = 0; i < rec.length; i++) rec[i] = 0.02 * rnd();
  const delay = 6123; // 127.6ms
  for (let i = 0; i < chirp.length; i++) rec[delay + i] += 0.05 * chirp[i];
  const { index, score } = findTemplate(rec, chirp);
  assert.ok(Math.abs(index - delay) <= 1, `index ${index}`);
  assert.ok(score > 8, `score ${score}`);
});

test('雑音だけならスコアは低い', () => {
  const sampleRate = 48000;
  const chirp = makeChirp(sampleRate);
  const rec = new Float32Array(sampleRate * 0.6);
  let seed = 3;
  for (let i = 0; i < rec.length; i++) rec[i] = ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.1;
  assert.ok(findTemplate(rec, chirp).score < 8);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});
