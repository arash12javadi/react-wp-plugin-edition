/**
 * The boot overlay `index.html` paints before any JavaScript runs (`#rwp-boot`).
 *
 * It lives outside `#root`, so React's first render does not replace it: it stays on screen — one
 * picture, one uninterrupted animation — from the first paint until the first real screen is ready,
 * then fades out. Before, the static screen was swapped for a React copy of itself on the first
 * commit and every later wait remounted it, which restarted its animation each time.
 *
 * `BootSplash` is the only caller. While at least one `BootSplash` is mounted and the overlay is
 * still up, the component draws nothing itself and *holds* the overlay instead, writing its label,
 * detail and progress into it. When the last holder unmounts the overlay fades out and is removed;
 * a `BootSplash` mounted after that draws its own copy, styled by the same global classes.
 *
 * Purely presentational: nothing here decides when the app is ready.
 */

const OVERLAY_ID = 'rwp-boot';
/** Matches the opacity transition on `.rwp-boot` in index.html, plus a frame or two of slack. */
const FADE_MS = 400;

let holders = 0;
let finishTimer: number | undefined;

/** The overlay while it is still showing; `null` once it has finished (or on a page without it). */
const overlay = (): HTMLElement | null => {
  if (typeof document === 'undefined') return null;
  const element = document.getElementById(OVERLAY_ID);
  return element && element.dataset.state !== 'done' ? element : null;
};

/** True while the static overlay is up and a new `BootSplash` should hold it rather than draw. */
export const staticSplashShowing = (): boolean => overlay() !== null;

export interface BootSplashState {
  label: string;
  detail?: string;
  /** 0–1. Only ever moves forward: a later screen with a lower number does not pull the bar back. */
  progress?: number;
}

/** Writes a boot stage into the overlay. A no-op once it is gone. */
export function updateStaticSplash({ label, detail, progress }: BootSplashState): void {
  const element = overlay();
  if (!element) return;
  const labelElement = element.querySelector<HTMLElement>('[data-rwp-boot-label]');
  if (labelElement && labelElement.textContent !== label) labelElement.textContent = label;
  const detailElement = element.querySelector<HTMLElement>('[data-rwp-boot-detail]');
  if (detailElement) {
    detailElement.textContent = detail ?? '';
    detailElement.hidden = !detail;
  }
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    const current = Number(element.style.getPropertyValue('--rwp-boot-progress')) || 0;
    const next = Math.min(1, Math.max(current, progress));
    // Stages arrive quickly once the bundle runs; the slow creep index.html starts is for the download.
    element.style.setProperty('--rwp-boot-speed', '0.5s');
    element.style.setProperty('--rwp-boot-progress', String(next));
  }
}

/** Fills the bar, fades the overlay out and removes it. Safe to call more than once. */
export function finishStaticSplash(): void {
  const element = overlay();
  if (!element) return;
  element.style.setProperty('--rwp-boot-speed', '0.25s');
  element.style.setProperty('--rwp-boot-progress', '1');
  element.dataset.state = 'done';
  element.setAttribute('aria-busy', 'false');
  window.setTimeout(() => element.remove(), FADE_MS);
}

/**
 * Keeps the overlay up until the returned function is called. The fade is decided a tick after the
 * last release, so a screen that hands over to the next waiting screen in the same commit (the app's
 * boot to the dashboard's "Loading the dashboard…") keeps the overlay instead of flashing between them.
 */
export function holdStaticSplash(): () => void {
  holders += 1;
  window.clearTimeout(finishTimer);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders > 0) return;
    window.clearTimeout(finishTimer);
    finishTimer = window.setTimeout(() => {
      if (holders === 0) finishStaticSplash();
    }, 0);
  };
}
