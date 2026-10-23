// Desktop mice keep a normal pointer. The old stylesheet hid it on every
// element for a ten-foot console; that hide now follows a body class set only
// while the session is a TV, a Steam console shell, or actually driven by a
// gamepad. A mouse move on Steam or a plugged-in pad brings the cursor back.

import { isTvViewer } from './remote-tv.ts';

export const CONSOLE_CURSOR_CLASS = 'console-cursor';
export const WALK_LOOK_HINT = 'Click to look around · Esc to release';
export const OVERVIEW_WALK_HINT = 'Press F to walk around';
export const OVERVIEW_WALK_HINT_KEY = 'bb_walk_hint_seen';

const STEAM_CONSOLE_UA = /Steam\s*Deck|SteamOS|Valve\s+Steam/i;
const STICK_THRESHOLD = 0.5;

export function isSteamConsoleUa(ua: string): boolean {
  return STEAM_CONSOLE_UA.test(ua);
}

export interface CursorHideState {
  tv: boolean;
  steam: boolean;
  gamepadDriven: boolean;
  /** A real mouse (or trackpad) moved since the last gamepad input. */
  mouseActive: boolean;
}

/** TV shells stay cursorless. Steam and a live gamepad hide it until the mouse moves. */
export function shouldHideCursor(state: CursorHideState): boolean {
  if (state.tv) return true;
  if (state.mouseActive) return false;
  return state.steam || state.gamepadDriven;
}

export interface OverviewHintState {
  overview: boolean;
  seen: boolean;
  mobile: boolean;
  cursorHidden: boolean;
  bootCovering: boolean;
}

/** One-time, and only where a desktop mouse can act on it. */
export function shouldShowOverviewHint(state: OverviewHintState): boolean {
  return state.overview && !state.seen && !state.mobile && !state.cursorHidden && !state.bootCovering;
}

export interface WalkLookHintState {
  walking: boolean;
  locked: boolean;
  mobile: boolean;
  attract: boolean;
  cursorHidden: boolean;
}

/** Visible from the moment walk mode starts until the view captures the mouse. */
export function shouldShowWalkLookHint(state: WalkLookHintState): boolean {
  return state.walking && !state.locked && !state.mobile && !state.attract && !state.cursorHidden;
}

let installed = false;
let mode = '';
let seen = false;
let revealed = false;
let mouseActive = false;
let gamepadDriven = false;
let pollTimer = 0;
let walkState: WalkLookHintState = {
  walking: false, locked: false, mobile: false, attract: false, cursorHidden: false,
};

function steamShell(): boolean {
  return typeof navigator !== 'undefined' && isSteamConsoleUa(navigator.userAgent || '');
}

/** Same signal as the touch store: a finger with no hover. Desktop mice are neither. */
function touchPrimary(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
}

function cursorHidden(): boolean {
  return shouldHideCursor({
    tv: typeof location !== 'undefined' && isTvViewer(),
    steam: steamShell(),
    gamepadDriven,
    mouseActive,
  });
}

function bootCovering(): boolean {
  const boot = document.getElementById('boot-overlay');
  return !!boot && boot.classList.contains('visible');
}

function applyCursorClass(): void {
  document.body.classList.toggle(CONSOLE_CURSOR_CLASS, cursorHidden());
  paintOverviewHint();
  paintWalkHint();
}

function paintOverviewHint(): void {
  const el = document.getElementById('overview-walk-hint');
  if (!el) return;
  const hidden = cursorHidden();
  if (shouldShowOverviewHint({
    overview: mode === 'overview',
    seen,
    mobile: touchPrimary(),
    cursorHidden: hidden,
    bootCovering: bootCovering(),
  })) {
    revealed = true;
    if (!seen) {
      seen = true;
      try { localStorage.setItem(OVERVIEW_WALK_HINT_KEY, '1'); } catch { /* private mode */ }
    }
  }
  if (mode !== 'overview' || touchPrimary() || hidden || bootCovering()) revealed = false;
  el.classList.toggle('visible', revealed);
}

