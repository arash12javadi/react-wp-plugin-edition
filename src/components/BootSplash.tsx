import styles from './BootSplash.module.css';

/**
 * What the page shows while it boots — before React has anything to render, and then while the
 * database, the plugins, the locale and (on the public site) the theme and routing are resolved.
 *
 * It replaces the bare "Checking database connection…" line the first paint used to be, and it is
 * deliberately the same picture as the one `index.html` paints before the bundle runs: mark, label,
 * bar, in the same place, so the handover from static HTML to React moves nothing on screen. Keep
 * the two in step — the styles here and the `<style>` block in `index.html`.
 *
 * Purely presentational: it takes a label, announces itself as busy to assistive technology, and
 * hides its decoration. Nothing here decides when the app is ready.
 */
export interface BootSplashProps {
  /** What is being waited for, in the operator's words. Kept short — it is not a progress log. */
  label?: string;
  /** A quieter second line, for a wait long enough to need an explanation. */
  detail?: string;
}

export default function BootSplash({ label = 'Loading…', detail }: BootSplashProps) {
  return (
    <div className={styles.screen} role="status" aria-live="polite" aria-busy="true">
      <div className={styles.mark} aria-hidden="true">
        <span className={styles.glyph}>R</span>
      </div>
      <p className={styles.label}>{label}</p>
      <div className={styles.track} aria-hidden="true">
        <span className={styles.fill} />
      </div>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
    </div>
  );
}
