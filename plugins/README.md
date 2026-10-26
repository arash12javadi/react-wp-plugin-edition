# React-WP plugins

Put bundled React-WP plugins in this directory. Each plugin should have its own
folder and a `manifest.json` file.

Example:

```text
plugins/
  my-plugin/
    manifest.json
    index.tsx
    server.mjs      (optional)
```

Example manifest:

```json
{
  "id": "vendor-my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Vendor",
  "description": "A React-WP extension.",
  "entry": "./index.tsx"
}
```

Vite automatically discovers plugin `index.tsx` files one level below this
directory at build time. It does not execute arbitrary files discovered at
runtime. A plugin folder becomes available after the next build.

## What a plugin can register

Inside `defineRwpPlugin(manifest, (context) => { ... })`:

| API                                                                       | What it does                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions.add / actions.do`                                                | Hooks such as `rwp_user_logged_in`. Plugins may fire their own, prefixed with the plugin id.                                                                                                                                                                                  |
| `filters.add / filters.apply`                                             | Filters such as `rwp_site_title` and `rwp_public_menu`.                                                                                                                                                                                                                       |
| `admin.registerPage({ id, label, icon, capability, submenu, component })` | An admin screen. `capability` hides it from, and blocks it for, roles without that capability. `submenu: [{ id, label, icon, capability }]` shows under the page in the sidebar while it is open; the component receives `{ subsection, navigate }`. Use an emoji for `icon`. |
| `admin.registerDashboardWidget({ id, title, capability, component })`     | A panel on Dashboard → Overview.                                                                                                                                                                                                                                              |
| `admin.registerSetupCheck({ id, capability, run })`                       | `run()` resolves to the setup notices that still apply (`{ id, level: 'required' \| 'recommended' \| 'optional', title, description, steps, action }`), shown in Dashboard → Overview's checklist. Keep ids stable: hidden notices are remembered by id.                      |
| `integrations.registerCard({ id, title, icon, description, capability, order, describe, renderComponent })` | A card on Settings → Integrations, the one screen for third-party services, next to GitHub (order 10), AI (20), Media & storage (30) and Email (40). `renderComponent` receives `{ status, refresh }`: render your own form, read and write your own `system_settings` row, and call `refresh()` after a save. `describe()` (optional) returns `{ configured, label }` for the state pill. `useIntegrationsRegistry()` is the same registry from inside a component. |
| `shortcodes.register({ name, render, description, example, attributes })` | `[name attr="value"]` in page content. The optional fields document it in Dashboard → Guide.                                                                                                                                                                                  |
| `routes.register({ path, component, chrome })`                            | A public URL. `:param` segments and a trailing `*` are captured into `params`. Plugin routes win over page slugs. `chrome: false` renders without the site header and footer.                                                                                                 |
| `header.register({ id, component })`                                      | Something in the public header next to the login links, such as a cart link.                                                                                                                                                                                                  |
| `content.registerRenderer({ id, match, component, editHref })`            | Takes over the body of pages where `match(page)` is true. The component gets `{ page, comments }`; `editHref` redirects the toolbar's "Edit page" link. The page builder uses this.                                                                                           |
| `content.registerAction({ id, label, href, show })`                       | A link on each row of Pages & Posts and at the top of the content editor, e.g. "Edit with Builder".                                                                                                                                                                           |

Components rendered inside a route can read site settings and the signed-in user with
`usePublicChrome()` from `src/components/PublicChrome.tsx`.

Return a cleanup function that removes every registration, so deactivating the plugin
removes it completely.

## Reading and writing data

Plugins use core's one database helper, `src/lib/db.ts`, imported by relative path — from
`plugins/<id>/index.tsx` that is `../../src/lib/db`, from `plugins/<id>/lib/thing.ts` it is
`../../../src/lib/db`:

| API                          | What it does                                                                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`                     | The universal, Supabase-shaped client: `client.from('pages').select('id,title').eq('status', 'published').maybeSingle()`, `client.rpc('my_fn', { … })`, `client.auth.getUser()`. It works on every backend (Supabase, Postgres, MySQL, SQLite), so never import `@supabase/supabase-js` yourself. |
| `tryGetClient()`             | The same client, or `null` when the CMS is not configured yet — use this in code that can run while the Setup Wizard is up.                                                                                                    |
| `db`                         | `$wpdb`-style helpers: `db.from(table)`, `db.select(table, where)`, `db.insert`, `db.update`, `db.delete`.                                                                                                                     |
| `getOption` / `updateOption` | WordPress-style options.                                                                                                                                                                                                      |
| `getSystemSetting` / `setSystemSetting` | Administrator-only key/value settings (`system_settings`) — integration keys and other secrets.                                                                                                                     |
| `describeDbError(error)`     | Turns a driver error into a message. Errors here are plain objects, not `Error` instances, so `instanceof` misses them.                                                                                                       |

