import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  OVERVIEW_WALK_HINT,
  WALK_LOOK_HINT,
  isSteamConsoleUa,
  shouldHideCursor,
  shouldShowOverviewHint,
  shouldShowWalkLookHint,
} from '../src/desktop-cursor.ts';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const walk = readFileSync(new URL('../src/store-walk.ts', import.meta.url), 'utf8');
const scene = readFileSync(new URL('../src/three-scene.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('a desktop mouse is not a console cursor', () => {
  assert.equal(shouldHideCursor({ tv: false, steam: false, gamepadDriven: false, mouseActive: false }), false);
  assert.equal(shouldHideCursor({ tv: false, steam: false, gamepadDriven: false, mouseActive: true }), false);
});

test('a television keeps the pointer hidden', () => {
  assert.equal(shouldHideCursor({ tv: true, steam: false, gamepadDriven: false, mouseActive: true }), true);
});

test('Steam and a live gamepad hide the pointer until the mouse moves', () => {
  assert.equal(shouldHideCursor({ tv: false, steam: true, gamepadDriven: false, mouseActive: false }), true);
  assert.equal(shouldHideCursor({ tv: false, steam: true, gamepadDriven: false, mouseActive: true }), false);
  assert.equal(shouldHideCursor({ tv: false, steam: false, gamepadDriven: true, mouseActive: false }), true);
  assert.equal(shouldHideCursor({ tv: false, steam: false, gamepadDriven: true, mouseActive: true }), false);
  assert.equal(isSteamConsoleUa('Mozilla/5.0 (X11; Linux x86_64; Steam Deck) Chrome/120.0'), true);
  assert.equal(isSteamConsoleUa('Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0'), false);
});

test('the overview hint is one-time and desktop-only', () => {
  const show = { overview: true, seen: false, mobile: false, cursorHidden: false, bootCovering: false };
  assert.equal(shouldShowOverviewHint(show), true);
  assert.equal(shouldShowOverviewHint({ ...show, seen: true }), false);
  assert.equal(shouldShowOverviewHint({ ...show, overview: false }), false);
  assert.equal(shouldShowOverviewHint({ ...show, mobile: true }), false);
  assert.equal(shouldShowOverviewHint({ ...show, cursorHidden: true }), false);
  assert.equal(shouldShowOverviewHint({ ...show, bootCovering: true }), false);
  assert.equal(OVERVIEW_WALK_HINT, 'Press F to walk around');
});

test('the walk look hint waits for a click and hides once the mouse is captured', () => {
  const show = { walking: true, locked: false, mobile: false, attract: false, cursorHidden: false };
  assert.equal(shouldShowWalkLookHint(show), true);
  assert.equal(shouldShowWalkLookHint({ ...show, locked: true }), false);
  assert.equal(shouldShowWalkLookHint({ ...show, walking: false }), false);
  assert.equal(shouldShowWalkLookHint({ ...show, mobile: true }), false);
  assert.equal(shouldShowWalkLookHint({ ...show, attract: true }), false);
  assert.equal(shouldShowWalkLookHint({ ...show, cursorHidden: true }), false);
  assert.equal(WALK_LOOK_HINT, 'Click to look around · Esc to release');
});

test('the stylesheet no longer hides the cursor on every element', () => {
  const universal = css.match(/\n\* \{[^}]*\}/);
  assert.ok(universal);
  assert.doesNotMatch(universal[0], /cursor/);
  assert.match(css, /body\.console-cursor\s*\{[^}]*cursor:\s*none/);
  assert.match(css, /cursor:\s*pointer !important/);
  assert.match(css, /cursor:\s*text !important/);
  assert.match(css, /#walk-crosshair\.visible/);
  assert.match(html, new RegExp(WALK_LOOK_HINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, new RegExp(OVERVIEW_WALK_HINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('entering walk mode does not capture the mouse; a click in the view does', () => {
  const enter = walk.slice(walk.indexOf('// Enter walk around mode'), walk.indexOf('Walk Mode activated'));
  assert.doesNotMatch(enter, /requestWalkPointerLock/);
  const down = scene.slice(scene.indexOf('private onPointerDown'), scene.indexOf('public requestWalkPointerLock'));
  assert.match(down, /walkPressForLock/);
  assert.match(down, /requestWalkPointerLock\(\)/);
  assert.match(scene, /walkPressForLock\) \{\s*this\.walkPressForLock = false;\s*return;/);
});
