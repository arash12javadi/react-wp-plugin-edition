import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { ClipboardCopy, ClipboardPaste, Copy, GripVertical, LayoutTemplate, Move, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { getSupabaseClient } from '../../../src/lib/db';
import { directionOf } from '../../../src/lib/i18n';
import { themeStylesheet, useTheme } from '../../../src/lib/theme';
import { motionSignature } from '../lib/animations';
import { globalCss, globalVars, googleFontFamilies, useGlobalStyles, useGoogleFonts } from '../lib/globals';
import { findNode, locate } from '../lib/tree';
import type { BuilderDocument, BuilderNode, ColumnNode, SectionNode } from '../lib/types';
import { effectiveBag, isSet, percentWidth } from '../lib/style';
import { useDynamicContext, useMotionEffects } from '../render/BuilderRenderer';
import { RenderProvider, type EditableTextProps, type EditorBridge, type RenderContextValue } from '../render/context';
import { generateCss } from '../render/generateCss';
import { NodeView } from '../render/NodeView';
import { toContainerQueries } from './containerCss';
import { nodeTitle } from './InspectorPanel';
import { hasPasteSource, useEditor, useStore } from './store';
import { scopeThemeCss } from './themeCss';
import '../render/builder.css';
import styles from './editor.module.css';

/**
 * The width a preview is laid out at. Desktop is the visitor's window: the frame is as wide as the
 * browser, so the page is laid out exactly as the site lays it out. Tablet and mobile keep the
 * device's own width, and shrink the same way when the canvas area is narrower than the device.
 * The frame is then zoomed down to whatever the panels leave over (see fitScale below).
 *
 * The frame is also the query container the canvas' own stylesheets answer for (`.canvasSite` in
 * editor.module.css, named rwpb-canvas). A media query would measure the browser window instead, so
 * in a device preview the author's breakpoints would answer for a desktop window while the page is
 * laid out at 375px; toContainerQueries rewrites their width queries to `@container` rules, and the
 * same goes for the CSS a Custom HTML block brings with it (EditorBridge.canvasCss).
 */
const deviceWidths = { tablet: 768, mobile: 375 };
/** .canvasArea's padding, both sides: the frame cannot use the area's whole clientWidth. */
const canvasPadding = 48;
/** editor.module.css paints an 8px outline on each side of the tablet and mobile frames. */
const frameOutline = 16;

// Inline text editing -----------------------------------------------------------------------------

/**
 * contentEditable text that commits on every keystroke without moving the caret. While focused,
 * React keeps rendering the text as it was at focus time, so it never writes to the DOM the
 * user is typing into; on blur the element remounts with the stored value.
 */
function InlineText({ nodeId, field, value, as = 'span', className, multiline }: EditableTextProps) {
  const { actions } = useStore();
  const selected = useEditor((state) => state.selectedId === nodeId);
  const [editing, setEditing] = useState(false);
  const [frozen, setFrozen] = useState(value);
  const [version, setVersion] = useState(0);
  const Tag = as as 'span';
  const shown = editing ? frozen : value;
  const content = multiline ? shown.split('\n').flatMap((line, index) => (index ? [<br key={index} />, line] : [line])) : shown;

  if (!selected) return <Tag className={className}>{content}</Tag>;
  return (
    <Tag
      key={version}
      className={`${className || ''} ${styles.inlineEditable}`}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder="Type here…"
      onFocus={() => { setFrozen(value); setEditing(true); }}
      onBlur={() => { setEditing(false); setVersion((current) => current + 1); }}
      onInput={(event) => {
        const text = (multiline ? event.currentTarget.innerText : event.currentTarget.textContent || '').replace(/\n$/, '');
        actions.setSetting(nodeId, field, text);
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' && !multiline) || event.key === 'Escape') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onPaste={(event: ClipboardEvent<HTMLElement>) => {
        // Pasting rich HTML would put markup into a plain-text field.
        event.preventDefault();
        document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
      }}
    >
      {content}
    </Tag>
  );
}

// Chrome: outlines, handles and toolbars -----------------------------------------------------------

function DragHandle({ node, className, children }: { node: BuilderNode; className: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `canvas:${node.id}`, data: { source: 'node', nodeId: node.id, label: nodeTitle(node) } });
  return (
    <button ref={setNodeRef} type="button" className={className} title={`Drag to move ${nodeTitle(node)}`} aria-label={`Move ${nodeTitle(node)}`} {...attributes} {...listeners}>
      {children}
    </button>
  );
}

