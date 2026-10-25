import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  WALK_ENTRY_LOOK,
  WALK_ENTRY_POSITION,
  walkEntryPitch,
  walkEntryYaw,
  walkLookHeadings,
  walkWarmupCamera,
} from '../src/walk-entry-warmup.ts';

test('desktop walk spawn and its look angles stay tied together', () => {
  assert.deepEqual(WALK_ENTRY_POSITION, { x: 13, y: 5.5, z: 12.5 });
  assert.deepEqual(WALK_ENTRY_LOOK, { x: 11, y: 5.3, z: 0 });
  const direction = new THREE.Vector3(
    WALK_ENTRY_LOOK.x - WALK_ENTRY_POSITION.x,
    WALK_ENTRY_LOOK.y - WALK_ENTRY_POSITION.y,
    WALK_ENTRY_LOOK.z - WALK_ENTRY_POSITION.z,
  ).normalize();
  assert.equal(walkEntryYaw(), Math.atan2(-direction.x, -direction.z));
  assert.equal(walkEntryPitch(), Math.asin(THREE.MathUtils.clamp(direction.y, -0.9, 0.9)));
});

test('the first heading is the opening view and the rest are quarter turns', () => {
  const headings = walkLookHeadings();
  assert.equal(headings.length, 4);
  assert.equal(headings[0], walkEntryYaw());
  for (let index = 1; index < headings.length; index++) {
    assert.ok(Math.abs(headings[index] - headings[index - 1] - Math.PI / 2) < 1e-10);
  }
  assert.deepEqual(walkLookHeadings(1, 2), [1, 1 + Math.PI]);
});

test('a warmup camera is its own view at the requested pose', () => {
  const camera = walkWarmupCamera(WALK_ENTRY_POSITION, 1.25, -0.2, 1.5, 70);
  assert.equal(camera.position.x, 13);
  assert.equal(camera.position.y, 5.5);
  assert.equal(camera.position.z, 12.5);
  assert.equal(camera.rotation.order, 'YXZ');
  assert.equal(camera.rotation.y, 1.25);
  assert.equal(camera.rotation.x, -0.2);
  assert.equal(camera.rotation.z, 0);
  assert.equal(camera.fov, 70);
  assert.equal(camera.aspect, 1.5);
});
