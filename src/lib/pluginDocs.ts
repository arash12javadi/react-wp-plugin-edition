/**
 * What each bundled plugin is for, in the words an administrator needs before switching it on.
 *
 * This is a static table rather than something read out of the registry, because most of what is worth
 * saying does not exist anywhere a browser can ask: what a plugin is *for*, which settings it needs
 * before it does anything, and what its uninstall keeps. The registry knows the live shortcodes and
 * admin screens, and Dashboard → Guide & shortcodes renders those from the registration itself; this
 * table is the explanation around them, shown by the Details dialog on Plugins.
 *
 * Adding a plugin means adding an entry here. `pluginDocFor` answers `null` for anything else - an
 * uploaded third-party plugin, say - and the dialog then says what that plugin's own registration can
 * still tell an administrator.
 */

/** One attribute of a shortcode, the way the plugin documents it to itself. */
export interface PluginDocAttribute {
  /** The attribute name as written inside the tag, e.g. `limit`. */
  name: string;
  note: string;
}

export interface PluginDocShortcode {
  /** A working tag. This is also exactly what the dialog's Copy button copies. */
  usage: string;
  description: string;
  attributes?: PluginDocAttribute[];
}

/** One screen, named the way the sidebar names it. */
export interface PluginDocPlace {
  where: string;
  what: string;
}

export interface PluginDocGroup {
  title: string;
  items: string[];
}

export interface PluginDoc {
  /** Shown beside the name in the dialog header. */
  icon: string;
  /** One sentence: what the plugin is for. */
  summary: string;
  /** What it does, grouped the way someone would ask about it. */
  featureGroups: PluginDocGroup[];
  /** Admin screens, in sidebar order. */
  admin?: PluginDocPlace[];
  /** Pages the plugin answers on the public site. */
  publicRoutes?: PluginDocPlace[];
  shortcodes?: PluginDocShortcode[];
  /** The order the work has to be done in, when the order matters. */
  steps: string[];
  /** What surprises people, including what an uninstall keeps. */
  notes?: string[];
  /** One of the plugins sold separately: it needs a key before it can be activated. */
  licensed?: boolean;
}

