import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragStartEvent } from '@dnd-kit/core';
import { Layers, LayoutGrid, Palette, SearchCheck, Settings2 } from 'lucide-react';
import { HookSlot } from '../../../src/core/HookSlot';
import { CLIPBOARD_STORAGE_KEY, parseClipboardEntry, readClipboard } from '../lib/clipboard';
import { findNode } from '../lib/tree';
import { autosaveKey } from '../lib/keys';
import Canvas from './Canvas';
import { computeDropTarget } from './dnd';
import GlobalStylesPanel from './GlobalStylesPanel';
import InspectorPanel from './InspectorPanel';
import Navigator from './Navigator';
import PageSettingsPanel from './PageSettingsPanel';
import RevisionsModal from './RevisionsModal';
import CopyAiModal from './ai/CopyAiModal';
import PageAiModal from './ai/PageAiModal';
import CustomCodeAiModal from './ai/CustomCodeAiModal';
import SeoPanel from './seo/SeoPanel';
import TemplatesModal, { type TemplatesModalMode } from './TemplatesModal';
import TopBar from './TopBar';
import WidgetPanel from './WidgetPanel';
import { isDirty, useEditor, useStore, type DragItem, type SidePanel } from './store';
import styles from './editor.module.css';

const panelTabs: Array<{ id: SidePanel; label: string; icon: typeof Layers }> = [
  { id: 'widgets', label: 'Widgets', icon: LayoutGrid },
  { id: 'navigator', label: 'Navigator', icon: Layers },
  { id: 'globals', label: 'Site styles', icon: Palette },
  { id: 'page', label: 'Page settings', icon: Settings2 },
  { id: 'seo', label: 'SEO', icon: SearchCheck },
];

const builtinPanels: SidePanel[] = ['widgets', 'navigator', 'globals', 'page', 'seo', 'edit'];
const isBuiltinPanel = (panel: SidePanel) => builtinPanels.includes(panel);

// The panel/canvas boundary is draggable (see SidebarResizer below). The width is remembered
// across visits so a chosen layout survives a reload, and is clamped so the canvas keeps a
// usable width on any viewport.
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 640;
const SIDEBAR_DEFAULT = 320;
const SIDEBAR_RESERVE = 320;
const SIDEBAR_STORAGE_KEY = 'rwp-page-builder.sidebar-width';

function readStoredSidebarWidth() {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT;
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX) return stored;
  } catch {
    // Storage can be blocked (private mode, cookie policy); fall back to the default.
  }
  return SIDEBAR_DEFAULT;
}

function writeStoredSidebarWidth(width: number) {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Ignore: a preference that cannot be stored is not worth failing a resize over.
  }
}

const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  // Inside a dialog (templates, media library), Delete and Ctrl+V belong to the dialog, not the canvas.
  return Boolean(element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.closest?.('[role="dialog"]')));
};

