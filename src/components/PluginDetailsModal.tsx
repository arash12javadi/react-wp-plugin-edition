import { useEffect, useRef, useState } from 'react';
import { pluginDocFor } from '../lib/pluginDocs';
import styles from './PluginDetailsModal.module.css';

interface Props {
  plugin: {
    plugin_id: string;
    name: string;
    version: string;
    author?: string;
    description?: string;
    active: boolean;
    folder?: string | null;
  };
  onClose: () => void;
}

/** Copies the tag exactly as it is documented, which is why the tag itself is the payload. */
function CopyTag({ usage }: { usage: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={styles.copy}
      onClick={() => {
        void navigator.clipboard?.writeText(usage).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * What a plugin does, before it is switched on.
 *
 * The words come from `src/lib/pluginDocs.ts`, because most of what an administrator needs to know is
 * not something the registry can answer: which setting has to be saved before the plugin does
 * anything, and what an uninstall takes with it. A plugin with no entry there - an uploaded
 * third-party one - still gets a dialog: it says what its manifest and its live registration can
 * tell, rather than pretending there is nothing to show.
 */
export default function PluginDetailsModal({ plugin, onClose }: Props) {
  const doc = pluginDocFor(plugin.plugin_id);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-details-title"
        tabIndex={-1}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <span className={styles.icon} aria-hidden="true">{doc?.icon ?? '🧩'}</span>
            <div>
              <h3 id="plugin-details-title">{plugin.name}</h3>
              <p className={styles.subtitle}>
                <code>{plugin.plugin_id}</code> · version {plugin.version}
                {plugin.author ? ` · ${plugin.author}` : ''}
              </p>
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className={styles.badges}>
          <span className={plugin.active ? styles.badgeActive : styles.badgeInactive}>
            {plugin.active ? 'Active' : 'Inactive'}
          </span>
          {doc?.licensed ? <span className={styles.badgeLicensed}>Sold separately</span> : null}
        </div>

        {doc ? (
          <>
            <p className={styles.summary}>{doc.summary}</p>

            {doc.featureGroups.map((group) => (
              <section key={group.title} className={styles.group}>
                <h4>{group.title}</h4>
                <ul>
                  {group.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </section>
            ))}

            {doc.admin?.length ? (
              <section className={styles.group}>
                <h4>Where it lives in the admin</h4>
                <ul className={styles.places}>
                  {doc.admin.map((place) => (
                    <li key={place.where}>
                      <strong>{place.where}</strong>
                      <span>{place.what}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {doc.publicRoutes?.length ? (
              <section className={styles.group}>
                <h4>On the public site</h4>
                <ul className={styles.places}>
                  {doc.publicRoutes.map((route) => (
                    <li key={route.where}>
                      <strong>{route.where}</strong>
                      <span>{route.what}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {doc.shortcodes?.length ? (
              <section className={styles.group}>
                <h4>Shortcodes</h4>
                {doc.shortcodes.map((shortcode) => (
                  <div key={shortcode.usage} className={styles.shortcode}>
                    <div className={styles.usageRow}>
                      <code className={styles.usage}>{shortcode.usage}</code>
                      <CopyTag usage={shortcode.usage} />
                    </div>
                    <p>{shortcode.description}</p>
                    {shortcode.attributes?.length ? (
                      <ul className={styles.attributes}>
                        {shortcode.attributes.map((attribute) => (
                          <li key={attribute.name}>
                            <code>{attribute.name}</code>
                            <span>{attribute.note}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </section>
            ) : null}

            <section className={styles.group}>
              <h4>Setting it up</h4>
              <ol className={styles.steps}>
                {doc.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
            </section>

            {doc.notes?.length ? (
              <section className={styles.group}>
                <h4>Worth knowing</h4>
                <ul className={styles.notes}>
                  {doc.notes.map((note) => <li key={note}>{note}</li>)}
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <>
            <p className={styles.summary}>
              {plugin.description || 'This plugin does not describe itself in its manifest.'}
            </p>
            <div className={styles.unknown}>
              <strong>No written guide for this plugin.</strong>
              <span>
                {plugin.name} is not one of the bundled plugins this screen has notes for, so there is
                nothing here about what it is for beyond what it says about itself. Its screens appear
                in the sidebar once it is active, and every shortcode it registers is listed on
                Dashboard → Guide &amp; shortcodes while the plugin is on.
              </span>
            </div>
            <ul className={styles.meta}>
              <li><span>Plugin id</span><code>{plugin.plugin_id}</code></li>
              <li><span>Version</span><code>{plugin.version}</code></li>
              <li><span>Author</span><code>{plugin.author || 'Not declared'}</code></li>
              <li><span>Status</span><code>{plugin.active ? 'Active' : 'Inactive'}</code></li>
              {plugin.folder ? <li><span>Folder</span><code>plugins/{plugin.folder}</code></li> : null}
            </ul>
          </>
        )}

        <div className={styles.footer}>
          <button type="button" className={styles.done} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
