/**
 * The Code Snippets editor's completion source: src/lib/codeCompletion.ts — the same engine the page
 * builder's code fields use — fed the few tables this screen knows about.
 *
 * A snippet is written against a small, known surface, so the list stays deliberately narrow:
 *
 * - **css** — the app's own global class names (rwp-*, rwpt-*, rwpb-*), the length values a rule
 *   usually wants, and the custom properties a snippet can read. Nothing about Tailwind: this project
 *   does not use it, so a utility class in a snippet would do nothing at all.
 * - **javascript** — the engine's own ES2022 and DOM vocabulary, unchanged.
 * - **html** — the standard elements, plus the global classes on the `class` attribute.
 * - **hook** — the names core fires (src/core/hooks.ts) inside the quotes of addAction/addFilter/
 *   addSlotContent, and the methods of the `rwp` object the runtime hands the snippet
 *   (src/core/SnippetInjector.tsx) after a dot.
 *
 * This file only translates the engine's items into CodeMirror's shape, exactly as
 * plugins/rwp-page-builder/editor/completion.ts does. Plugins never import each other's code, so the
 * icon map and the source body are repeated here on purpose rather than shared.
 */
import {
  insertCompletionText, type Completion, type CompletionContext, type CompletionResult, type CompletionSource,
} from '@codemirror/autocomplete';
import { complete, type CompletionExtras, type CompletionKind, type CompletionMode } from '../../src/lib/codeCompletion';
import type { CompletionEntry } from '../../src/lib/codeCompletionData';
import { coreFilterNames, slotNames } from '../../src/core/hooks';
import type { SnippetType } from '../../src/lib/snippets';

/**
 * CodeMirror's icon names. It tints a known set and draws nothing for anything else, so these follow
 * the names its own HTML, CSS and JavaScript lists use.
 */
const iconNames: Record<CompletionKind, string> = {
  tag: 'type',
  template: 'type',
  attribute: 'property',
  'attribute-value': 'constant',
  property: 'property',
  value: 'constant',
  selector: 'class',
  'at-rule': 'keyword',
  pseudo: 'keyword',
  keyword: 'keyword',
  global: 'variable',
  member: 'method',
  snippet: 'text',
  local: 'variable',
};

