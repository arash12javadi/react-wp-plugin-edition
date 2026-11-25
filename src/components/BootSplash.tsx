import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { holdStaticSplash, staticSplashShowing, updateStaticSplash } from '../lib/bootSplash';

/**
 * What the page shows while it boots — before React has anything to render, and then while the
 * database, the plugins, the locale and (on the public site) the theme and routing are resolved.
 *
 * The picture is the React-WP logo, animated: a navy hexagon with three turning orbits, each with
 * a travelling electron, around a ringed "W", then the name, a status line and a progress bar. `index.html` paints it as a static overlay before any JavaScript
 * runs, and while that overlay is still up this component draws nothing: it holds the overlay and
 * writes its label and progress into it (`src/lib/bootSplash.ts`), so the boot is one screen with
 * one unbroken animation rather than a static copy swapped for a React copy. Once the overlay has
 * faded out, a later wait draws the same screen here, with the same global `rwp-boot-*` classes from
 * the `<style>` in index.html — keep the markup below in step with the markup there.
 *
 * Purely presentational: it takes a label, announces itself as busy to assistive technology, and
 * hides its decoration. Nothing here decides when the app is ready.
 */
export interface BootSplashProps {
  /** What is being waited for, in the operator's words. Kept short — it is not a progress log. */
  label?: string;
  /** A quieter second line, for a wait long enough to need an explanation. */
  detail?: string;
  /** How far the boot has come, 0–1. Leave it out for a wait with no stages. */
  progress?: number;
}

export default function BootSplash({ label = 'Loading…', detail, progress }: BootSplashProps) {
  // Decided once, at mount: a splash that started out holding the overlay keeps doing so.
  const [holdsOverlay] = useState(staticSplashShowing);

  useLayoutEffect(() => (holdsOverlay ? holdStaticSplash() : undefined), [holdsOverlay]);
  useLayoutEffect(() => {
    if (holdsOverlay) updateStaticSplash({ label, detail, progress });
  }, [holdsOverlay, label, detail, progress]);

  if (holdsOverlay) return null;

  const fillStyle = typeof progress === 'number'
    ? { '--rwp-boot-progress': String(Math.min(1, Math.max(0, progress))), '--rwp-boot-speed': '0.5s' } as CSSProperties
    : undefined;

  return (
    <div className="rwp-boot" role="status" aria-live="polite" aria-busy="true">
      <div className="rwp-boot-logo" aria-hidden="true">
        <span className="rwp-boot-glow" />
        <span className="rwp-boot-hex">
          <svg viewBox="0 0 132 132" focusable="false">
            <polygon points="66,8 116.23,37 116.23,95 66,124 15.77,95 15.77,37" fill="#31476a" stroke="#31476a" strokeWidth="8" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="rwp-boot-sheen" />
        <span className="rwp-boot-ripple" />
        <span className="rwp-boot-atom">
          <span className="rwp-boot-spin">
            <svg viewBox="0 0 132 132" focusable="false">
              <g fill="none" stroke="#fff" strokeWidth="4">
                <ellipse cx="66" cy="66" rx="49" ry="19" />
                <ellipse cx="66" cy="66" rx="49" ry="19" transform="rotate(60 66 66)" />
                <ellipse cx="66" cy="66" rx="49" ry="19" transform="rotate(120 66 66)" />
              </g>
            </svg>
            {[1, 2, 3].map((n) => (
              <span key={n} className={`rwp-boot-e rwp-boot-e${n}`}>
                <span className="rwp-boot-ex"><span className="rwp-boot-ey" /></span>
              </span>
            ))}
          </span>
        </span>
        <span className="rwp-boot-core">
          <svg viewBox="0 0 132 132" focusable="false">
            <circle cx="66" cy="66" r="18.5" fill="#31476a" stroke="#fff" strokeWidth="3.5" />
            <circle cx="66" cy="66" r="13.5" fill="none" stroke="#fff" strokeWidth="1.6" />
            <text x="66" y="66.5" fill="#fff" fontFamily="Georgia, 'Times New Roman', serif" fontSize="17" fontWeight="700" textAnchor="middle" dominantBaseline="central">W</text>
          </svg>
        </span>
      </div>
      <p className="rwp-boot-name" aria-hidden="true">React<span>-WP</span></p>
      <p className="rwp-boot-label">{label}</p>
      <div className="rwp-boot-track" aria-hidden="true">
        <span className="rwp-boot-fill" style={fillStyle} />
      </div>
      {detail ? <p className="rwp-boot-detail">{detail}</p> : null}
    </div>
  );
}