function ColumnResizer({ column }: { column: ColumnNode }) {
  const store = useStore();
  const [dragging, setDragging] = useState<number | null>(null);
  const start = useRef<{ x: number; width: number; left: number; right: number; rightId: string } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = store.getState();
    const location = locate(state.doc, column.id);
    const section = location ? findNode(state.doc, location.parentId) as SectionNode | null : null;
    if (!section || !location) return;
    const right = section.children[location.index + 1];
    const container = (event.currentTarget.closest('[data-rwpb-node]')?.parentElement) as HTMLElement | null;
    if (!right || !container) return;
    event.preventDefault();
    event.stopPropagation();
    const count = section.children.length;
    // Only percentage shares can be dragged: a fixed width (px, em, rem, vw) is set in the panel.
    const widthOf = (item: ColumnNode): number | null => {
      const saved = effectiveBag(item.style, state.device).width;
      return isSet(saved) ? percentWidth(saved) ?? null : 100 / count;
    };
    const left = widthOf(column);
    const rightWidth = widthOf(right);
    if (left === null || rightWidth === null) return;
    start.current = { x: event.clientX, width: container.getBoundingClientRect().width, left, right: rightWidth, rightId: right.id };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(left);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = start.current;
    if (!origin) return;
    const total = origin.left + origin.right;
    const delta = ((event.clientX - origin.x) / origin.width) * 100;
    const left = Math.max(5, Math.min(total - 5, origin.left + delta));
    setDragging(left);
    store.actions.setColumnWidths([[column.id, left], [origin.rightId, total - left]]);
  };

  const onPointerUp = () => {
    start.current = null;
    setDragging(null);
  };

  return (
    <button type="button" className={styles.resizer} aria-label="Resize column" title="Drag to resize"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onClick={(event) => event.stopPropagation()}>
      {dragging !== null && <span className={styles.resizeValue}>{Math.round(dragging * 10) / 10}%</span>}
    </button>
  );
}

