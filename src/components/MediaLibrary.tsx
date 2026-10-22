import MediaManager from './MediaManager';
import styles from './SiteSettings.module.css';

/**
 * Media → Library. Where an upload lands — the provider and the credentials it needs — is configured
 * once, on the Media & storage card under Settings → Integrations, so this screen only manages the
 * library itself.
 */
export default function MediaLibrary() {
  return (
    <section className={styles.container} aria-labelledby="media-heading">
      <div className={styles.pageIntro}>
        <h2 id="media-heading">Media</h2>
        <p>Upload images to Cloudinary or ImageKit, or add them by URL, then reuse them anywhere.</p>
      </div>

      <MediaManager heading="Media Library" />
    </section>
  );
}
