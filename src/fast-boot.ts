// Early store reveal: match the hosted-demo contract on local dev and opt-in
// production installs — enter before full shader warmup and nearby poster drain,
// finish preparation in the background (see main.ts hideBootOverlay hook).
import { isPublicDemo } from './demo-mode.ts';

/** Touch-primary viewport — mirrors mobileStoreActive without pulling Three.js. */
function phoneViewportBootFastPath(): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
  } catch {
    return false;
  }
}

export const FAST_BOOT_KEY = 'bb_fast_boot';

/** Ms after a fast-boot reveal during which the resolution scaler ignores fps samples. */
export const POST_REVEAL_TEXTURE_GRACE_MS = 15_000;

const devBootMarks: { stage: string; t: number }[] = [];

/** DEV-only boot pipeline markers (console table after overlay hides). */
export function markBootStage(stage: string): void {
  if (typeof import.meta === 'undefined' || !import.meta.env?.DEV) return;
  devBootMarks.push({ stage, t: performance.now() });
}

export function flushBootStageTable(origin = 'store'): void {
  if (!devBootMarks.length || typeof import.meta === 'undefined' || !import.meta.env?.DEV) return;
  const t0 = devBootMarks[0].t;
  console.table(devBootMarks.map((m, i) => ({
    stage: m.stage,
    msSinceStart: Math.round(m.t - t0),
    msSincePrev: Math.round(m.t - (i > 0 ? devBootMarks[i - 1].t : t0)),
  })));
  devBootMarks.length = 0;
  console.info(`[boot] stage timing (${origin})`);
}

/**
 * Whether the boot overlay may drop before texturesReadyPromise and before
 * blocking warmupRuntimePrograms in finishStockBuild.
 */
export function fastBootReveal(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(FAST_BOOT_KEY) === '0') {
      return false;
    }
  } catch {
    /* no storage */
  }
  if (isPublicDemo || phoneViewportBootFastPath()) return true;
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) return true;
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FAST_BOOT === '1') return true;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(FAST_BOOT_KEY) === '1') {
      return true;
    }
  } catch {
    /* no storage */
  }
  return false;
}