function paintWalkHint(): void {
  const el = document.getElementById('walk-look-hint');
  if (!el) return;
  walkState.cursorHidden = cursorHidden();
  walkState.mobile = touchPrimary();
  el.classList.toggle('visible', shouldShowWalkLookHint(walkState));
}

function noteGamepadActivity(): void {
  if (gamepadDriven && !mouseActive) return;
  gamepadDriven = true;
  mouseActive = false;
  applyCursorClass();
}

function padDriven(pad: Gamepad): boolean {
  for (let i = 0; i < pad.buttons.length; i++) {
    if (pad.buttons[i]?.pressed) return true;
  }
  // Left stick only. Other axes rest at ±1 on some pads (trigger axes) and
  // would look like constant input the moment a controller is plugged in.
  const x = pad.axes[0] ?? 0;
  const y = pad.axes[1] ?? 0;
  return Math.abs(x) > STICK_THRESHOLD || Math.abs(y) > STICK_THRESHOLD;
}

function samplePads(): void {
  const pads = navigator.getGamepads?.();
  let any = false;
  let driven = false;
  if (pads) {
    for (const pad of pads) {
      if (!pad) continue;
      any = true;
      if (padDriven(pad)) driven = true;
    }
  }
  if (driven) noteGamepadActivity();
  if (!any && pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }
}

function ensurePadPoll(): void {
  if (pollTimer || typeof navigator === 'undefined' || !navigator.getGamepads) return;
  pollTimer = window.setInterval(samplePads, 100);
}

function onMouseMove(e: MouseEvent): void {
  if (document.pointerLockElement) return;
  if (!e.movementX && !e.movementY) return;
  if (typeof location !== 'undefined' && isTvViewer()) return;
  if (!gamepadDriven && mouseActive) return;
  mouseActive = true;
  gamepadDriven = false;
  applyCursorClass();
}

export function noteStoreMode(next: string): void {
  mode = next;
  if (typeof document === 'undefined') return;
  paintOverviewHint();
}

/** The visitor found walk mode (F or the gamepad). Don't show the overview hint again. */
export function dismissOverviewWalkHint(): void {
  seen = true;
  revealed = false;
  try { localStorage.setItem(OVERVIEW_WALK_HINT_KEY, '1'); } catch { /* private mode */ }
  if (typeof document !== 'undefined') paintOverviewHint();
}

export function syncWalkLookHint(scene: { isWalkAroundMode: boolean; isPointerLocked: boolean; attractTour: boolean }): void {
  walkState.walking = scene.isWalkAroundMode;
  walkState.locked = scene.isPointerLocked;
  walkState.attract = scene.attractTour;
  if (typeof document === 'undefined') return;
  paintWalkHint();
}

export function installDesktopCursor(): void {
  if (installed || typeof document === 'undefined' || !document.body) return;
  installed = true;
  const look = document.getElementById('walk-look-hint');
  const overview = document.getElementById('overview-walk-hint');
  if (look) look.textContent = WALK_LOOK_HINT;
  if (overview) overview.textContent = OVERVIEW_WALK_HINT;
  try { seen = localStorage.getItem(OVERVIEW_WALK_HINT_KEY) === '1'; } catch { seen = false; }
  applyCursorClass();
  window.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('gamepadconnected', ensurePadPoll);
  window.addEventListener('gamepaddisconnected', ensurePadPoll);
  const boot = document.getElementById('boot-overlay');
  if (boot) {
    new MutationObserver(() => paintOverviewHint()).observe(boot, { attributes: true, attributeFilter: ['class'] });
  }
  // A pad already connected doesn't fire gamepadconnected again.
  try {
    const pads = navigator.getGamepads?.();
    if (pads && Array.from(pads).some(Boolean)) ensurePadPoll();
  } catch { /* restricted getGamepads */ }
}