function Chrome({ node }: { node: BuilderNode }) {
  const { actions, getState } = useStore();
  const selected = useEditor((state) => state.selectedId === node.id);
  const hovered = useEditor((state) => state.hoveredPath.includes(node.id));
  const directHover = useEditor((state) => state.hoveredPath[state.hoveredPath.length - 1] === node.id);
  const dragging = useEditor((state) => Boolean(state.drag));
  const canPaste = useEditor(hasPasteSource);
  const canResize = useEditor((state) => {
    if (node.kind !== 'column') return false;
    const location = locate(state.doc, node.id);
    const section = location ? findNode(state.doc, location.parentId) as SectionNode | null : null;
    if (!section || !location || location.index >= section.children.length - 1) return false;
    const stackOn = String(section.settings.stackOn || 'mobile');
    const stacked = (state.device === 'mobile' && stackOn !== 'none') || (state.device === 'tablet' && stackOn === 'tablet');
    if (stacked) return false;
    const next = section.children[location.index + 1];
    if (!next) return false;
    // Fixed widths (px, em, rem, vw) have no percentage to trade with the next column.
    const widths = [effectiveBag(node.style, state.device).width, effectiveBag(next.style, state.device).width];
    return widths.every((value) => !isSet(value) || percentWidth(value) !== undefined);
  });

  const stop = (action: () => void) => (event: ReactMouseEvent) => { event.stopPropagation(); action(); };
  const visible = selected || hovered;
  const kindClass = node.kind === 'section' ? styles.chromeSection : node.kind === 'column' ? styles.chromeColumn : styles.chromeWidget;

  // Hidden rather than unmounted while dragging: removing the handle that started a drag cancels it.
  return (
    // data-rwpb-chrome: editor-only UI, which the SEO analyzer leaves out of the page it audits.
    <span className={dragging ? styles.chromeDragging : styles.chromeLayer} data-rwpb-chrome="">
      {visible && <span className={`${styles.outline} ${kindClass}${selected ? ` ${styles.outlineSelected}` : ''}`} aria-hidden="true" />}
      {node.kind === 'section' && visible && (
        <span className={styles.sectionTab} onClick={(event) => event.stopPropagation()}>
          <button type="button" title="Add section above" aria-label="Add section above" onClick={stop(() => {
            const index = getState().doc.content.findIndex((item) => item.id === node.id);
            actions.addSection([100], index < 0 ? undefined : index);
          })}><Plus size={13} /></button>
          <DragHandle node={node} className={styles.tabHandle}><GripVertical size={13} /></DragHandle>
          <button type="button" title="Edit section" aria-label="Edit section" onClick={stop(() => actions.select(node.id))}><Pencil size={12} /></button>
          <button type="button" className={`${styles.sectionAiButton} section-ai-btn`} title="Optimize section with AI"
            onClick={stop(() => { actions.select(node.id); actions.openSectionAi(node.id); })}>
            <Sparkles size={12} aria-hidden="true" /> AI Section Refine
          </button>
          <button type="button" title="Copy section (Ctrl+C)" aria-label="Copy section" onClick={stop(() => actions.copy(node.id))}><ClipboardCopy size={12} /></button>
          <button type="button" title={canPaste ? 'Paste into section (Ctrl+V)' : 'Nothing copied yet'} aria-label="Paste into section"
            disabled={!canPaste} onClick={stop(() => actions.paste(node.id))}><ClipboardPaste size={12} /></button>
          <button type="button" title="Duplicate" aria-label="Duplicate section" onClick={stop(() => actions.duplicate(node.id))}><Copy size={12} /></button>
          <button type="button" title="Delete" aria-label="Delete section" onClick={stop(() => actions.remove(node.id))}><Trash2 size={12} /></button>
        </span>
      )}
      {node.kind === 'column' && visible && (
        <span className={styles.columnTab} onClick={(event) => event.stopPropagation()}>
          <DragHandle node={node} className={styles.tabHandle}><Move size={11} /></DragHandle>
          <button type="button" title="Edit column" aria-label="Edit column" onClick={stop(() => actions.select(node.id))}><Pencil size={11} /></button>
          <button type="button" title="Copy column (Ctrl+C)" aria-label="Copy column" onClick={stop(() => actions.copy(node.id))}><ClipboardCopy size={10} /></button>
          <button type="button" title={canPaste ? 'Paste into column (Ctrl+V)' : 'Nothing copied yet'} aria-label="Paste into column"
            disabled={!canPaste} onClick={stop(() => actions.paste(node.id))}><ClipboardPaste size={10} /></button>
        </span>
      )}
      {node.kind === 'column' && canResize && (hovered || selected) && <ColumnResizer column={node} />}
      {node.kind === 'widget' && (selected || directHover) && (
        <span className={styles.widgetTab} onClick={(event) => event.stopPropagation()}>
          <DragHandle node={node} className={styles.tabHandle}><GripVertical size={12} /></DragHandle>
          <span className={styles.widgetName}>{nodeTitle(node)}</span>
          <button type="button" title="Copy widget (Ctrl+C)" aria-label="Copy widget" onClick={stop(() => actions.copy(node.id))}><ClipboardCopy size={12} /></button>
          <button type="button" title={canPaste ? 'Paste after widget (Ctrl+V)' : 'Nothing copied yet'} aria-label="Paste after widget"
            disabled={!canPaste} onClick={stop(() => actions.paste(node.id))}><ClipboardPaste size={12} /></button>
          <button type="button" title="Duplicate" aria-label="Duplicate widget" onClick={stop(() => actions.duplicate(node.id))}><Copy size={12} /></button>
          <button type="button" title="Delete" aria-label="Delete widget" onClick={stop(() => actions.remove(node.id))}><Trash2 size={12} /></button>
        </span>
      )}
    </span>
  );
}

