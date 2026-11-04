/**
 * How the platform finds the Vercel project behind a site that asks to be updated.
 *
 * A site reports the host it was asked on (a custom domain, a `www.` form), while the wizard recorded
 * `https://<project>.vercel.app`. An exact match answered "no project recorded" (HTTP 404) for every site with
 * a domain; these tests pin the lookup that replaced it, with PostgREST replaced by a stub.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveSiteProject, siteAddressVariants } from '../plugins/rwp-saas-installer/server.mjs';

const ctx = { supabase: { url: 'https://db.example.supabase.co', secretKey: 'service-key' } };

/** Runs `body` with `fetch` answering the tracker with `rows`, and returns the URLs it was asked. */
async function withTracker(rows, body) {
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    return { result: await body(), asked };
  } finally {
    globalThis.fetch = original;
  }
}

test('an address is looked up with and without www.', () => {
  assert.deepEqual(siteAddressVariants('https://www.shop.com'), ['https://www.shop.com', 'https://shop.com']);
  assert.deepEqual(siteAddressVariants('https://shop.com'), ['https://shop.com', 'https://www.shop.com']);
  assert.deepEqual(siteAddressVariants('not an address'), []);
});

test('a tracker row for the www twin finds the project', async () => {
  const { result, asked } = await withTracker([{ site_url: 'https://shop.com', project_name: 'shop-project' }], () =>
    resolveSiteProject(ctx, 'https://www.shop.com'));
  assert.deepEqual(result, { project: 'shop-project', matched: 'row' });
  assert.match(decodeURIComponent(asked[0]), /site_url=in\.\("https:\/\/www\.shop\.com","https:\/\/shop\.com"\)/);
});

test('a *.vercel.app host with no row falls back to the project it names', async () => {
  const { result } = await withTracker([], () => resolveSiteProject(ctx, 'https://my-shop.vercel.app'));
  assert.deepEqual(result, { project: 'my-shop', matched: 'host' });
});

test('a custom domain with no row finds nothing, so the caller can say so', async () => {
  const { result } = await withTracker([], () => resolveSiteProject(ctx, 'https://shop.com'));
  assert.deepEqual(result, { project: '', matched: '' });
});