Older plugins call `getSupabaseClient()` / `tryGetSupabaseClient()`; both are still exported as
aliases for `client` / `tryGetClient`. **Never remove or rename an export a plugin imports.** A
plugin that imports a missing name throws `does not provide an export named …` while its module is
being evaluated — before React mounts — which blanks the entire site (public and admin) rather than
breaking one screen, and `vite build` stops with `MISSING_EXPORT` in production. `plugins/` is not
tracked in git, so run `npm run build` after changing any export a plugin imports.

## Server routes

A plugin that needs secrets or must talk to a third party (payments, email) can ship a
`server.mjs` that default-exports `{ id, routes }`:

```js
export default {
  id: "vendor-my-plugin",
  routes: {
    "POST hello/:name": async (ctx) => ({
      status: 200,
      body: { hello: ctx.params.name, you: ctx.json() },
    }),
  },
};
```

It is served at `/api/plugins/<id>/<route>` by `server.mjs` (self-hosted) and by
`api/plugins.ts` on Vercel. The context has `json()`, `rawBody` (a Buffer, for webhook
signatures), `headers`, `query`, `params`, `bearerToken` (the caller's Supabase access
token), `origin`, and `supabase: { url, publishableKey, secretKey }`.

**A server module may only read the integration rows it is granted.** `ctx.supabase.secretKey` can
reach every row in `system_settings`, including the credentials saved on the other Integrations
cards, so the rows a plugin is allowed to read are declared once per plugin id in
`server/pluginIntegrationAccess.mjs` (`PLUGIN_INTEGRATION_KEYS`) and read with
`readPluginIntegrationRows(id, keys, options)` instead of `readIntegrationRows`. A key outside the
grant is refused, not read: the call answers `readable: false` with a sentence naming the plugin and
the row, and logs `[PLUGIN_INTEGRATION_REFUSED]`. Add your plugin's id and row keys to that map in
the same change that adds the card writing them — that pair is the review. A plugin that only uses
its own tables does not need an entry.

**Server modules are registered by hand in `server/plugins.mjs`.** Vercel bundles a
function by tracing its imports, so a module found with `readdir` at runtime (and the npm
packages it imports) would be missing from the deployment. Routes of a plugin that is not
active under Plugins return 404.

## Licensing a plugin

Every plugin is free unless it is one of the four sold ones, listed in `COMMERCIAL_PLUGIN_ADDONS` in
`src/lib/pluginLicense.js`:

| Plugin id           | Key addon       |
| ------------------- | --------------- |
| `rwp-page-builder`  | `PAGE-BUILDER`  |
| `rwp-shop`          | `SHOP`          |
| `rwp-chat`          | `CHAT`          |
| `rwp-code-snippets` | `CODE-SNIPPETS` |

Each of those answers `402` on every one of its own **server routes** until the key stored for it
verifies; nothing else on the site is affected. Every other plugin is free for good: the requirement is
never read from the plugin itself, so a `server.mjs` cannot opt itself in and a manifest that arrived
inside an uploaded ZIP cannot opt itself out. Adding an id to that map is the only way to sell a
plugin, and `npm run check:plugins` fails if the map, the folders and the manifests disagree — a sold
plugin with no `server.mjs` to gate, a sold plugin whose addon does not match its id, or a free plugin
still carrying an old `license` declaration.

`GET <plugin-id>/license` is answered for every plugin — free ones answer `required: false` — before
the activation and license checks, so a locked or inactive plugin's row can still say why. A plugin's
own `GET license` route wins over the host's.

Keys read `RWP1-ADDON-YYYYMMDD-SIGNATURE`, are case-insensitive, and are signed with HMAC-SHA256 over
`RWP1|ADDON|YYYYMMDD` (`server/pluginLicense.mjs`, mirrored for the browser in
`src/lib/pluginLicense.js`), so a key cannot be re-scoped to another addon or moved between plugins.
Mint and verify one from a shell:

```bash
node server/pluginLicense.mjs mint --plugin rwp-shop --days 365
node server/pluginLicense.mjs verify RWP1-SHOP-20270630-0VX7JSKV7Z
```

The default signing secret ships with the site on purpose — the check has to work offline, with no
license server and no phone home — which makes a key an entitlement record rather than a cryptographic
paywall. `PLUGIN_LICENSE_SECRET` replaces it for an installation whose keys only it should be able to
mint; `mint` prints which secret signed the key and warns when the key is already expired.