/** The same name can arrive from two lists; the first entry wins, so the specific detail survives. */
function firstByName(entries: CompletionEntry[]): CompletionEntry[] {
  const seen = new Set<string>();
  return entries.filter(([name]) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

// What a hook snippet gets ----------------------------------------------------------------------

/**
 * The methods of the `rwp` object the runtime builds for a hook snippet, as [name, detail, the call
 * written after `rwp.`]. The list is the whole API: there is no removeAction, because everything a
 * snippet registers is removed for it when the snippet is switched off.
 */
const rwpApi: Array<[string, string, string]> = [
  ['addAction', 'run a callback when an action fires', "addAction('$0', (...args) => {\n})"],
  ['addFilter', 'change what a filter passes on — the callback must return it', "addFilter('$0', (value) => value)"],
  ['addSlotContent', 'put React markup into a layout zone', "addSlotContent('$0', 'my-snippet', () => rwp.React.createElement('p', null, 'Hi'))"],
  ['applyFilters', 'run your own value through the registered filters', "applyFilters('$0', value)"],
  ['doAction', 'fire an action yourself', "doAction('$0')"],
  ['React', 'React 19 — build markup with createElement; a hook snippet has no JSX', 'React'],
  ['DEFAULT_PRIORITY', 'the priority hooks run at by default (10); lower runs first', 'DEFAULT_PRIORITY'],
];

/** What `rwp.` offers, once the author has typed the object. */
const rwpMembers: CompletionEntry[] = rwpApi.map(([name, detail, call]) => [name, detail, call]);

/** The same methods without the `rwp.` prefix, so typing `addAct` works before the dot is typed. */
const rwpCalls: CompletionEntry[] = rwpApi.map(([name, detail, call]) => [name, `rwp.${name} — ${detail}`, `rwp.${call}`]);

/** Core actions (src/core/hooks.ts — the same list the assistant's prompt in serverAi.mjs gives). */
const coreActions: CompletionEntry[] = [
  ['rwp_init', 'core is starting up'],
  ['rwp_admin_loaded', 'the admin shell is up'],
  ['rwp_admin_ready', 'admin is ready — the callback receives the role'],
  ['rwp_public_loaded', 'the public site is up'],
  ['rwp_user_logged_in', 'a visitor signed in'],
  ['rwp_user_logged_out', 'a visitor signed out'],
  ['rwp_post_created', 'a post row was created'],
  ['rwp_post_updated', 'a post row was updated'],
  ['rwp_post_deleted', 'a post row was deleted'],
  ['rwp_page_created', 'a page row was created'],
  ['rwp_page_updated', 'a page row was updated'],
  ['rwp_page_deleted', 'a page row was deleted'],
  ['rwp_settings_saved', 'settings were saved'],
  ['rwp_menu_saved', 'the menu was saved'],
  ['rwp_plugin_activated', 'a plugin was switched on'],
  ['rwp_plugin_deactivated', 'a plugin was switched off'],
  ['rwp_snippets_applied', 'the snippets were (re)applied'],
];

/** Core filters: the callback must return the value, or the page gets `undefined`. */
const coreFilters: CompletionEntry[] = [
  ['rwp_site_title', 'the site title — return the new one'],
  ['rwp_site_description', 'the tagline under it'],
  ['rwp_public_menu', 'the menu items, as an array'],
  ['rwp_posts', 'a list of posts, as an array'],
  ['rwp_post_title', 'the title of one post — (title, post)'],
  ['rwp_post_excerpt', 'the excerpt of one post — (excerpt, post)'],
  ['rwp_post_content', 'the body of one post — (content, post)'],
  ['rwp_page_content', 'the body of one page — (content, page); the HTML is sanitized after it'],
];

/** Layout zones: the places <HookSlot> renders something a snippet added. */
const zoneNames: CompletionEntry[] = slotNames.map((name) => [name, 'a layout zone — fill it with rwp.addSlotContent']);

/** Every name a hook snippet may register, offered inside the quotes of addAction/addFilter/…. */
const hookNames: CompletionEntry[] = firstByName([
  ...zoneNames,
  ...coreFilters,
  ...coreFilterNames.map((name): CompletionEntry => [name, 'a filter this site applies — return the value']),
  ...coreActions,
]);

// The app's global class names -------------------------------------------------------------------

/**
 * The global class names the app renders — the only class names a snippet's CSS should target.
 *
 * A component's own classes are a CSS Module, which now render `rwp-<module>-<class>` instead of a
 * hash (`vite.cssModules.mjs`): readable in the inspector, but private to the component and renamed
 * with it. What is listed here is the other half — names written by hand, documented in the Theme
 * screen and promised to keep existing, which is what a snippet or Custom CSS may depend on.
 *
 * The rwp- and rwpt- names are the "stable hooks" the Theme screen itself documents; the rwpb- ones
 * are the page builder's output, where every widget element carries `rwpb-el` plus a class named
 * after its type (rwpb-heading, rwpb-button, …) and one by id, `rwpb-n-<node id>`.
 */
const siteClasses: CompletionEntry[] = [
  ['rwpb-root', 'page builder — the wrapper around a whole built page, where its CSS variables are set'],
  ['rwpb-el', 'page builder — every widget element, whatever its type'],
  ['rwpb-container', 'page builder — the max-width container a section uses'],
  ['rwpb-column-inner', 'page builder — the inner wrapper of a column'],
  ['rwpb-page-title', 'page builder — the page title a built page shows'],
  ['rwpb-heading-title', 'page builder — the text inside a Heading widget'],
  ['rwpb-text', 'page builder — the text of a Text widget'],
  ['rwpb-button', 'page builder — a Button widget'],
  ['rwpb-image-frame', 'page builder — the frame an Image widget draws'],
  ['rwpb-icon', 'page builder — an icon'],
  ['rwpb-icon-box', 'page builder — an Icon Box widget'],
  ['rwpb-video', 'page builder — a Video widget'],
  ['rwpb-form', 'page builder — a Form widget'],
  ['rwpb-account-form', 'page builder — the account form widget'],
  ['rwpb-social', 'page builder — a Social Icons widget'],
  ['rwpb-share', 'page builder — a Share Buttons widget'],
  ['rwpb-anim', 'page builder — an element animated on scroll; rwpb-visible is added once it is in view'],
  ['rwpb-visible', 'page builder — an animated element that has come into view'],
  ['rwp-site', 'theme chrome — the wrapper around the whole public page'],
  ['rwp-header', 'theme chrome — the header'],
  ['rwp-nav', 'theme chrome — the navigation inside the header'],
  ['rwp-brand', 'theme chrome — the site name/logo link'],
  ['rwp-footer', 'theme chrome — the footer'],
  ['rwp-footer-columns', 'theme chrome — the footer columns'],
  ['rwp-sidebar', 'theme chrome — the sidebar'],
  ['rwp-index', 'theme chrome — the main content column of the home page'],
  ['rwp-hero', 'theme chrome — the home page hero'],
  ['rwp-posts-feed', 'theme chrome — a list of post cards'],
  ['rwp-post-card', 'theme chrome — one post card'],
  ['rwp-archive', 'theme chrome — an archive page'],
  ['rwp-archive-search', 'theme chrome — the search box on an archive'],
  ['rwp-comments', 'theme chrome — the comments section'],
  ['rwp-comments-list', 'theme chrome — the list of comments'],
  ['rwp-comment', 'theme chrome — one comment; its text is written by visitors'],
  ['rwp-auth-shell', 'theme chrome — the log in / register / profile page'],
  ['rwp-language-switcher', 'theme chrome — the language switcher'],
  ['rwp-live-search', 'theme chrome — the live search form (also -label, -row, -go, -results, -note)'],
  ['rwpt-block', 'theme block — a block placed in the layout; the type follows, rwpt-block-text'],
  ['rwpt-text', 'theme block — a text block'],
  ['rwpt-rules', 'theme block — the comment rules'],
  ['rwpt-pagination', 'theme block — page links'],
  ['rwpt-grid', 'theme block — the main column plus sidebar grid'],
  ['rwpt-sidebar-sticky', 'theme block — a sidebar that follows the scroll'],
  ['rwpt-feed-grid', 'theme block — the post grid'],
  ['rwpt-widget-stack', 'theme block — the widgets in a sidebar or footer column'],
  ['rwpt-index-main', 'theme block — the main column of the home page'],
  ['rwpt-index-full', 'theme block — a full-width segment of the home page'],
  ['rwpt-sticky', 'theme block — a header that sticks to the top'],
  ['rwpt-hide-mobile', 'theme block — hidden on small screens'],
  ['rwpt-hide-desktop', 'theme block — hidden on large screens'],
];

/** `class="…"` inside an HTML snippet: the same names, so the markup it adds can be styled. */
const classEntries: CompletionEntry[] = siteClasses.map(([name, detail]) => [name, `a global class — ${detail}`]);

// CSS values ------------------------------------------------------------------------------------

/** What a property that takes a length can be set to, including the functions worth knowing. */
const lengthValues: CompletionEntry[] = [
  ['0', 'none — no unit needed'],
  ['2px', 'two pixels'], ['4px', 'four pixels'], ['8px', 'eight pixels'], ['12px', 'twelve pixels'],
  ['16px', 'sixteen pixels'], ['24px', 'twenty-four pixels'], ['32px', 'thirty-two pixels'], ['48px', 'forty-eight pixels'],
  ['0.5rem', 'half the root font size'], ['1rem', 'the root font size — 16px unless the theme changes it'],
  ['1.5rem', 'one and a half times it'], ['2rem', 'twice it'], ['3rem', 'three times it'],
  ['50%', 'half the parent'], ['100%', 'all of the parent'],
  ['100vw', 'the viewport width'], ['100vh', 'the viewport height'], ['100dvh', 'the viewport height without the phone’s toolbars'],
  ['auto', 'let the browser work it out'],
  ['calc(', 'work it out from other values', 'calc($0)'],
  ['clamp(', 'never smaller, never larger', 'clamp($0)'],
  ['fit-content(', 'only as wide as the content allows', 'fit-content($0)'],
];

/** The properties those values make sense on. */
const lengthProperties = [
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-block', 'margin-inline',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-block', 'padding-inline',
  'top', 'right', 'bottom', 'left', 'inset', 'gap', 'row-gap', 'column-gap', 'flex-basis',
  'font-size', 'line-height', 'letter-spacing', 'border-radius', 'border-width', 'outline-offset',
];

/** The colours a rule is most likely to want: the builder's globals, and the inherited text colour. */
const colorValues: CompletionEntry[] = [
  ['var(--rwpb-primary)', 'a page builder global — set on .rwpb-root'],
  ['var(--rwpb-secondary)', 'a page builder global'],
  ['var(--rwpb-text)', 'the page builder text colour'],
  ['var(--rwpb-accent)', 'a page builder global'],
  ['currentColor', 'whatever the surrounding text colour is'],
];

const cssValues: Record<string, CompletionEntry[]> = {
  ...Object.fromEntries(lengthProperties.map((property) => [property, lengthValues])),
  color: colorValues,
  background: colorValues,
  'background-color': colorValues,
  'font-family': [['var(--rwp-font-family)', 'the font family the theme sets']],
};

/**
 * Custom properties a snippet can read. The rwpb-* ones only exist on pages the builder rendered;
 * `--rwpb-font-primary` and `--rwpb-font-headings` are font stacks, the rest are colours.
 */
const cssCustomProperties: CompletionEntry[] = [
  ['--rwp-font-family', 'the font family the theme sets'],
  ['--rwpb-primary', 'page builder global — the primary colour'],
  ['--rwpb-secondary', 'page builder global — the secondary colour'],
  ['--rwpb-text', 'page builder global — the text colour'],
  ['--rwpb-accent', 'page builder global — the accent colour'],
  ['--rwpb-font-primary', 'page builder global — the body font stack'],
  ['--rwpb-font-headings', 'page builder global — the heading font stack'],
];

// The source -------------------------------------------------------------------------------------

/** The engine mode for one snippet type; a hook snippet is plain ES2022, so plain JavaScript. */
function modeOf(type: SnippetType): CompletionMode {
  if (type === 'css') return 'css';
  if (type === 'html') return 'html';
  return 'js';
}

/**
 * What the field's type adds to the engine's tables. Only a hook snippet gets `rwp` and the hook
 * names: a JavaScript or HTML snippet has no registry in scope, so offering one would teach the
 * author a mistake.
 */
export function snippetExtras(type: SnippetType): CompletionExtras {
  if (type === 'hook') {
    return {
      locals: ['rwp', 'snippet'],
      members: {
        rwp: rwpMembers,
        // The runtime's second argument: the row's own { id, title }.
        snippet: [['id', 'the snippet’s row id'], ['title', 'the snippet’s title']],
      },
      js: rwpCalls,
      strings: hookNames,
    };
  }
  if (type === 'css') {
    return { selectors: siteClasses.map(([name]) => name), cssValues, css: cssCustomProperties };
  }
  if (type === 'html') {
    return { attributeValues: { class: classEntries } };
  }
  return {};
}

/** A CodeMirror completion source for one snippet type. */
export function snippetCompletion(type: SnippetType): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const engine = complete(context.state.doc.toString(), context.pos, modeOf(type), snippetExtras(type));
    if (!engine || engine.items.length === 0) return null;

    const options: Completion[] = engine.items.map((item) => ({
      label: item.label,
      detail: item.detail,
      type: iconNames[item.kind],
      apply: (view, _completion, from, to) => {
        view.dispatch({
          ...insertCompletionText(view.state, item.insert, from, to),
          selection: { anchor: from + item.caret },
        });
      },
    }));

    // filter: false — the engine returns the list already ordered and trimmed by context, and a
    // second, substring-based pass here would drop entries it deliberately kept.
    return { from: engine.from, to: engine.to, options, filter: false };
  };
}