function EmptyColumn({ columnId }: { columnId: string }) {
  const { actions } = useStore();
  return (
    <button type="button" className={styles.emptyColumn} data-rwpb-chrome="" onClick={(event) => { event.stopPropagation(); actions.select(columnId); actions.setPanel('widgets'); }}>
      <Plus size={16} /> Drag a widget here
    </button>
  );
}

// Canvas ---------------------------------------------------------------------------------------------

const CanvasContent = memo(function CanvasContent({ content }: { content: SectionNode[] }) {
  return <>{content.map((node) => <NodeView key={node.id} node={node} />)}</>;
});

/** The newest published post (single_post) or page (page) to preview a template with, or null. */
function useTemplateSample(type: string | null | undefined): number | null {
  const [id, setId] = useState<number | null>(null);
  useEffect(() => {
    if (type !== 'single_post' && type !== 'page') { setId(null); return undefined; }
    let active = true;
    let query = getSupabaseClient().from('pages').select('id').eq('status', 'published').eq('is_post', type === 'single_post');
    if (type === 'page') query = query.eq('is_site_template', false).eq('is_builder_enabled', false);
    void query.order('created_at', { ascending: false }).limit(1).then(({ data }) => {
      if (active) setId((data as Array<{ id: number }> | null)?.[0]?.id ?? null);
    });
    return () => { active = false; };
  }, [type]);
  return id;
}

/**
 * Motion effects in the canvas.
 *
 * The canvas runs the public site's reveal observer (useMotionEffects), so Motion behaves here as
 * it does for a visitor: looping effects keep running and entrance effects play where the author
 * can see them. Changing the selected element's Motion controls replays its effect, so the timing
 * being set is visible; selecting an element the observer has not reached yet reveals it, so a
 * selection made from the Navigator is never an empty space. Only the selected element is touched,
 * so typing into the page does not restart the canvas.
 */
function useMotionPreview(areaRef: RefObject<HTMLElement | null>, doc: BuilderDocument, selectedId: string | null) {
  const signature = useMemo(() => {
    const node = selectedId ? findNode(doc, selectedId) : null;
    return node ? motionSignature(node.advanced) : '';
  }, [doc, selectedId]);
  // What was last shown, so a timing change is what replays the effect — not merely a click.
  const last = useRef<{ id: string | null; signature: string }>({ id: null, signature: '' });

  useEffect(() => {
    const area = areaRef.current;
    const element = area && selectedId && signature
      ? Array.from(area.querySelectorAll<HTMLElement>('[data-rwpb-node]')).find((item) => item.dataset.rwpbNode === selectedId) || null
      : null;
    const retimed = last.current.id === selectedId && last.current.signature !== signature;
    last.current = { id: selectedId, signature };
    if (!element || !element.classList.contains('rwpb-anim')) return;
    // Selecting an element the observer has not reached yet has to show it (and starts its effect).
    if (!element.classList.contains('rwpb-visible')) element.classList.add('rwpb-visible');
    if (!retimed) return;
    // Dropping the animation and reading layout makes the browser run the stylesheet's one again
    // from the first keyframe instead of leaving the finished state in place.
    element.style.animation = 'none';
    void element.offsetWidth;
    element.style.animation = '';
  }, [areaRef, selectedId, signature]);
}

