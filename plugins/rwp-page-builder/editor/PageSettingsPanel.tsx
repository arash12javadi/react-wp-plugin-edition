import { useEffect, useState } from 'react';
import MediaManager from '../../../src/components/MediaManager';
import { getSupabaseClient } from '../../../src/lib/db';
import type { Category } from '../../../src/lib/types';
import { disableBuilder } from '../lib/api';
import { ColorInput, Row } from './Controls';
import { isDirty, isValidSlug, slugify, useEditor, useStore } from './store';
import styles from './editor.module.css';

export default function PageSettingsPanel() {
  const store = useStore();
  const { actions } = store;
  const settings = useEditor((state) => state.doc.settings);
  const layout = useEditor((state) => state.layout);
  const page = useEditor((state) => state.page);
  const meta = useEditor((state) => state.pageMeta);
  const seo = useEditor((state) => state.seo);
  const title = useEditor((state) => state.title);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [categoryError, setCategoryError] = useState('');
  const [picking, setPicking] = useState(false);

  // The same source as the classic editor's Category box, so both list the same terms.
  useEffect(() => {
    let active = true;
    void getSupabaseClient().from('categories').select('*').order('name').then(({ data, error: queryError }) => {
      if (!active) return;
      if (queryError) {
        setCategories([]);
        setCategoryError(queryError.message.includes('categories')
          ? 'The categories table is missing, so categories cannot be listed. Run supabase/schema.sql in the Supabase SQL editor, then reload the builder.'
          : queryError.message);
        return;
      }
      setCategories((data || []) as Category[]);
    });
    return () => { active = false; };
  }, []);

  const typedSlug = meta.slug.trim();
  const slug = slugify(meta.slug) || slugify(title);
  const slugProblem = typedSlug && !isValidSlug(slugify(meta.slug))
    ? 'Lowercase letters, numbers and single hyphens only, for example "about-our-team".'
    : '';

  const switchToClassic = async () => {
    const message = isDirty(store.getState())
      ? 'Switch this page back to the classic editor? Your unsaved builder changes will be lost; the saved layout is kept and can be re-enabled later.'
      : 'Switch this page back to the classic editor? Visitors will see the classic content again. The layout is kept and can be re-enabled later.';
    if (!window.confirm(message)) return;
    try {
      await disableBuilder(page.id);
      window.location.href = `/admin?section=content&edit=${page.id}`;
    } catch (disableError) {
      setError(disableError instanceof Error ? disableError.message : 'Could not switch editors.');
    }
  };

  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>Page settings</h3>
      <Row label="Page width" help="Full width lets sections span the screen. Boxed and Wide keep the site's content column around the layout.">
        <select className={styles.input} value={layout} onChange={(event) => store.setState({ layout: event.target.value })}>
          <option value="full">Full width (recommended)</option>
          <option value="wide">Wide</option>
          <option value="boxed">Boxed</option>
        </select>
      </Row>
      <h4 className={styles.controlHeading}>Show on this page</h4>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={meta.show_header} onChange={(event) => actions.setPageMetaField('show_header', event.target.checked)} />
        Show header &amp; navigation
      </label>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={Boolean(settings.showTitle)} onChange={(event) => actions.setDocumentSetting('showTitle', event.target.checked)} />
        Show the page title above the layout
      </label>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={meta.show_sidebar} onChange={(event) => actions.setPageMetaField('show_sidebar', event.target.checked)} />
        Show the sidebar beside the layout
      </label>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={Boolean(settings.showComments)} onChange={(event) => actions.setDocumentSetting('showComments', event.target.checked)} />
        Show comments below the layout
      </label>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={meta.show_footer} onChange={(event) => actions.setPageMetaField('show_footer', event.target.checked)} />
        Show footer
      </label>
      <p className={styles.controlHelp}>The header and footer come from the Theme Editor. Turn them off for landing pages; the admin toolbar still shows for signed-in people.</p>
      <p className={styles.controlHelp}>The sidebar&apos;s widgets come from Menus &amp; Widgets → Sidebar &amp; Widgets; which side it sits on is set in the Theme Editor.</p>
      <p className={styles.controlHelp}>Comments also need to be enabled in Settings and allowed on this page.</p>

      {/* The page's own columns, written by the same save as the layout and tracked as unsaved changes. */}
      <h4 className={styles.controlHeading}>Content type</h4>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={meta.is_post} onChange={(event) => actions.setPageMetaField('is_post', event.target.checked)} />
        Treat as blog post
      </label>
      <p className={styles.controlHelp}>Posts appear in the blog, archives and category pages; pages stand on their own. This is the classic editor&apos;s &quot;Post&quot; switch.</p>
      <Row label="Category" help="A post’s category. Choosing one also turns the content into a post.">
        {categories === null
          ? <p className={styles.hint}>Loading categories…</p>
          : (
            <select className={styles.input} value={meta.category_id} onChange={(event) => {
              actions.setPageMetaField('category_id', event.target.value);
              if (event.target.value) actions.setPageMetaField('is_post', true);
            }}>
              <option value="">No category</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          )}
      </Row>
      {categoryError && <p className={styles.errorText} role="alert">{categoryError}</p>}
      {!meta.is_post && (
        <>
          <Row label="Featured category" help="Kept for the classic editor and theme templates. A Loop or Posts widget picks its own posts.">
            <select className={styles.input} value={meta.featured_category_id} onChange={(event) => actions.setPageMetaField('featured_category_id', event.target.value)}>
              <option value="">All categories</option>
              {(categories || []).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </Row>
          <Row label="Posts limit" help="Kept for the classic editor and theme templates. A Loop or Posts widget sets its own post count.">
            <input type="number" min={1} className={styles.input} value={meta.posts_limit}
              onChange={(event) => actions.setPageMetaField('posts_limit', Math.max(1, Number(event.target.value) || 1))} />
          </Row>
          <Row label="Feed layout" help="Kept for the classic editor and theme templates. A Loop or Posts widget sets its own grid or list layout.">
            <select className={styles.input} value={meta.display_layout} onChange={(event) => actions.setPageMetaField('display_layout', event.target.value === 'list' ? 'list' : 'grid')}>
              <option value="grid">Grid</option>
              <option value="list">List</option>
            </select>
          </Row>
        </>
      )}
      <Row label="Slug" help={slugProblem || `The last part of the web address: /${slug || 'your-slug'}`}>
        <input className={styles.input} value={meta.slug} placeholder={slugify(title)} aria-invalid={Boolean(slugProblem)}
          onChange={(event) => actions.setPageMetaField('slug', event.target.value)} />
      </Row>

      {/* Pages have no featured-image column, so this is the same image the SEO tab calls the social image. */}
      <Row label="Featured image" help="Saved as the page’s social image, so this and the SEO tab are one and the same. Post cards, the Posts widget and the Featured Image widget use it.">
        <div className={styles.mediaField}>
          {seo.og_image
            ? <img className={styles.imagePreview} src={seo.og_image} alt="" />
            : <p className={styles.hint}>No featured image chosen yet.</p>}
          <div className={styles.buttonRow}>
            <button type="button" className={styles.secondaryButton} onClick={() => setPicking(true)}>{seo.og_image ? 'Replace image' : 'Choose image'}</button>
            {seo.og_image && <button type="button" className={styles.smallButtonGhost} onClick={() => actions.setSeoField('og_image', '')}>Remove</button>}
          </div>
        </div>
      </Row>

      <Row label="Page background">
        <ColorInput value={settings.background} onChange={(value) => actions.setDocumentSetting('background', value)} />
      </Row>
      <Row label="Page custom CSS" help='"selector" targets the whole layout. Applies to this page only.'>
        <textarea className={styles.code} rows={6} spellCheck={false} value={settings.customCss || ''} onChange={(event) => actions.setDocumentSetting('customCss', event.target.value)} />
      </Row>
      <p className={styles.hint}>Everything here is saved with the layout by the Save button, and counts as an unsaved change until then. Excerpt, author and the rest of the page&apos;s details are still in the classic editor.</p>
      <div className={styles.buttonRow}>
        <button type="button" className={styles.secondaryButton} onClick={() => actions.setPanel('seo')}>Open the SEO tab</button>
        <a className={styles.secondaryButton} href={`/admin?section=content&edit=${page.id}`}>Open page details</a>
      </div>
      <h4 className={styles.controlHeading}>Editor</h4>
      {error && <p className={styles.errorText} role="alert">{error}</p>}
      <button type="button" className={styles.dangerButton} onClick={() => void switchToClassic()}>Switch back to the classic editor</button>
      {picking && (
        <MediaManager heading="Choose a featured image" onClose={() => setPicking(false)}
          onSelect={(item) => { actions.setSeoField('og_image', item.url); setPicking(false); }} />
      )}
    </div>
  );
}