export const pluginDocs: Record<string, PluginDoc> = {
  'rwp-shop': {
    icon: '🛒',
    licensed: true,
    summary:
      "A complete store on the site's own database: catalogue, cart, checkout, payment methods, orders, reports, and the growth tools that sell more of it.",
    featureGroups: [
      {
        title: 'Catalogue',
        items: [
          'Simple, variable (attributes → variations), grouped and external products, with sale prices and the schedule for when they start and end.',
          'Stock control with backorders, low-stock thresholds, and stock held for orders that are not paid yet.',
          'Categories, tags and global attributes, with layered filtering (on sale, in stock, price, rating, attribute), galleries, upsells and cross-sells.',
          'Downloadable products with a download limit, an expiry and a file list of their own.',
        ],
      },
      {
        title: 'Cart, checkout and payment',
        items: [
          'A cart that survives a reload, and follows a customer to another device once they sign in.',
          'Coupons: percent, fixed cart and fixed product, limited by spend, product, category, email or number of uses.',
          'Tax rates by country, state, postcode and city, with classes, priorities and compound rates; prices can be entered with or without tax.',
          'Shipping zones with flat rate (per item and per class), free shipping and local pickup.',
          'Stripe Checkout, PayPal, bank transfer, cheque and cash on delivery, with refunds by hand or through Stripe and PayPal.',
          'Guest checkout or an account, with orders, downloads and addresses under /my-account.',
        ],
      },
      {
        title: 'Selling more',
        items: [
          'Reviews, with "verified owners only" if you want it, plus product questions and your answers.',
          'Make an offer, price-drop alerts and frequently-bought bundles, each with a shortcode of its own.',
          'Shop → Reports: sales by day, top sellers, orders by status, coupons used and what is low on stock.',
          'Order emails and private order notes, a Shop at a glance dashboard widget, and a header cart.',
        ],
      },
    ],
    admin: [
      { where: 'Shop → Orders', what: 'Every order with its status, payment, notes and refunds.' },
      { where: 'Shop → Products', what: 'The catalogue, including variations, stock, downloads and a Copy shortcode action per product.' },
      { where: 'Shop → Reports', what: 'Sales, top sellers, order status, coupons and low stock.' },
      { where: 'Shop → Customers', what: 'Everyone who has ordered, and what they spent.' },
      { where: 'Shop → Coupons, Reviews, Offers, Questions, Price alerts, Bundles', what: 'One screen per selling tool, each with the switch that turns it on.' },
      { where: 'Shop → Settings', what: 'Store address, currency, tax, shipping zones, payment methods, emails and checkout.' },
      { where: 'Shop → Backup', what: 'Exports the shop to a ZIP holding shop-backup.json and the sales report as a spreadsheet, and imports one back with a mode per part.' },
    ],
    publicRoutes: [
      { where: '/shop', what: 'The catalogue, with its filters and sorting.' },
      { where: '/product/:slug', what: 'A product page: gallery, variations, tabs, reviews and related products.' },
      { where: '/product-category/:slug and /product-tag/:slug', what: 'An archive for one category or tag.' },
      { where: '/cart and /checkout', what: 'Cart and checkout, then /checkout/order-received/:id and /checkout/order-pay/:id once an order exists.' },
      { where: '/my-account and /my-account/*', what: 'Orders, downloads, addresses and account details.' },
    ],
    shortcodes: [
      {
        usage: '[rwp_products limit="4" category="shirts" orderby="popularity"]',
        description: 'A grid of products from the shop.',
        attributes: [
          { name: 'limit', note: 'How many products to show. Default 4.' },
          { name: 'category / tag', note: 'Only products in this category or tag slug.' },
          { name: 'featured / on_sale', note: 'Set to 1 to show only featured or discounted products.' },
          { name: 'orderby', note: 'menu_order (default), popularity, rating, date, price, price-desc or title.' },
          { name: 'ids', note: 'Comma-separated product ids, to pick products by hand.' },
        ],
      },
      {
        usage: '[rwp_add_to_cart id="PRODUCT-ID" label="Buy now" quantity="1"]',
        description: 'An "Add to cart" button for one simple product. Copy shortcode on a product row fills in the id.',
        attributes: [
          { name: 'id', note: 'The product id.' },
          { name: 'label', note: 'Button text. Default "Add to cart".' },
          { name: 'quantity', note: 'How many to add. Default 1.' },
        ],
      },
      {
        usage: '[rwp_cart_link]',
        description: 'A link to the cart with the number of items in it.',
      },
      {
        usage: '[rwp_product_qa slug="blue-shirt"]',
        description: 'A product\'s customer questions and the store\'s answers, with an "Ask a question" form.',
        attributes: [
          { name: 'id / slug', note: 'The product. Leave both out on /product/:slug to use the product being viewed.' },
          { name: 'title', note: 'The heading. Default "Questions & answers".' },
        ],
      },
      {
        usage: '[rwp_make_offer id="PRODUCT-ID"]',
        description: 'A "Make an offer" button for a simple product. Offers are answered under Shop → Offers.',
      },
      {
        usage: '[rwp_price_alert slug="blue-shirt"]',
        description: 'A bell button: signed-in customers are told when the price drops to their target. Alerts live under Shop → Price alerts.',
      },
      {
        usage: '[rwp_frequently_bought slug="camera"]',
        description: 'The products bought together with this one (Shop → Bundles), with the bundle discount and "Add all to cart".',
      },
    ],
    steps: [
      'Activate it here. Activation is what creates the shop tables; a site that never activates the shop never gets them.',
      'Open Shop → Settings → General and fill in the store address: tax "based on shop base address", local pickup and the order emails all read it.',
      'Turn on at least one payment method under Shop → Settings → Payments. Cash on delivery, bank transfer and cheque need nothing else; Stripe and PayPal need the keys in the next step.',
      'For Stripe or PayPal, enter the keys in Settings → Integrations → Shop payments. They are stored in your database and never shown again. The site also needs SUPABASE_SECRET_KEY on the server: without it a paid order can never be marked as paid.',
      'For order emails, either fill in Settings → Integrations → Shop email (a sender of its own) or leave it empty to use Settings → Integrations → Email, then send a test email from either card.',
      "Publish products under Shop → Products, then place [rwp_products] on a page or use the shop's widgets in the Page Builder. /shop, /cart, /checkout and /my-account are routes, so they need no page of their own.",
    ],
    notes: [
      'Sold separately: this screen refuses to activate it until a key is in the License column, and its server routes answer 402 until that key verifies on the server.',
      "Uninstalling drops the shop's tables, orders included. Export Shop → Backup first: the ZIP holds shop-backup.json plus the sales report as a spreadsheet, and product images stay in the Media Library as URLs.",
      "The header cart, the Shop at a glance widget and the Page Builder's Shop widgets are registered by this plugin, so they disappear while it is inactive.",
      'Shop → Settings → Status says which of the server keys above are set, without ever showing a value.',
    ],
  },
  'rwp-page-builder': {
    icon: '🧱',
    licensed: true,
    summary:
      "Builds pages, posts and reusable blocks by dragging sections of widgets, then renders them itself — with the theme's header and footer around the result — at the page's own address.",
    featureGroups: [
      {
        title: 'Editing',
        items: [
          'Add, duplicate, reorder and delete sections, columns and widgets, on a separate builder screen with undo and redo; a revision is saved for every page.',
          'Breakpoints: a section can be hidden on phones, tablets or desktop, and per-device spacing and padding can differ.',
          'Per-widget content, layout and spacing sections — typography, colour, background, border, radius, shadow — plus a read-only advanced section for advanced users.',
          'Save a page as a template (Page Builder → Templates) and start another page from it.',
        ],
      },
      {
        title: 'Widgets',
        items: [
          'Structural widgets — Section, Inner section, Column — and the content ones: Heading, Text editor, Image, Button, Divider, Spacer, Icon, Icon box, Icon list, Quote, Alert, Video, Custom HTML, Shortcode, Menu anchor.',
          'More than a hundred widgets in five groups: basic, dynamic, site and WordPress (Site logo, Site title, Nav menu, Page title, Post title, Post content, Post meta, Posts, Loop grid, Loop carousel, Sitemap, Table of contents, Search, Archives, Calendar, Tag cloud, Meta, Breadcrumbs, Theme header and Theme footer), plus form, account, gallery, testimonial and pricing widgets.',
          'Its own category for every plugin that adds widgets — the shop’s cart, products and checkout widgets, and AI Factory’s console, arrive this way.',
          'A widget category appears only while the plugin that registers it is active, so the picker never offers a widget that would render nothing.',
        ],
      },
      {
        title: 'Rendering',
        items: [
          "Sections render server-side at the page's own URL, inside the theme's header and footer, so a built page is a normal page for search engines and for the rest of the site.",
          'A page with a builder document is rendered by the builder; a page without one is rendered by the theme exactly as before.',
          'A used builder page cannot be switched back to the theme in one click by accident: the document is kept, so switching the mode off and on again restores the layout.',
        ],
      },
    ],
    admin: [
      { where: 'Page Builder → Site Pages', what: 'Every page of the site in one list — core pages (home, blog), theme templates and shop pages — with a switch to build each one and a link straight into the editor.' },
      { where: 'Page Builder → Templates', what: 'Saved layouts a page can start from, and the site templates for the theme header, footer, single post, 404 and archives.' },
      { where: 'Page Builder → Form Submissions', what: 'Every entry sent through a Form widget, with the page it came from and the fields it carried.' },
      { where: 'Page Builder → Status', what: 'Whether form notification email can be sent from this server, and whether the AI Section Refine feature has a key.' },
      { where: 'Pages and Posts → Edit', what: 'Switch a single post to the builder, and edit it at /builder/:id — the editor opens with the page’s settings panel beside it.' },
    ],
    steps: [
      'Activate it. Nothing else is needed: the builder screen, its assets and its renderer are registered by the plugin itself.',
      'Open Page Builder → Site Pages and press ✎ Page Builder beside the page. The list also switches pages to the builder in bulk, and filters by Builder or Classic.',
      'Build the layout, then press Save. The page keeps its own address and its own place in the menu; the builder takes over rendering until the page is switched back to the theme.',
      'Set the page width, background and custom CSS in the editor’s Page settings panel, and the header and footer once under Page Builder → Templates.',
      'Optional: add a Form widget, set its Email notification recipients, and check Page Builder → Status for what the server still needs — entries are stored in Form Submissions either way.',
    ],
    notes: [
      "Uninstalling drops the builder's own tables — templates, revisions, form submissions and form settings — and its global styles option. Documents stay in pages.builder_data, so reactivating restores every layout; a page falls back to its classic content while the plugin is inactive.",
      "The builder can take over the theme header, footer, single post, 404, search and archive screens from Page Builder → Templates; a screen without a template stays the theme's.",
      "A widget registered by another plugin renders only while that plugin is active. The cart and checkout ones show a placeholder in the editor and appear on the live page, because they need a session the editor does not have.",
    ],
  },
  'rwp-chat': {
    icon: '💬',
    summary:
      "Every conversation about the site in one place: a live chat widget for visitors, and channels for Telegram, Messenger, WhatsApp, Slack and email — with the site's content as answers.",
    featureGroups: [
      {
        title: 'Where the conversations are',
        items: [
          'Inbox: a widget on the public site, and a full-screen chat under Chat, with one thread per visitor.',
          'Channels: connect Telegram, Messenger, WhatsApp, Slack or email, and answer from Chat without leaving the admin.',
          'Knowledge base: answers built from pages, posts, products and hand-written entries, so the assistant can reply before a person does.',
        ],
      },
      {
        title: 'How a conversation is answered',
        items: [
          'Scripted answers first: a keyword or phrase in an entry beats a generated reply, so prices, opening hours and return policy stay exact.',
          'Name, email and phone are asked for when the conversation needs them, and land on the conversation and in the inbox.',
          'Hand-off: a visitor asking for a person, or a reply the assistant will not give, brings the conversation to the inbox with a notification in the admin header.',
          'Working hours, an offline message and an away reply, per channel.',
        ],
      },
      {
        title: 'Control',
        items: [
          "The AI provider is chosen under Chat → Settings, with the model, temperature and the system prompt; without a key only the knowledge base's scripted answers are used.",
          'Every conversation is stored on the site and can be searched, starred, annotated with a private note, and exported.',
          'Per-channel switches, and an option to turn the public widget off while the inbox keeps working.',
        ],
      },
    ],
    admin: [
      { where: 'Chat → Inbox', what: 'Every conversation, newest first, with search, filters and the reply box.' },
      { where: 'Chat → Knowledge base', what: 'The entries behind scripted answers, each with its keywords, and the import of pages, posts and products.' },
      { where: 'Chat → Channels', what: 'One card per channel: connect, test the connection, switch it on.' },
      { where: 'Chat → Settings', what: 'Widget appearance and position, working hours, AI provider and prompt, retention of conversations.' },
      { where: 'Header → Speech-bubble button', what: 'The inbox with the count of conversations waiting for a person, on every admin screen.' },
    ],
    steps: [
      'Activate it, then open Chat → Settings and fill in the widget title, welcome message and working hours.',
      'Add two or three entries under Chat → Knowledge base — the things visitors ask most — and import pages and posts so the answers have something to stand on.',
      'Optional: choose an AI provider in Chat → Settings and put its key in .env.local (OPENAI_API_KEY, or ANTHROPIC_API_KEY / GEMINI_API_KEY). Without one the scripted answers still work.',
      'Optional: measure whether a channel is ready before switching it on with the Test button on Chat → Channels. Telegram and Slack need a bot token, Messenger and WhatsApp a page or phone-number id plus a token, email an SMTP host — all of them are set in the environment, not in the database.',
      'Open the public site and send a message to yourself; it should appear in Chat → Inbox within a few seconds, and the header count should show it.',
    ],
    notes: [
      'Sold separately: a key is required before this screen will activate it, and its server routes answer 402 until that key verifies.',
      'Uninstalling drops the conversations, the knowledge-base entries and the settings. Export the conversation you need from the inbox first.',
      "The public widget is served on every page of the site while the plugin is active. If the site's Content-Security-Policy is set by hand, add the plugin's script and connect sources to it, or the widget will be blocked.",
      'Channels are inbound only: the site answers where the message came from, so an email channel needs SMTP and a Telegram channel needs its bot token in the environment before it delivers anything.',
    ],
  },
  'rwp-ai-factory': {
    icon: '✨',
    summary:
      "Turns a plain-language description into a code snippet or a complete plugin ZIP, using the administrator's or the visitor's own OpenAI, Gemini or Anthropic key.",
    featureGroups: [
      {
        title: 'One prompt, two kinds of answer',
        items: [
          'Auto lets the model pick the smaller answer; Snippet produces one piece of CSS, JavaScript, HTML or a React hook; Plugin produces the files a plugin is made of — manifest.json, index.tsx, and server.mjs when the answer needs a server — packed as a ZIP.',
          'The result is a preview, never an install: a snippet is copied into Code Snippets, a plugin ZIP is uploaded through Plugins → Upload Plugin, so generated code passes the same review and activation as anything else.',
          'Each result carries the request that produced it and the token usage the provider reported, so a surprising answer can be traced back to its prompt.',
        ],
      },
      {
        title: 'The request',
        items: [
          "Provider, model and API base URL are all yours to choose, so a proxy, a self-hosted gateway or an OpenAI-compatible service works the same as the provider's own endpoint.",
          'The four stages are shown while it runs (reading the platform context, contacting the provider, validating and packaging, then the preview), and a request can be cancelled.',
          'An answer that fails validation gets one automatic repair attempt before it is reported as failed, and the preview marks the result when that happened.',
          'A browser-side throttle allows six requests a minute, and a provider 429 is respected through its Retry-After.',
        ],
      },
      {
        title: 'The preview',
        items: [
          'A file list with sizes, syntax highlighting, copy for the active file, and Download plugin ZIP for the whole package.',
          'A short audit before the download button (secrets, eval-style code, network calls, a manifest that fits the platform), with the install steps for what was generated.',
          'For a snippet, the preview names the Code Snippets type and location to use, so the pasted code runs where it was written to run.',
        ],
      },
      {
        title: 'Where the key lives',
        items: [
          'Nothing is sent to this site’s server and nothing is stored in the database: the plugin has no backend and no tables.',
          'The key is kept in sessionStorage for the current tab, or — when “Remember on this device” is on — as ciphertext in localStorage that needs the passphrase to open.',
          'Forget key removes both copies, and the provider key can be tested from the same dialog before a prompt is spent.',
        ],
      },
    ],
    admin: [
      { where: 'AI Factory', what: 'The console: connect a provider, choose Auto/Snippet/Plugin, write the prompt, then read the preview and the install guide.' },
    ],
    shortcodes: [
      {
        usage: '[rwp_ai_factory title="Build a small feature" intro="Describe it; you review the code before installing."]',
        description: 'The same console on any public page. Each visitor brings their own key, which stays in their browser; nothing generated is applied for them.',
        attributes: [
          { name: 'title', note: 'The heading above the prompt. Default “Build something for this site”.' },
          { name: 'intro', note: 'One or two sentences under the heading, instead of the default introduction.' },
        ],
      },
    ],
    steps: [
      'Activate the plugin and open AI Factory, then press Connect provider.',
      'Choose OpenAI, Google Gemini or Anthropic, paste a key created on that provider’s key page, pick a model and press Test connection.',
      'Describe the job in plain language — what it should do and where it should appear — and press Generate.',
      'Read the preview and the audit. For a snippet, copy it into Code Snippets → All Snippets (or follow the generated steps); for a plugin, download the ZIP and upload it on Plugins.',
      'Optional: turn on “Remember on this device” with a passphrase if the key should survive closing the tab.',
      'Optional: put [rwp_ai_factory] on a page, or add the AI Factory widget in Page Builder, for visitors who have their own key.',
    ],
    notes: [
      'Development edition only: it is the tool that builds plugins, so it never ships inside a customer’s public template.',
      'Uninstalling drops the folder and nothing else: there are no tables and no options, and the browser-held keys are unaffected.',
      'Browser calls go straight to the provider, so the provider has to allow CORS from this site. A key restricted to a proxy can be pointed at through the Advanced base URL field.',
      'The shortcode is public by design, but the console needs a key before anything is sent: a visitor without one is asked to connect a provider first.',
      'The generated code is a starting point, not a review. The audit only flags known patterns, and the installer’s build is the real check.',
    ],
  },
  'rwp-code-snippets': {
    icon: '🧩',
    licensed: true,
    summary:
      'CSS, JavaScript, HTML and React hooks added to the site from the admin — no theme file edited, no plugin uploaded — with an AI writer, an assistant that knows the platform, and a JSON backup of everything.',
    featureGroups: [
      {
        title: 'Writing a snippet',
        items: [
          'Four types: CSS, JavaScript, HTML, and a React hook. A hook snippet is plain ES2022 without JSX, evaluated with new Function, and is handed an rwp object with addAction, addFilter and addSlotContent.',
          'Each snippet has a title, a description, a target surface, a priority and tags. Tags and the search box (title, description, tag) are how a long list stays navigable.',
          'The code field is CodeMirror with Tab indenting, and its completion list is limited to what actually exists here: the rwp-/rwpb- class names, the core hook and filter names, and the rwp helper — deliberately not Tailwind.',
          'Duplicate, delete, and bulk Switch on / Switch off / Export selected / Delete for a whole selection, with All / Active / Inactive filters over the list.',
        ],
      },
      {
        title: 'Where and when it runs',
        items: [
          'Three placements are public only — in <head>, end of <body>, and the public site generally — and never reach /admin; “Admin screens only” and “Public site and admin” are the two that do.',
          'Priority decides the order — lower runs first, 10 by default — the same rule as hook callbacks.',
          'The runtime loads the active rows for the surface it is on and applies each snippet inside its own try/catch, with a catch around every JavaScript snippet, so one failure cannot blank the site.',
          'Switching a snippet off undoes the elements and the hooks it registered without a reload. Work the code already did — a request it sent, an element it removed — is not undone; that needs a reload.',
        ],
      },
      {
        title: 'The AI, when you want it',
        items: [
          'Generate writes a snippet from a description in the chosen type; Refine rewrites what is already in the editor, so a first draft can be kept and improved.',
          'Ask the assistant opens a drawer that has been told how this CMS works — the hook registry, the tables, the global class names — and can put its answer into the editor.',
          'Nothing the AI writes runs by itself: it is inserted for a person to read, then saved and switched on like any other snippet.',
          'Both features use the key saved under Settings → Integrations → AI, read by the server and never sent to the browser. Snippets work without it.',
        ],
      },
      {
        title: 'Backup and restore',
        items: [
          'Export selected writes one rwp-code-snippets-backup .json file — active and inactive rows, ids included — which doubles as a way to move snippets between a staging site and a live one.',
          'Import checks every row before writing anything: a bad type, a missing title or an unknown location names the row that has to be fixed by hand.',
          'Keep-both inserts copies, Overwrite replaces rows by id, and imported snippets arrive switched off unless the activate box is ticked.',
        ],
      },
    ],
    admin: [
      { where: 'Code Snippets → All Snippets', what: 'The table, the filters and search, the bulk actions, the editor with its Generate/Refine buttons, and Backup & Restore.' },
      { where: 'Code Snippets → Status', what: 'Which provider and model the AI would use and whether a key is saved, what the runtime applied in this tab, any snippet that failed, and how snippets are protected.' },
      { where: 'Settings → Integrations → AI', what: 'The one key both AI features use. Snippets themselves need nothing there.' },
    ],
    steps: [
      'Activate the plugin with its key — the first activation creates the code_snippets table.',
      'Open Code Snippets → All Snippets and press Add snippet.',
      'Give it a title, choose the type and the surface, then write or generate the code. Save it switched on, or leave it off until it has been reviewed.',
      'Open the page it targets and confirm the effect; Code Snippets → Status lists what this browser applied and anything that failed.',
      'Optional: save one key under Settings → Integrations → AI to turn on Generate, Refine and the assistant drawer. The Node server (npm start) or the Vercel function has to be running for them.',
      'Export a backup from Backup & Restore once the set is worth keeping, and before an uninstall.',
    ],
    notes: [
      'Sold separately: a key is required before this plugin will activate, and its server routes answer 402 until that key verifies.',
      'Uninstalling drops the code_snippets table and every snippet in it. Export a backup first — the JSON imports into any React-WP site.',
      'Only administrators can write snippets: Row Level Security checks manage_options on every insert, update and delete. Everyone else may read the active rows, which is how the public site loads them before anyone signs in.',
      'Public placements never run on admin screens on purpose: a snippet that throws while an administrator is editing would be hard to switch off again.',
      'The AI needs the plugin’s server routes, so on a static host those two buttons report that no key is reachable. Snippets themselves are stored in Supabase and keep working.',
    ],
  },
  'rwp-plugin-marketplace': {
    icon: '🛍️',
    summary:
      'A WordPress-style plugin marketplace and digital store on your own Supabase: a public storefront, USDT checkout through NOWPayments that mints license keys, developer submissions that are vetted before they are listed, and the owner’s control panel.',
    featureGroups: [
      {
        title: 'The storefront',
        items: [
          'Real-time search, category and sorting filters (popular, newest, rating, price), plugin cards, pagination, and a detail page per plugin with its description and member reviews.',
          '“Your licenses” and “Activate a license” live on the same screen, so a buyer can find the key they were issued and bind it without leaving the store.',
          'The same discovery component renders inline from the shortcode, so the store can be a page in the site chrome or a section of the home page.',
        ],
      },
      {
        title: 'Selling',
        items: [
          'Checkout reads the price from the database, never from the browser, opens a USDT invoice on NOWPayments for a paid plugin, and mints the license from the IPN webhook once the payment is confirmed.',
          'Free plugins skip the gateway entirely: a SQL function re-checks that the price is zero and issues the key immediately.',
          'For the four plugins sold separately the key is the signed RWP2-… entitlement the plugin’s own offline gate verifies; for a third-party plugin it is an opaque RWPM-… token that is bound to one domain and drives one-click updates.',
          'Every transaction is recorded, so revenue, refunds and re-issued keys can be traced to a session id.',
        ],
      },
      {
        title: 'Submissions and vetting',
        items: [
          'Developers submit at /plugins/submit with a .zip or a repository URL, signed in as themselves rather than as an administrator.',
          'server/vet.mjs reads the archive without executing it and looks for outbound network calls, Node internals, dynamic eval/new Function, cookie or localStorage exfiltration, obfuscation markers, server-secret references, a valid manifest.json and the approved React-WP hook API.',
          'A clean package is auto-approved; anything else is rejected, or left pending when a repository could not be read, with the report stored on the row so the decision is auditable.',
        ],
      },
      {
        title: 'The owner’s panel',
        items: [
          'Inventory: every submission, filterable by pending, approved and rejected, with approve/reject and the vetting report.',
          'Sales & analytics: revenue, paid sales, licenses issued, active installs, the pending count, and the recent transaction log.',
          'Featured: pin approved plugins to the top of the storefront.',
        ],
      },
    ],
    admin: [
      { where: 'Marketplace → Inventory', what: 'Every submission with its status, approve/reject, and the audit trail of what the vetting scan found.' },
      { where: 'Marketplace → Sales & analytics', what: 'Revenue, sales, keys issued, active installs and the transaction log.' },
      { where: 'Marketplace → Featured', what: 'Which approved plugins are pinned to the top of the storefront.' },
    ],
    publicRoutes: [
      { where: '/plugins', what: 'The storefront: search, categories, sorting, cards and pagination.' },
      { where: '/plugins/:slug', what: 'One plugin: description, rating and reviews, Pay in USDT, and the license activation form.' },
      { where: '/plugins/submit', what: 'The developer submission form, for a signed-in member.' },
    ],
    shortcodes: [
      {
        usage: '[rwp_marketplace title="Plugin Marketplace" intro="Browse and install plugins." search="" category="" orderby="popular" limit="12"]',
        description: 'The full discovery engine on any page: search bar, category filter, sorting, cards, pagination, Your licenses and Activate a license.',
        attributes: [
          { name: 'title', note: 'The heading. Default “Plugin Marketplace”.' },
          { name: 'intro', note: 'A sentence under the heading.' },
          { name: 'search', note: 'Pre-fills the search box.' },
          { name: 'category', note: 'Starts on one category: commerce, marketing, seo, media, utility, developer or integration.' },
          { name: 'orderby', note: 'popular (default), newest, rating, price or price-desc.' },
          { name: 'limit', note: 'Plugins per page. Default 12.' },
        ],
      },
    ],
    steps: [
      'Activate the plugin: the Plugins screen runs schema.sql, which creates the four tables, their Row Level Security and the functions the store depends on.',
      'Create a public Supabase Storage bucket named rwp-plugin-packages for the uploaded .zip packages.',
      'Set NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET, SUPABASE_SECRET_KEY and PLUGIN_LICENSE_PRIVATE_KEY in the server environment (and SITE_URL if the return URLs must be absolute), then redeploy: the IPN secret is what lets the payment callback be verified.',
      'Each NOWPayments invoice carries its own ipn_callback_url (/api/plugins/rwp-plugin-marketplace/crypto/webhook), which marks the order paid and mints the key — the webhook, not the browser, is what mints a license.',
      'Add [rwp_marketplace] to a page, or add a page at the slug plugins and the storefront at /plugins picks up the site chrome.',
      'Approve or reject submissions in Marketplace → Inventory, feature the ones worth featuring, then watch Marketplace → Sales & analytics.',
    ],
    notes: [
      'Development edition only: this is the storefront for the React-WP ecosystem, not something a customer’s site should ship with, and its owner panel is registered only in this edition.',
      'Nothing is trusted from the browser: prices and statuses are read in SQL, and key minting, auto-approval and domain binding are service_role-only functions.',
      'server/vet.mjs is a static scanner, not a sandbox. It is the first gate; a person still has to review Inventory before something is listed.',
      'Uninstalling drops all four tables, and the transactions and licenses go with them. Packages already uploaded to Supabase Storage under rwp-plugin-packages/ are not deleted — remove that folder yourself.',
      'A third-party key is bound to one domain, so moving a site to a new address means binding the key again. The four sold plugins use the signed RWP2-… entitlement and are activated on Plugins → License instead.',
    ],
  },
  'rwp-saas-installer': {
    icon: '🚀',
    summary:
      'A [react_wp_installer] wizard that builds a new, independent React-WP site on the visitor’s own Vercel and Supabase accounts — plus the update and rollback lifecycle for the site it runs on.',
    featureGroups: [
      {
        title: 'The public wizard',
        items: [
          'Four steps: 1. Vercel, 2. Supabase, 3. Site & Admin, 4. Provision. The visitor pastes their own tokens and keys, and none of them is stored or logged.',
          'Supabase credentials can be tested before anything is created — URL, publishable key, service role key and the database password, or the full PostgreSQL connection string under the advanced toggle.',
          'The wizard is gated on a signed-in user (Sign in at /login), because every site it hands out is recorded against this installation.',
          'The admin email and password for the new site are set in step 3; the password has to be at least eight characters and match its confirmation.',
        ],
      },
      {
        title: 'What provisioning does',
        items: [
          'Four stages are reported one by one: validating the credentials, creating the Vercel project, running the Supabase schema migrations, and the deployment itself.',
          'The project name gets a random suffix so it is globally unique on Vercel, and migrations go over a direct PostgreSQL connection because PostgREST cannot run DDL.',
          'On success the card shows the deployment URL, a Launch Dashboard link, the release tag the first deployment carried, and whether the tracker counted the site.',
          'A deployment that did not answer is reported as a warning with the URL rather than as a success, so a half-built site is not mistaken for a working one.',
        ],
      },
      {
        title: 'The site this is running on',
        items: [
          'The card owns one row: the template repository and branch every new site is copied from, and the Vercel project, team and access token used to deploy this instance.',
          'Check template access proves which credential the next clone would use and shows the head commit, the branch and whether an empty branch would fall back to the repository default.',
          'Installed and Latest badges sit above Update to <version> / Redeploy, a rollback picker for an older release, and the list of releases read from the repository.',
          'The access token is kept in this tab only: it is sent with the deployment, never written to the row and never logged.',
        ],
      },
      {
        title: 'The public updater',
        items: [
          '[react_wp_updater] takes a Vercel token, a project name and an optional team, then deploys the newest stable release to that project.',
          'It never installs a pre-release or an older version, and it refuses a second update of the same project while one is running.',
          'It does not record the update in the installations tracker, so [rwp_active_installs] does not change.',
        ],
      },
      {
        title: 'Counting what it handed out',
        items: [
          'The installations tracker is a count, never a limit: provisioning needs no license key and no key is stored anywhere.',
          'The card says how many recorded sites checked in within a window, and says the number is unknown — not zero — when the tracker could not be read.',
          '[rwp_active_installs] publishes the same rows. It is this plugin’s shortcode, so deactivating the installer takes the count away with the tracker it reads.',
        ],
      },
    ],
    admin: [
      { where: 'Settings → Integrations → RWP SaaS Installer', what: 'The template repository and branch, this instance’s Vercel project, team and token, the template access check, and the update/rollback controls.' },
    ],
    shortcodes: [
      {
        usage: '[react_wp_installer]',
        description: 'The multi-step wizard that provisions a new independent React-WP site on the visitor’s own Vercel and Supabase accounts. It takes no attributes.',
      },
      {
        usage: '[react_wp_updater]',
        description: 'A form where a site owner updates their own React-WP site: they enter a Vercel token, the Vercel project name and optionally a team, and the newest stable release is deployed to that project. Their database, content and plugins are untouched, and the token is used once and never stored.',
        attributes: [
          { name: 'heading', note: 'The card heading. Leave it out for the default.' },
          { name: 'intro', note: 'The sentence under the heading. Leave it out for the default.' },
        ],
      },
      {
        usage: '[rwp_active_installs days="30" list="yes" limit="10"]',
        description: 'How many sites this installation has handed out, from the tracker the plugin creates. [rwp_active_installs days="0"] counts every site ever recorded, and list="yes" prints them as links instead of just the number.',
      },
      {
        usage: '[rwp_latest_release version="yes" title="yes" notes="yes" limit="5"]',
        description: 'The newest release — its title, tag, date and notes — read live from GitHub on the server, with the token Settings → Updates holds, so it is current and it works for a private repository. version="no" hides the tag and its date, title="no" the release’s own name, notes="no" the notes; heading replaces the section heading. channel="beta" also offers pre-releases, and repo="owner/name" asks about another public repository instead. Without a live answer it falls back to the check Dashboard → Updates recorded, then to the repository’s public GitHub releases.',
      },
    ],
    steps: [
      'Activate the plugin: the first activation creates the saas_installer_installations tracker.',
      'Open Settings → Integrations → RWP SaaS Installer, save the template repository (owner/repo or the URL) and, if not the default branch, the branch. Nothing is copied until a visitor runs the wizard.',
      'Press Check template access to prove the GitHub card’s token can read that repository — a private template needs Contents: Read on it.',
      'Add [react_wp_installer] to a page, sign in at /login, and run the wizard once yourself to see the four stages and the result it reports.',
      'For this site’s own updates, fill in the Vercel project (and team), paste an access token, then press Update to <version> or pick an older release to roll back to.',
      'Optional: add [react_wp_updater] to a page (for example /update) so the owners of sites this platform built can move their own project to the newest release. It needs no sign-in: their Vercel token proves they own the project, and a project without React-WP settings is refused.',
      'Optional: publish [rwp_active_installs days="30"] to show the number of sites this installation has built.',
      'Add [rwp_latest_release] to any page to print the release this site publishes — title, tag and notes, read live from GitHub by the plugin’s own public route, so it is current and it works for a private release repository. version="no", title="no" and notes="no" hide one part each, heading replaces the section heading, and limit sets how many note lines print.',
    ],
    notes: [
      'Development edition only: it is the sign-up flow for new React-WP sites, so it never ships inside a customer’s template.',
      'The wizard’s own routes are public on purpose — the wizard is the sign-up flow. The lifecycle routes (template, versions, release, update, rollback) need an administrator token instead.',
      'The version this card reports is the release it deployed, never one it handed to somebody else. A new site starts with its own recorded release.',
      'Uninstalling with a data wipe drops the installations tracker, and the list of sites this installation handed out goes with it. The sites themselves keep running on their own Vercel and Supabase accounts.',
      'An empty template branch means the repository’s default branch, which is what Check template access resolves and reports.',
      'Provisioning runs on the server, so the Node server or the Vercel function has to be up; when a stage fails, its message names the step that stopped.',
    ],
  },
  // entry
};

/** The notes for one plugin, or `null` for a plugin this file does not know. */
export function pluginDocFor(pluginId: string): PluginDoc | null {
  return pluginDocs[pluginId] ?? null;
}