export default function Canvas({ onOpenTemplates, onOpenPageAi }: { onOpenTemplates: () => void; onOpenPageAi: () => void }) {
  const store = useStore();
  const { actions } = store;
  const doc = useEditor((state) => state.doc);
  const device = useEditor((state) => state.device);
  const locale = useEditor((state) => state.locale);
  const page = useEditor((state) => state.page);
  const layout = useEditor((state) => state.layout);
  const title = useEditor((state) => state.title);
  const selectedId = useEditor((state) => state.selectedId);

  /*
   * The canvas is a viewport, not a panel. The desktop frame is laid out at the width of the browser
   * window and then zoomed down to the width the panels leave over — a 1440px window previews the
   * page at 1440px instead of at the ~1050px the 320px sidebar and the area's padding leave, which is
   * what made Custom HTML look different here from the frontend. A widget's own media queries answer
   * for the window, so `@media (min-width: 720px)` kept firing while the frame was ~1000px wide, and a
   * row of fixed-width cards designed for a 900px container was squeezed into 800 instead of wrapping.
   * Zooming keeps every length honest — rem, %, media queries — and only makes the pixels smaller, the
   * way a browser's own zoom does. Device frames keep their device width and are only zoomed when the
   * area is narrower than the device, so the phone preview is 375px wide instead of being squeezed to
   * the panel (which re-laid the page out at a width no phone has).
   */
  const areaRef = useRef<HTMLElement>(null);
  const [viewportWidth, setViewportWidth] = useState(() => document.documentElement.clientWidth);
  const [areaWidth, setAreaWidth] = useState(0);
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return undefined;
    const measure = () => {
      setViewportWidth(document.documentElement.clientWidth);
      setAreaWidth(area.clientWidth - canvasPadding);
    };
    measure();
    // The sidebar resizer changes the area without a window resize, so watch the element too.
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  useMotionEffects(areaRef, doc);
  useMotionPreview(areaRef, doc, selectedId);

  const frameWidth = device === 'desktop' ? viewportWidth : deviceWidths[device];
  // What has to fit: the frame, plus the outline the device previews paint outside it.
  const frameOuter = frameWidth + (device === 'desktop' ? 0 : frameOutline);
  /*
   * A hair under the available width, so rounding the zoom cannot add a horizontal scrollbar back.
   * The floor is for the degenerate case (a window narrower than the panels leave room for): past
   * it the preview stops shrinking and the canvas scrolls instead of showing an unreadable page.
   */
  const fitScale = areaWidth > 0 ? Math.max(0.2, Math.min(1, (areaWidth - 1) / frameOuter)) : 1;
  const globals = useGlobalStyles();
  useGoogleFonts(googleFontFamilies(globals, doc));

  // Whatever the author wrote in Appearance → Theme Editor's Custom CSS is part of what a page looks
  // like, and App.tsx skips that bootstrap on /builder/… so the editor keeps its own chrome. Load it
  // here and rewrite it to reach the canvas only, so a rule for `body` cannot restyle the panels.
  // Its width breakpoints follow the frame like everything else the canvas injects.
  const { theme } = useTheme();
  const themeCss = useMemo(() => toContainerQueries(scopeThemeCss(themeStylesheet(theme), `.${styles.canvasSite}`)), [theme]);

  // Dynamic tags preview against this page, including a title edited but not yet saved. The Single
  // Post and Standard Pages templates preview against the latest published post or page instead.
  const sampleId = useTemplateSample(page.is_site_template ? page.template_type : null);
  const previewPage = useMemo(() => (sampleId ? { id: sampleId } : { ...page, title }), [page, title, sampleId]);
  const dynamic = useDynamicContext(previewPage);

  // One stylesheet for the previewed device only, with media queries included for anything the
  // author typed by hand (a page's or a node's Custom CSS), which is why the width queries are
  // rewritten to ask the frame rather than the browser window.
  const css = useMemo(
    () => toContainerQueries(`${globalCss(globals)}\n${globalVars(globals, '[data-rwpb-shell]')}\n${generateCss(doc, { device })}`),
    [doc, device, globals],
  );

  const bridge = useMemo<EditorBridge>(() => ({
    EditableText: InlineText,
    Chrome,
    EmptyColumn,
    nodeProps: (node) => ({
      'data-rwpb-node': node.id,
      onClick: (event: ReactMouseEvent) => {
        event.stopPropagation();
        actions.select(node.id);
      },
    }),
    canvasCss: toContainerQueries,
  }), [actions]);

  const context = useMemo<RenderContextValue>(() => ({
    mode: 'edit', device, dynamic, pageId: page.id, editor: bridge,
  }), [device, dynamic, page.id, bridge]);

  const onMouseOver = (event: ReactMouseEvent) => {
    // Frozen during a drag, so the handle that started it stays rendered.
    if (store.getState().drag) return;
    const path: string[] = [];
    let element = (event.target as HTMLElement).closest<HTMLElement>('[data-rwpb-node]');
    while (element) {
      path.unshift(element.dataset.rwpbNode!);
      element = element.parentElement?.closest<HTMLElement>('[data-rwpb-node]') || null;
    }
    actions.hover(path);
  };

  // The live page is PublicContent's <main> (a width from the page's layout, padding 48/40 for Boxed
  // and Wide and none for Full width) around the builder root, on PublicLayout's grey .rwp-site
  // background and the site's 16px text.
  // Reproducing that matters: without it a Boxed page previews full width and every size that
  // inherits its text (paragraphs, buttons) uses the editor UI's 13px instead.
  // Two elements, because production has two: the scoped theme CSS rewrites the author's html/body/
  // .rwp-site rules onto the outer one, so a `body { padding: 0 }` cannot wipe the container's 40px
  // — on the site those rules sit on a different element than <main class="container">.
  // Header and footer templates render outside <main> on the site, so they get no container at all;
  // a 404 template sits in the boxed container PublicContent uses when there is no page.
  const bleed = Boolean(page.is_site_template && (page.template_type === 'header' || page.template_type === 'footer'));
  const direction = directionOf(locale);
  const siteClass = [
    styles.canvasSite,
    // i18n writes these on <html> for Custom CSS to target. The scoper turns `html.rwp-rtl …` into
    // `.canvasSite.rwp-rtl …`, so the wrapper has to carry the same class the live page would.
    direction === 'rtl' ? 'rwp-rtl' : 'rwp-ltr',
  ].join(' ');
  const containerClass = [
    styles.canvasContainer,
    page.is_site_template && page.template_type === '404'
      ? styles.canvasBoxed
      : layout === 'full' ? styles.canvasFull : layout === 'wide' ? styles.canvasWide : styles.canvasBoxed,
  ].join(' ');

  const layoutRoot = (
    <div
      className={`rwpb-root ${styles.canvasRoot}`}
      data-rwpb-canvas-root=""
      data-rwpb-container="root"
      data-rwpb-accepts="section"
      onMouseOver={onMouseOver}
      onMouseLeave={() => actions.hover([])}
      // Links, buttons and forms are for editing here, not for navigating away.
      onClickCapture={(event) => {
        if ((event.target as HTMLElement).closest('a[href], form button[type=submit]')) event.preventDefault();
      }}
      onSubmitCapture={(event) => event.preventDefault()}
    >
      {doc.settings.showTitle && !page.is_site_template && <h1 className="rwpb-page-title">{title}</h1>}
      <CanvasContent content={doc.content} />
    </div>
  );

  return (
    <main className={styles.canvasArea} data-rwpb-scroller ref={areaRef} onClick={() => actions.select(null)}>
      {/*
        Before the generated rules, which is where production puts it: applyThemeDocument writes
        Custom CSS at the end of <head>, and BuilderRenderer's <style data-rwpb-css="page"> lands in
        the body after it — so an equal-specificity collision goes to the widget's own rule.
      */}
      {themeCss ? <style data-rwpb-css="canvas-theme">{themeCss}</style> : null}
      <style data-rwpb-css="canvas">{css}</style>
      <div className={styles.deviceFrame} style={{ width: frameWidth, zoom: fitScale }} data-device={device} data-rwpb-zoom={fitScale}>
        <RenderProvider value={context}>
          {/* The canvas shows the language being edited, while the editor's own UI stays in the
              admin language, so an RTL page is designed right-to-left without flipping the
              panels around it. lang matters too: it decides the font and digit shaping. */}
          <div className={siteClass} dir={direction} lang={locale}>
            {bleed ? layoutRoot : <div className={containerClass}>{layoutRoot}</div>}
          </div>
        </RenderProvider>
        <div className={styles.addSectionBar} onClick={(event) => event.stopPropagation()}>
          {doc.content.length === 0 && <p>Your page is empty. Drag a widget or a section here, or start from a template.</p>}
          <div>
            <button type="button" className={styles.addSectionButton} onClick={() => actions.addSection([100])}><Plus size={16} /> Add section</button>
            <button type="button" className={styles.addTemplateButton} onClick={onOpenTemplates}><LayoutTemplate size={16} /> Templates</button>
            <button type="button" className={styles.addTemplateButton} onClick={onOpenPageAi}><Sparkles size={16} /> AI Page Generator</button>
          </div>
        </div>
      </div>
    </main>
  );
}
