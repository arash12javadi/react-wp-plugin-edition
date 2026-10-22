import { useRef, useState } from 'react';
import Image from '@tiptap/extension-image';
import { mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import styles from './ResizableImage.module.css';

export type ImageAlign = 'left' | 'center' | 'right';

/**
 * Alignment and width are baked into an inline style rather than a class, because the
 * published page is rendered outside this stylesheet and would otherwise lose the layout.
 *
 * The saved HTML is produced by `renderHTML` below, not by the node view: the node view only
 * draws the editor's canvas. Both read the same two attributes, so a size or an alignment
 * picked in the toolbar has to end up in `style` here or it exists only in the editor.
 */
const alignCss: Record<ImageAlign, string> = {
  left: 'display:block;margin:1em auto 1em 0;',
  center: 'display:block;margin:1em auto;',
  right: 'display:block;margin:1em 0 1em auto;',
};

const buildStyle = (align: ImageAlign, width: string | null) =>
  `${alignCss[align] || alignCss.center}${width ? `width:${width};` : ''}max-width:100%;height:auto;`;

const presets: Array<[string, string]> = [['25%', 'S'], ['50%', 'M'], ['75%', 'L'], ['100%', 'Full']];

function ImageNodeView({ node, updateAttributes, selected, editor }: ReactNodeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const align = (node.attrs.align || 'center') as ImageAlign;
  const width = node.attrs.width as string | null;

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    const image = containerRef.current?.querySelector('img');
    const available = containerRef.current?.parentElement?.clientWidth || image?.clientWidth || 0;
    if (!image || !available) return;

    const startX = event.clientX;
    const startWidth = image.clientWidth;
    setDragging(true);

    const onMove = (move: MouseEvent) => {
      const next = Math.max(60, Math.min(available, startWidth + (move.clientX - startX)));
      updateAttributes({ width: `${Math.round((next / available) * 100)}%` });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <NodeViewWrapper className={styles.wrapper} data-drag-handle>
      <div ref={containerRef} className={selected ? styles.frameSelected : styles.frame} style={{ textAlign: align }}>
        <span className={styles.imageHolder} style={{ width: width || 'auto' }}>
          <img src={node.attrs.src} alt={node.attrs.alt || ''} title={node.attrs.title || ''} />
          {selected && editor.isEditable && (
            <span
              className={dragging ? styles.handleActive : styles.handle}
              onMouseDown={startResize}
              role="presentation"
              title="Drag to resize"
            />
          )}
        </span>

        {selected && editor.isEditable && (
          <span className={styles.toolbar} contentEditable={false}>
            {(['left', 'center', 'right'] as ImageAlign[]).map((value) => (
              <button
                key={value}
                type="button"
                title={`Align ${value}`}
                aria-pressed={align === value}
                className={align === value ? styles.buttonActive : styles.button}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => updateAttributes({ align: value })}
              >
                {value === 'left' ? '⬅' : value === 'right' ? '➡' : '↔'}
              </button>
            ))}
            <span className={styles.divider} />
            {presets.map(([value, label]) => (
              <button
                key={value}
                type="button"
                title={`Width ${value}`}
                aria-pressed={width === value}
                className={width === value ? styles.buttonActive : styles.button}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => updateAttributes({ width: value })}
              >
                {label}
              </button>
            ))}
            <span className={styles.divider} />
            <button
              type="button"
              title="Reset size"
              className={styles.button}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => updateAttributes({ width: null })}
            >
              Auto
            </button>
            <input
              className={styles.alt}
              value={node.attrs.alt || ''}
              placeholder="Alt text"
              onChange={(event) => updateAttributes({ alt: event.target.value })}
            />
          </span>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      /**
       * Both attributes render themselves to nothing on purpose.
       *
       * `getRenderedAttributes()` — the step that builds `HTMLAttributes` for `renderHTML` — drops
       * every attribute whose `renderHTML` returns an empty object, so `width` and `align` would
       * arrive there as `undefined`. They are merged into a single inline `style` by the node-level
       * `renderHTML` below instead, which reads them straight off `node.attrs` (merging two
       * attribute-level `style` strings would lose whichever was applied first). `renderHTML`
       * cannot be omitted: an attribute without one is emitted verbatim, and `width="50%"` is not
       * a valid img width — browsers ignore a percentage there and fall back to the natural size,
       * which is exactly the "size is ignored on the frontend" bug this guards against.
       */
      width: {
        default: null,
        // The style is what the editor writes, so it is the first place to look; `width` is the
        // fallback for an <img> that came in from elsewhere (imported HTML, pasted markup).
        parseHTML: (element) => element.style.width || element.getAttribute('width') || null,
        renderHTML: () => ({}),
      },
      align: {
        default: 'center',
        parseHTML: (element) => element.getAttribute('data-align') || 'center',
        renderHTML: () => ({}),
      },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const align = (node.attrs.align || 'center') as ImageAlign;
    const width = (node.attrs.width || null) as string | null;
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      'data-align': align,
      // Last, and merged by TipTap's `mergeAttributes` as a style map, so an inline style handed in
      // through `HTMLAttributes` is completed rather than replaced.
      style: buildStyle(align, width),
    })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});

export default ResizableImage;