Keys are entered under **Plugins**, one per plugin, and stored together in the `rwp_plugin_licenses`
option as `{ "<plugin-id>": "<key>" }`. A saved key is in force for the next request — no restart.
When the option cannot be read at all the state is *unknown*, and an unknown state lets the request
through and logs: a database hiccup must never take a working shop down.

A sold plugin without a verifying key is **inactive** as well as refused: the Plugins screen shows it
**Inactive** with **Activate** disabled, `App.tsx` does not run it, and `server/plugins.mjs` drops it
from the active set (`licensedActivePluginIds`) even when `rwp_active_plugins` lists it. Opening the
screen with such a row writes that verdict back, so the stored state matches what runs.

## Development-edition plugins

`rwp-ai-factory` and `rwp-saas-installer` never ship to a customer: they are the central
administration's own tools, listed in `DEV_EDITION_PLUGINS` (`src/lib/pluginEdition.js`) and marked
`"edition": "dev"` in their manifest.

- `.gitattributes` marks both folders `export-ignore`, so `git archive`, GitHub's "Download ZIP", a
  template export and `npm pack` leave them out. A clone of this repository — the development
  edition — still has them.
- `RWP_EDITION=public` drops them: the server answers `404` for their routes (`server/plugins.mjs`) and
  a build made with the same variable refuses to register them (`registerPlugin` in `src/lib/rwp.tsx`),
  so they cannot appear under Plugins or add an admin screen either.
- `npm run check:plugins` fails if the list, the two manifests or the two `export-ignore` lines drift
  apart, and prints the license and edition of every plugin folder.

Adding a plugin to this edition is a three-file change: its id in `DEV_EDITION_PLUGINS`,
`"edition": "dev"` in its `manifest.json`, and `plugins/<id> export-ignore` in `.gitattributes`.

The `sample-rwp-plugin` folder is a working example. It registers an admin
page, a dashboard widget, and a site-title filter. It is discovered by the
Vite plugin glob in `src/main.jsx`.

During development, run `npm run dev` and use `http://localhost:5173`. Plugin
modules include HMR cleanup so edits replace the previous plugin instance and
remove old styles, hooks, pages, and widgets. Port 3000 serves the production
build and only changes after `npm run build` and a server restart.

## Shop plugin

`rwp-shop` is a full store. See the "Shop" section of the root README for setup.

## Page builder plugin

`rwp-page-builder` is a visual page builder. See the "Page builder" section of the root README.

## Code snippets plugin

`rwp-code-snippets` adds the Code Snippets screen: CSS, JavaScript, HTML and React hook
snippets stored in `public.code_snippets`, an AI-backed code generator and assistant,
and JSON backup/restore. See the "Code snippets and the AI developer assistant" section of
the root README. The plugin installs its own `plugins/rwp-code-snippets/schema.sql` (`public.code_snippets`) when it is activated.

The runtime that applies snippets lives in core, at `src/core/SnippetInjector.tsx`, because
core must not import plugin code. The plugin starts it on activation and returns its cleanup,
so deactivating the plugin removes every style, script and hook the snippets added. Anything
else that wants the same behaviour can call `startSnippetRuntime()` or mount `<SnippetInjector />`.

## SaaS installer plugin

`rwp-saas-installer` is the `[react_wp_installer]` wizard: a visitor signs in, names a site, and the
plugin's `server.mjs` proves the Vercel and Supabase credentials it was handed, creates the project and
its schema, then deploys the template repository the installer card saves. It also carries the release
lifecycle (`GET versions`, `POST update`, `POST rollback`) for sites that already exist.

**Provisioning is free.** The wizard needs no license key and stores none: it proves the Vercel and
Supabase credentials it was handed, creates the project, and reports how many installations this site
has handed out through `GET installs/status` (`{ usage: { total, active, days }, message }`), which is
public and counts only. Commercial licensing is a separate, per-plugin question — see
[Licensing a plugin](#licensing-a-plugin).

**Installations are counted in `public.saas_installer_installations`**, created by
`plugins/rwp-saas-installer/schema.sql` when the plugin is activated (`uninstall.sql` drops it, and
only it). `POST provision` records the site it hands out, `POST installs/register` one provisioned
before the tracker existed, and a provisioned site refreshes its own row with `POST installs/heartbeat`
— the only public write in the file, and a patch to a row that must already exist, so an address nobody
registered is a no-op rather than a new row. The rows are written server-side only; the table is
readable so `[rwp_active_installs]` can render them:

```
[rwp_active_installs]                                  how many sites checked in within 30 days
[rwp_active_installs days="0"]                          every site ever recorded
[rwp_active_installs days="7" list="yes" limit="10"]    the ten most recent, as links
```

`title` and `empty` replace the heading and the sentence shown when nothing is recorded, and a missing
table renders that same muted line instead of an error — the plugin is simply not fully installed yet.