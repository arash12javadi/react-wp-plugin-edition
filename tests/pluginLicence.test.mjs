/**
 * The licence a marketplace grant mints has to be one the plugin it names will actually accept.
 *
 * Every case here is a round trip: `marketplacePluginKey` is what `POST licenses/grant` signs a key
 * with, and `pluginLicenseState` is the gate a site runs when the key is pasted into Plugins -> License.
 * A change that makes the first answer something the second refuses - a renamed addon, a catalogue slug
 * mapped to the wrong plugin, a verification format drifting from the signing format - fails here
 * rather than in a customer's inbox.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMERCIAL_PLUGIN_ADDONS, MARKETPLACE_PLUGIN_SLUGS, pluginLicenseAddonFor } from '../src/lib/pluginLicense.js';
import {
  marketplaceAddonFor, marketplacePluginKey, pluginLicenseGate, pluginLicenseState,
} from '../server/pluginLicense.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A fixed clock, so `daysLeft` and the expiry verdict do not depend on when the suite runs. */
const NOW = new Date('2027-01-15T12:00:00.000Z');
const EXPIRY = '2027-06-30';

const sold = Object.entries(COMMERCIAL_PLUGIN_ADDONS);

test('every sold plugin is signed for the addon its own gate asks for', () => {
  for (const [pluginId, addon] of sold) {
    assert.equal(marketplaceAddonFor(pluginId), addon, `${pluginId} is listed under its own slug`);
    const { key } = marketplacePluginKey({ slug: pluginId, expiresOn: EXPIRY });
    const state = pluginLicenseState({ pluginId, key, now: NOW });
    assert.equal(state.licensed, true, `${pluginId} accepts a key minted for it (${state.message})`);
    assert.equal(state.addon, addon);
    assert.equal(state.expiresOn, EXPIRY);
  }
});

test('a key minted for one plugin is refused by another', () => {
  const { key } = marketplacePluginKey({ slug: 'rwp-shop', expiresOn: EXPIRY });
  const wrong = pluginLicenseState({ pluginId: 'rwp-page-builder', key, now: NOW });
  assert.equal(wrong.licensed, false);
  assert.equal(wrong.status, 'wrong-plugin');
});

test('the chat listing is signed as CHAT, the addon the chat plugin verifies', () => {
  // The live catalogue lists rwp-chat as `rwp-chat-ai-assistant`. Signing CHAT-AI-ASSISTANT would be a
  // key shaped like a real one that no plugin accepts, so the alias has to land on CHAT.
  assert.equal(MARKETPLACE_PLUGIN_SLUGS['rwp-chat-ai-assistant'], 'rwp-chat');
  assert.equal(marketplaceAddonFor('rwp-chat-ai-assistant'), 'CHAT');
  const { key } = marketplacePluginKey({ slug: 'rwp-chat-ai-assistant', expiresOn: EXPIRY });
  assert.match(key, /^RWP1-CHAT-\d{8}-[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.equal(pluginLicenseState({ pluginId: 'rwp-chat', key, now: NOW }).licensed, true);
});

test('a third-party plugin is issued the marketplace token, never a signed key it cannot verify', () => {
  for (const slug of ['acme-widgets', 'third-party/toolkit', 'rwp-chat-ai-assistant-extra']) {
    assert.equal(marketplaceAddonFor(slug), '', `${slug} is not a sold plugin`);
    assert.deepEqual(marketplacePluginKey({ slug, expiresOn: EXPIRY }), { addon: '', key: '' });
    // Free plugins have no gate of their own: `pluginLicenseGate` answers null, so nothing is locked
    // and the licence is honoured by the marketplace's own verify route instead.
    assert.equal(pluginLicenseGate({ plugin: { id: slug }, licenses: {} }), null);
  }
});

test('a sold plugin stays locked when its key has expired', () => {
  const { key } = marketplacePluginKey({ slug: 'rwp-code-snippets', expiresOn: EXPIRY });
  const later = new Date('2027-07-01T00:00:00.000Z');
  const state = pluginLicenseState({ pluginId: 'rwp-code-snippets', key, now: later });
  assert.equal(state.licensed, false);
  assert.equal(state.status, 'expired');
  // The gate a route consults agrees, so an expired key is not merely a display problem.
  const gate = pluginLicenseGate({ plugin: { id: 'rwp-code-snippets' }, licenses: { 'rwp-code-snippets': key }, now: later });
  assert.equal(gate.licensed, false);
});

test('a key is case-insensitive and survives the trip through a pasted option', () => {
  const { key } = marketplacePluginKey({ slug: 'rwp-shop', expiresOn: EXPIRY });
  const pasted = key.toLowerCase();
  assert.equal(pluginLicenseState({ pluginId: 'rwp-shop', key: pasted, now: NOW }).licensed, true);
  assert.equal(pluginLicenseAddonFor({ id: 'rwp-shop' }), 'SHOP');
});

test('the canonical schema mints its opaque token without pgcrypto', async () => {
  const sql = await readFile(path.join(root, 'plugins/rwp-plugin-marketplace/schema.sql'), 'utf8');
  // pgcrypto is installed in `extensions` on Supabase, which a `set search_path = public` body cannot
  // reach: an unqualified gen_random_bytes() raised 42883 the first time a grant needed a token. The
  // comments may still name it - that is the note explaining why - so only code is checked.
  const code = sql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /gen_random_bytes/);
  const tokens = [...code.matchAll(/v_key\s*:=\s*'RWPM-'\s*\|\|\s*([^;]+);/g)].map((match) => match[1]);
  assert.equal(tokens.length, 4, 'the four places that mint a token all changed together');
  for (const expression of tokens) {
    assert.match(expression, /gen_random_uuid\s*\(\s*\)/, `token generator: ${expression.trim()}`);
  }
});
