import test from 'node:test';
import assert from 'node:assert/strict';
import { coarseNoHover, pointerSeekRatio } from '../src/player-touch.ts';

test('scrub position is clamped to the bar', () => {
  assert.equal(pointerSeekRatio(10, 0, 100), 0.1);
  assert.equal(pointerSeekRatio(-20, 0, 100), 0);
  assert.equal(pointerSeekRatio(400, 10, 100), 1);
  assert.equal(pointerSeekRatio(5, 0, 0), 0);
});

test('touch playback stays off when the browser has no pointer query', () => {
  if (typeof matchMedia === 'function') return;
  assert.equal(coarseNoHover(), false);
});