export default function PageBuilderLayout() {
  const store = useStore();
  const { actions } = store;
  const panel = useEditor((state) => state.panel);
  const selectedId = useEditor((state) => state.selectedId);
  const drag = useEditor((state) => state.drag);
  const dropTarget = useEditor((state) => state.dropTarget);
  const aiTarget = useEditor((state) => state.aiTarget);
  const aiCodeNodeId = useEditor((state) => state.aiCodeNodeId);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [pageAiOpen, setPageAiOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplatesModalMode | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const saveRef = useRef<() => void>(() => {});
  const pointer = useRef({ x: 0, y: 0 });
  const frame = useRef(0);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Sidebar resize --------------------------------------------------------------------------
  const sidebarStart = useRef<{ x: number; width: number } | null>(null);

  const clampSidebar = useCallback((width: number) => {
    // Never let the panel own the whole viewport: the canvas keeps SIDEBAR_RESERVE at least.
    const available = Math.max(SIDEBAR_MIN, (typeof window === 'undefined' ? SIDEBAR_MAX : window.innerWidth) - SIDEBAR_RESERVE);
    const max = Math.min(SIDEBAR_MAX, available);
    return Math.round(Math.max(SIDEBAR_MIN, Math.min(max, width)));
  }, []);

  const onSidebarResizeStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Stop the DndContext's pointer sensor from reading this as the start of a canvas drag,
    // and keep focus/selection where they are while the handle is dragged.
    event.preventDefault();
    event.stopPropagation();
    sidebarStart.current = { x: event.clientX, width: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };

  const onSidebarResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = sidebarStart.current;
    if (!origin) return;
    setSidebarWidth(clampSidebar(origin.width + (event.clientX - origin.x)));
  };

  const onSidebarResizeEnd = () => {
    if (!sidebarStart.current) return;
    sidebarStart.current = null;
    setResizing(false);
  };

  const onSidebarResizeKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 40 : 16;
    const next = event.key === 'ArrowLeft' ? sidebarWidth - step
      : event.key === 'ArrowRight' ? sidebarWidth + step
        : null;
    if (next === null) return;
    event.preventDefault();
    setSidebarWidth(clampSidebar(next));
  };

  // Persist the width once dragging settles (and after keyboard nudges), not on every pointermove.
  useEffect(() => {
    if (resizing) return;
    writeStoredSidebarWidth(sidebarWidth);
  }, [resizing, sidebarWidth]);

  // Keyboard shortcuts ----------------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveRef.current();
        return;
      }
      if (isTyping(event.target)) return;
      const { selectedId: selected } = store.getState();
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) actions.redo(); else actions.undo();
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        actions.redo();
      } else if (selected && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        actions.remove(selected);
      } else if (selected && mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        actions.duplicate(selected);
      } else if (selected && mod && event.key.toLowerCase() === 'c') {
        // Keep the browser from also copying the page text behind the canvas.
        event.preventDefault();
        actions.copy(selected);
      } else if (event.key === 'Escape') {
        actions.select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, store]);

  // Pasting goes through the browser's paste event: it hands the clipboard text straight to the
  // page, without the permission prompt `navigator.clipboard.readText()` can raise, and it covers
  // the Paste a browser menu triggers too. That text is how a section copied on another site gets
  // here, so this listener replaces the Ctrl+V shortcut rather than running beside it.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isTyping(event.target)) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      const state = store.getState();
      // Leave ordinary text alone when there is no builder copy to paste.
      if (!parseClipboardEntry(text) && !readClipboard() && !state.clipboard) return;
      event.preventDefault();
      void actions.paste(state.selectedId, text);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [actions, store]);

  // The clipboard is shared across builder pages and tabs through localStorage.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === CLIPBOARD_STORAGE_KEY) actions.refreshClipboard();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [actions]);

  // Local autosave and leave warning --------------------------------------------------------------
  useEffect(() => {
    let timer = 0;
    let lastDoc = store.getState().doc;
    let lastTitle = store.getState().title;
    const unsubscribe = store.subscribe(() => {
      const state = store.getState();
      if (state.doc === lastDoc && state.title === lastTitle) return;
      lastDoc = state.doc;
      lastTitle = state.title;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const current = store.getState();
        try {
          if (isDirty(current)) {
            localStorage.setItem(autosaveKey(current.page.id), JSON.stringify({ doc: current.doc, title: current.title, savedAt: Date.now(), baseUpdatedAt: current.page.updated_at }));
          } else {
            localStorage.removeItem(autosaveKey(current.page.id));
          }
        } catch {
          // Storage full or blocked: autosave is a convenience, saving still works.
        }
      }, 1200);
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (isDirty(store.getState())) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [store]);

  // Drag and drop -------------------------------------------------------------------------------
  const trackPointer = useCallback((event: PointerEvent) => {
    pointer.current = { x: event.clientX, y: event.clientY };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const state = store.getState();
      if (!state.drag) return;
      const target = computeDropTarget(state.doc, state.drag, pointer.current.x, pointer.current.y);
      const previous = state.dropTarget;
      if (target?.parentId !== previous?.parentId || target?.index !== previous?.index || target?.line.y !== previous?.line.y || target?.line.x !== previous?.line.x) {
        store.setState({ dropTarget: target });
      }
    });
  }, [store]);

  // Scroll the canvas while dragging near its top or bottom edge.
  useEffect(() => {
    if (!drag) return undefined;
    const timer = window.setInterval(() => {
      const scroller = document.querySelector<HTMLElement>('[data-rwpb-scroller]');
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const { x, y } = pointer.current;
      if (x < rect.left || x > rect.right) return;
      if (y < rect.top + 60) scroller.scrollTop -= 14;
      else if (y > rect.bottom - 60) scroller.scrollTop += 14;
    }, 16);
    return () => window.clearInterval(timer);
  }, [drag]);

  const endDrag = () => {
    window.removeEventListener('pointermove', trackPointer);
    cancelAnimationFrame(frame.current);
  };

  const onDragStart = (event: DragStartEvent) => {
    const item = event.active.data.current as DragItem | undefined;
    if (!item) return;
    const start = event.activatorEvent as PointerEvent;
    pointer.current = { x: start.clientX, y: start.clientY };
    store.setState({ drag: item, dropTarget: null });
    window.addEventListener('pointermove', trackPointer);
  };

  const onDragEnd = () => {
    endDrag();
    const { drag: item, dropTarget: target } = store.getState();
    store.setState({ drag: null, dropTarget: null });
    if (item && target) actions.insert(item, target);
  };

  const onDragCancel = () => {
    endDrag();
    store.setState({ drag: null, dropTarget: null });
  };

  const selectedExists = useEditor((state) => Boolean(state.selectedId && findNode(state.doc, state.selectedId)));

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel} autoScroll={false}>
      <div className={styles.shell} data-rwpb-shell>
        <TopBar
          registerSave={(save) => { saveRef.current = save; }}
          onOpenRevisions={() => setRevisionsOpen(true)}
          onOpenTemplates={() => setTemplates({ kind: 'insert' })}
          onSavePageTemplate={() => setTemplates({ kind: 'save-page' })}
          onOpenPageAi={() => setPageAiOpen(true)}
        />
        <div className={styles.workspace} style={{ '--ed-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
          <aside className={styles.sidebar} aria-label="Builder panels">
            <div className={styles.sidebarTabs} role="tablist">
              {panelTabs.map(({ id, label, icon: TabIcon }) => (
                <button key={id} type="button" role="tab" aria-selected={panel === id} title={label}
                  className={panel === id ? styles.sidebarTabActive : styles.sidebarTab} onClick={() => actions.setPanel(id)}>
                  <TabIcon size={16} strokeWidth={2} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
              {/* A plugin adds a tab by rendering its own button here and calling setPanel. */}
              <HookSlot name="builder_sidebar_tabs" args={{ panel, setPanel: actions.setPanel }} />
            </div>
            <div className={styles.sidebarBody}>
              {/* …and its panel body here, shown when its own id is the active panel. */}
              <HookSlot name="builder_sidebar_panel" args={{ panel, setPanel: actions.setPanel }} />
              {/* A plugin's panel id is not one of ours, so the built-in chain stays out of its way. */}
              {!isBuiltinPanel(panel) ? null
                : panel === 'edit' && selectedId && selectedExists
                  ? <InspectorPanel nodeId={selectedId} onSaveTemplate={(nodeId) => setTemplates({ kind: 'save-section', nodeId })} />
                  : panel === 'navigator' ? <Navigator onSaveTemplate={(nodeId) => setTemplates({ kind: 'save-section', nodeId })} />
                    : panel === 'globals' ? <GlobalStylesPanel />
                      : panel === 'page' ? <PageSettingsPanel />
                        : panel === 'seo' ? <SeoPanel />
                          : <WidgetPanel />}
            </div>
          </aside>
          {/* Drag (or arrow-key) the boundary to widen the panels; double-click resets it. */}
          <button
            type="button"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            title="Drag to resize"
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            className={resizing ? `${styles.sidebarResizer} ${styles.sidebarResizerActive}` : styles.sidebarResizer}
            onPointerDown={onSidebarResizeStart}
            onPointerMove={onSidebarResizeMove}
            onPointerUp={onSidebarResizeEnd}
            onPointerCancel={onSidebarResizeEnd}
            onKeyDown={onSidebarResizeKey}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
          />
          <Canvas onOpenTemplates={() => setTemplates({ kind: 'insert' })} onOpenPageAi={() => setPageAiOpen(true)} />
        </div>
      </div>
      {dropTarget && (
        <div className={styles.dropLine} aria-hidden="true"
          style={{ left: dropTarget.line.x, top: dropTarget.line.y, width: dropTarget.line.width, height: dropTarget.line.height }} />
      )}
      <DragOverlay dropAnimation={null}>
        {drag ? <div className={styles.dragChip}>{drag.label}</div> : null}
      </DragOverlay>
      {revisionsOpen && <RevisionsModal onClose={() => setRevisionsOpen(false)} />}
      {pageAiOpen && <PageAiModal onClose={() => setPageAiOpen(false)} />}
      {templates && <TemplatesModal mode={templates} onClose={() => setTemplates(null)} />}
      {aiTarget && <CopyAiModal key={`${aiTarget.kind}:${aiTarget.nodeId}:${aiTarget.kind === 'field' ? aiTarget.key : ''}`} target={aiTarget} onClose={actions.closeCopyAi} />}
      {aiCodeNodeId && <CustomCodeAiModal key={aiCodeNodeId} nodeId={aiCodeNodeId} onClose={actions.closeCodeAi} />}
    </DndContext>
  );
}
