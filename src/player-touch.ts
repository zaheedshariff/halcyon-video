// Phone playback controls. The player was built for a mouse: the bar appears
// on mousemove, the scrubber is a 4px hover target, and iOS will not
// fullscreen a div. This layer only attaches for a finger with no hover, the
// same signal as the store touch controls, so a desktop pointer is unchanged.

/** Fraction along a horizontal bar. Width 0 stays at the start. */
export function pointerSeekRatio(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}

/** A finger with no hover. Matches store-touch.ts isTouchInputActive. */
export function coarseNoHover(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
}

export function installPlayerTouch(
  overlay: HTMLElement,
  progress: HTMLElement,
  actions: {
    seekRatio: (ratio: number) => void;
    show: () => void;
    hide: () => void;
    controlsHidden: () => boolean;
  },
): void {
  if (!coarseNoHover()) return;
  let seeking = false;

  const seekAt = (event: PointerEvent) => {
    const rect = progress.getBoundingClientRect();
    actions.seekRatio(pointerSeekRatio(event.clientX, rect.left, rect.width));
  };

  progress.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    seeking = true;
    seekAt(event);
    progress.setPointerCapture?.(event.pointerId);
  });
  progress.addEventListener('pointermove', (event) => {
    if (!seeking || event.pointerType === 'mouse') return;
    seekAt(event);
  });
  const endSeek = (event: PointerEvent) => {
    if (!seeking || event.pointerType === 'mouse') return;
    seeking = false;
    seekAt(event);
  };
  progress.addEventListener('pointerup', endSeek);
  progress.addEventListener('pointercancel', () => { seeking = false; });

  // Tap the picture to show or hide the bar. Mouse clicks keep the existing
  // seek-on-click path and never reach this listener.
  overlay.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse' || seeking) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, input, .vp-progress, .vp-tracks-menu, .vp-exit-card, .vp-volume')) return;
    if (actions.controlsHidden()) actions.show();
    else actions.hide();
  });
}
