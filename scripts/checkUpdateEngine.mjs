/**
 * `npm run check:updates` — the update engine's rules, checked without a network.
 *
 * The rules, because each one has a silent failure mode:
 *
 *   1. **A version is a GitHub release tag.** `v2.4.1` parses, `nightly` does not, and `2.10.0` sorts
 *      above `2.9.9` — not lexicographically, which is what would offer a downgrade.
 *   2. **The platform answers, the site asks.** A deployment with no repository or no token list serves
 *      no route at all, so a customer's `/api/admin/updates/check` keeps belonging to its own dashboard;
 *      an unauthenticated caller gets 401 and never a release list.
 *   3. **One payload, two shapes.** The fields the contract promises (`installedVersion`, `latestVersion`,
 *      `updateAvailable`, `releaseNotes`, `releaseUrl`) and the release list this project's own screens
 *      read describe the same release, and the client accepts either.
 *   4. **A badge that clears.** An install older than the tag offers an update; the same version does not,
 *      and neither does a newer one — the sidebar badge is written from this answer.
 *
 * Offline and read-only: every `fetch` in here is a stub, so this runs on a machine with no GitHub token
 * and no release published, and it fails with a sentence rather than a stack trace.
 */
import assert from 'node:assert/strict';
import {
  fetchGithubReleases,
  latestReleaseFrom,
  notesFromGithubBody,
  releaseFromGithub,
  releasesFromGithub,
  repoFrom,
  tagVersionFrom,
} from '../server/githubReleases.mjs';
import {
  clearCentralReleaseCache,
  centralConfigFrom,
  handleCentralUpdateRequest,
} from '../server/centralUpdates.mjs';
import {
  centralReleasesFrom,
  checkAnswerFrom,
  checkForUpdates,
  fetchCentralCheck,
  publicRelease,
  releaseFrom,
} from '../server/updateCenter.mjs';

const suites = [];
const test = (name, run) => suites.push([name, run]);

/** A `fetch` stub that answers every call with the same JSON body, counting the calls it served. */
const stubFetch = (body, { status = 200, headers = {} } = {}) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  impl.calls = calls;
  return impl;
};

/** GitHub's own release row, with the fields this feature reads. */
const githubRow = (tag, { body = '', prerelease = false, draft = false, published = '2026-01-01T00:00:00Z' } = {}) => ({
  tag_name: tag,
  name: `Release ${tag}`,
  body,
  draft,
  prerelease,
  published_at: published,
  html_url: `https://github.com/acme/react-wp/releases/tag/${tag}`,
  target_commitish: 'main',
  zipball_url: `https://api.github.com/repos/acme/react-wp/zipball/${tag}`,
  assets: [{ name: `react-wp-${tag}.zip`, browser_download_url: `https://github.com/acme/react-wp/releases/download/${tag}/react-wp.zip` }],
});

/* -- 1. Tags ---------------------------------------------------------------------------------------- */

test('a tag is the version, and a tag that is not a version is refused', () => {
  assert.equal(tagVersionFrom('v2.4.1'), '2.4.1');
  assert.equal(tagVersionFrom('2.4.1'), '2.4.1');
  assert.equal(tagVersionFrom('V2.4.1-rc.1'), '2.4.1-rc.1');
  assert.equal(tagVersionFrom('nightly'), '');
  assert.equal(tagVersionFrom('release-notes'), '');
  assert.equal(tagVersionFrom(''), '');
});

test('owner/name comes from a name, a clone URL or a browser URL, and nothing else', () => {
  assert.deepEqual(repoFrom('acme/react-wp'), { owner: 'acme', repo: 'react-wp' });
  assert.deepEqual(repoFrom('https://github.com/acme/react-wp'), { owner: 'acme', repo: 'react-wp' });
  assert.deepEqual(repoFrom('https://github.com/acme/react-wp.git'), { owner: 'acme', repo: 'react-wp' });
  assert.deepEqual(repoFrom('acme/react-wp/'), { owner: 'acme', repo: 'react-wp' });
  assert.equal(repoFrom('https://evil.test/acme/react-wp'), null);
  assert.equal(repoFrom('acme'), null);
  assert.equal(repoFrom(''), null);
});

/* -- 2. Release rows -------------------------------------------------------------------------------- */

test('a release body becomes the lines the screen shows', () => {
  const notes = notesFromGithubBody('## Move update checks to the server\r\n- **Add** marketplace `licensing`\r\n* [Docs](https://x.test/docs)\r\n\r\n');
  assert.deepEqual(notes, ['Move update checks to the server', 'Add marketplace licensing', 'Docs (https://x.test/docs)']);
});

test('a GitHub release keeps its tag, its notes and its page; the asset never reaches the browser', () => {
  const release = releaseFromGithub(githubRow('v2.4.1', { body: '- Move update checks to the server' }));
  assert.equal(release.version, '2.4.1');
  assert.equal(release.tag, 'v2.4.1');
  assert.deepEqual(release.notes, ['Move update checks to the server']);
  assert.equal(release.changelog_url, 'https://github.com/acme/react-wp/releases/tag/v2.4.1');
  assert.match(release.download_url, /react-wp\.zip$/);
  assert.equal(publicRelease(release).download_url, undefined);
  assert.equal(publicRelease(release).tag, 'v2.4.1');
});

test('rows that are not releases are dropped, one at a time', () => {
  const releases = releasesFromGithub([githubRow('v2.4.1'), githubRow('nightly'), githubRow('v2.3.2')]);
  assert.deepEqual(releases.map((release) => release.version), ['2.4.1', '2.3.2']);
  assert.deepEqual(releasesFromGithub('not a list'), []);
});

/* -- 3. Channel selection ---------------------------------------------------------------------------- */

test('the newest tag wins by version order, not by the order GitHub lists releases in', () => {
  const releases = releasesFromGithub([
    githubRow('v2.3.2', { published: '2026-02-01T00:00:00Z' }),
    githubRow('v2.10.0', { published: '2026-03-01T00:00:00Z' }),
    githubRow('v2.9.9', { published: '2026-04-01T00:00:00Z' }),
  ]);
  assert.equal(latestReleaseFrom(releases).version, '2.10.0');
});

test('stable never offers a pre-release or a draft; beta offers the pre-release', () => {
  const releases = releasesFromGithub([
    githubRow('v2.4.1'),
    githubRow('v2.5.0-rc.1', { prerelease: true }),
    githubRow('v3.0.0', { draft: true }),
  ]);
  assert.equal(latestReleaseFrom(releases, { channel: 'stable' }).version, '2.4.1');
  assert.equal(latestReleaseFrom(releases, { channel: 'beta' }).version, '2.5.0-rc.1');
  assert.equal(latestReleaseFrom([], { channel: 'beta' }), null);
});

/* -- 4. The GitHub request -------------------------------------------------------------------------- */

test('a public repository is read with no credential, a private one with a bearer token', async () => {
  const anonymous = stubFetch([githubRow('v2.4.1')]);
  await fetchGithubReleases({ repo: 'acme/react-wp', fetchImpl: anonymous });
  assert.equal(anonymous.calls[0].url, 'https://api.github.com/repos/acme/react-wp/releases?per_page=30');
  assert.equal(anonymous.calls[0].init.headers.Authorization, undefined);

  const authorized = stubFetch([githubRow('v2.4.1')]);
  await fetchGithubReleases({ repo: 'acme/react-wp', token: 'ghp_secret', fetchImpl: authorized });
  assert.equal(authorized.calls[0].init.headers.Authorization, 'Bearer ghp_secret');
});

test('a 404 explains the private-repository case instead of blaming the request', async () => {
  await assert.rejects(
    fetchGithubReleases({ repo: 'acme/react-wp', fetchImpl: stubFetch({ message: 'Not Found' }, { status: 404 }) }),
    /RWP_RELEASE_TOKEN/,
  );
});

/* -- 5. Who may ask --------------------------------------------------------------------------------- */

const platformEnv = { RWP_RELEASE_REPO: 'acme/react-wp', RWP_CENTRAL_TOKENS: 'site-token' };

test('a deployment is the platform only when it has a repository and a token to accept', () => {
  assert.equal(centralConfigFrom({}).enabled, false);
  assert.equal(centralConfigFrom({ RWP_RELEASE_REPO: 'acme/react-wp' }).enabled, false);
  assert.equal(centralConfigFrom({ RWP_CENTRAL_TOKENS: 't1' }).enabled, false);
  const config = centralConfigFrom(platformEnv);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.tokens, ['site-token']);
  assert.equal(config.channel, 'stable');
  assert.equal(config.cacheSeconds, 60);
  assert.equal(centralConfigFrom({ RWP_RELEASE_CHANNEL: 'beta' }).channel, 'beta');
});

test('a customer site answers nothing at the platform paths, so its own routes stay its own', async () => {
  assert.equal(await handleCentralUpdateRequest({ pathname: '/api/v1/updates/check', method: 'POST', env: {} }), null);
  assert.equal(await handleCentralUpdateRequest({ pathname: '/api/admin/updates/check', method: 'POST', env: {} }), null);
  assert.equal(await handleCentralUpdateRequest({ pathname: '/api/admin/updates', method: 'GET', env: platformEnv }), null);
});

test('the platform refuses an anonymous or wrong token before it reads a release', async () => {
  clearCentralReleaseCache();
  const fetchImpl = stubFetch([githubRow('v2.4.1')]);
  const anonymous = await handleCentralUpdateRequest({ pathname: '/api/v1/updates/check', method: 'POST', headers: {}, env: platformEnv, fetchImpl });
  assert.equal(anonymous.status, 401);
  const wrong = await handleCentralUpdateRequest({ pathname: '/api/v1/updates/check', method: 'POST', headers: { authorization: 'Bearer nope' }, env: platformEnv, fetchImpl });
  assert.equal(wrong.status, 403);
  const read = await handleCentralUpdateRequest({ pathname: '/api/v1/updates/check', method: 'GET', headers: { authorization: 'Bearer site-token' }, env: platformEnv, fetchImpl });
  assert.equal(read.status, 405);
  assert.equal(fetchImpl.calls.length, 0, 'no GitHub call happens for a caller that may not ask');
});

test('the platform answers the contract the customer reads', async () => {
  clearCentralReleaseCache();
  const fetchImpl = stubFetch([
    githubRow('v2.4.1', { body: '- Move update checks to the server\n- Add marketplace licensing', published: '2026-03-01T00:00:00Z' }),
    githubRow('v2.3.2'),
  ]);
  const ask = () => handleCentralUpdateRequest({
    pathname: '/api/v1/updates/check',
    method: 'POST',
    headers: { authorization: 'Bearer site-token' },
    body: { installedVersion: 'v1.3.1', channel: 'stable' },
    env: platformEnv,
    fetchImpl,
  });
  const answer = await ask();
  assert.equal(answer.status, 200);
  assert.equal(answer.body.installedVersion, 'v1.3.1');
  assert.equal(answer.body.latestVersion, 'v2.4.1');
  assert.equal(answer.body.updateAvailable, true);
  // `releaseNotes` is the notes as lines, with the Markdown bullets already stripped: both screens that
  // render it draw a list, and a second bullet would be drawn twice.
  assert.equal(answer.body.releaseNotes, 'Move update checks to the server\nAdd marketplace licensing');
  assert.equal(answer.body.releaseUrl, 'https://github.com/acme/react-wp/releases/tag/v2.4.1');
  assert.equal(answer.body.app.latest, '2.4.1');
  assert.equal(answer.body.app.latest_tag, 'v2.4.1');
  assert.equal(answer.body.stale, false);
  assert.deepEqual(answer.body.updates.map((entry) => entry.id), ['react-wp']);
  // The same answer serves the next check from the cache, not from a second GitHub call.
  assert.equal((await ask()).status, 200);
  assert.equal(fetchImpl.calls.length, 1);
});

test('a GitHub failure serves the last good answer instead of blanking the screen', async () => {
  clearCentralReleaseCache();
  const ask = (fetchImpl, now) => handleCentralUpdateRequest({
    pathname: '/api/admin/updates/check',
    method: 'POST',
    headers: { authorization: 'Bearer site-token' },
    body: { installedVersion: 'v1.3.1' },
    env: platformEnv,
    fetchImpl,
    now,
  });
  const first = await ask(stubFetch([githubRow('v2.4.1')]), 1_000);
  assert.equal(first.status, 200);
  const second = await ask(stubFetch({ message: 'boom' }, { status: 500 }), 1_000 + 120_000);
  assert.equal(second.status, 200);
  assert.equal(second.body.stale, true);
  assert.equal(second.body.latestVersion, 'v2.4.1');
  assert.match(second.body.error, /could not be refreshed/);
});

test('a GitHub failure never hands the platform\'s configuration to the caller', async () => {
  clearCentralReleaseCache();
  const quiet = console.error;
  console.error = () => {};
  try {
    const answer = await handleCentralUpdateRequest({
      pathname: '/api/v1/updates/check',
      method: 'POST',
      headers: { authorization: 'Bearer site-token' },
      body: { installedVersion: 'v1.3.1' },
      env: platformEnv,
      fetchImpl: stubFetch({ message: 'Not Found' }, { status: 404 }),
    });
    assert.equal(answer.status, 502, 'a 404 from GitHub is not a 404 for the caller');
    assert.doesNotMatch(answer.body.error, /RWP_|token|acme/i);
    assert.match(answer.body.error, /could not read the release list/);
  } finally {
    console.error = quiet;
  }
});

/* -- 6. The customer side --------------------------------------------------------------------------- */

test('both payload shapes read as the same release', () => {
  const legacy = centralReleasesFrom({
    format: 'rwp-update-center',
    version: 1,
    app: { version: '2.4.1', notes: ['a note'], changelog_url: 'https://x.test/rel' },
  });
  assert.equal(legacy.app.version, '2.4.1');
  assert.equal(legacy.app.tag, 'v2.4.1');

  const contract = centralReleasesFrom({ installedVersion: 'v1.3.1', latestVersion: 'v2.4.1', updateAvailable: true, releaseNotes: 'a\nb', releaseUrl: 'https://x.test/rel' });
  assert.equal(contract.app.version, '2.4.1');
  assert.equal(contract.app.tag, 'v2.4.1');
  assert.deepEqual(contract.app.notes, ['a', 'b']);
  assert.equal(contract.app.changelog_url, 'https://x.test/rel');

  assert.throws(() => centralReleasesFrom({}), /no release with a version/);
});

test('a site asks the documented path first, and the admin path when that answers 404', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body || '{}')) });
    if (String(url).endsWith('/api/v1/updates/check')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({
      latestVersion: 'v2.4.1',
      updateAvailable: true,
      releaseNotes: '- x',
      releaseUrl: 'https://x.test/rel',
    }), { status: 200 });
  };
  const { app } = await fetchCentralCheck({
    config: { central_url: 'https://react-wp.com', token: 'site-token', channel: 'stable' },
    current: { app: '1.3.1' },
    plugins: [],
    fetchImpl,
  });
  assert.deepEqual(calls.map((call) => call.url), [
    'https://react-wp.com/api/v1/updates/check',
    'https://react-wp.com/api/admin/updates/check',
  ]);
  assert.equal(calls[0].body.installedVersion, '1.3.1', 'the contract spelling is sent alongside the release list');
  assert.equal(app.version, '2.4.1');
  assert.equal(app.tag, 'v2.4.1');
  assert.deepEqual(app.notes, ['- x']);
});

test('when central cannot be asked, the release tags answer and the answer says which failed', async () => {
  const fetchImpl = async (url) => (String(url).includes('updates/check')
    ? new Response(JSON.stringify({ error: 'down' }), { status: 503 })
    : new Response(JSON.stringify([githubRow('v2.4.1')]), { status: 200 }));
  const answer = await checkForUpdates({
    config: { central_url: 'https://react-wp.com', token: 'site-token', channel: 'stable' },
    current: { app: '1.3.1' },
    plugins: [],
    github: { repo: 'acme/react-wp' },
    fetchImpl,
  });
  assert.equal(answer.source, 'github');
  assert.equal(answer.app.latest, '2.4.1');
  assert.equal(answer.latestVersion, 'v2.4.1');
  assert.match(answer.error, /HTTP 503/, 'the central failure is kept beside the answer that replaced it');
  assert.equal(answer.updateAvailable, true);
});

test('with no token and no repository, the sentence names both places to configure', async () => {
  // The script runs offline, but a shell that exports these would answer for the test rather than the code.
  const saved = { repo: process.env.RWP_RELEASE_REPO, token: process.env.RWP_RELEASE_TOKEN };
  delete process.env.RWP_RELEASE_REPO;
  delete process.env.RWP_RELEASE_TOKEN;
  try {
    await assert.rejects(
      checkForUpdates({
        config: { channel: 'stable' },
        current: { app: '1.3.1' },
        plugins: [],
        fetchImpl: async () => new Response('{}', { status: 200 }),
      }),
      /Integrations → GitHub/,
    );
  } finally {
    if (saved.repo !== undefined) process.env.RWP_RELEASE_REPO = saved.repo;
    if (saved.token !== undefined) process.env.RWP_RELEASE_TOKEN = saved.token;
  }
});

/* -- 7. The answer the screen reads ----------------------------------------------------------------- */

test('the badge follows the tag: older offers, equal and newer do not', () => {
  const release = releaseFrom({ version: '2.4.1', tag: 'v2.4.1', notes: 'note' });
  const older = checkAnswerFrom({ source: 'central', app: release, plugins: {}, current: { app: '1.3.1' }, plugins_installed: [] });
  assert.equal(older.updateAvailable, true);
  assert.equal(older.latestVersion, 'v2.4.1');
  assert.equal(older.installedVersion, 'v1.3.1');
  assert.equal(older.releaseNotes, 'note');
  assert.equal(older.releaseUrl, '');
  assert.equal(older.app.release.tag, 'v2.4.1');

  const same = checkAnswerFrom({ source: 'central', app: release, plugins: {}, current: { app: '2.4.1' }, plugins_installed: [] });
  assert.equal(same.updateAvailable, false);
  assert.deepEqual(same.updates, [], 'an up-to-date site offers nothing, which is what clears the badge');

  const newer = checkAnswerFrom({ source: 'central', app: release, plugins: {}, current: { app: '2.5.0' }, plugins_installed: [] });
  assert.equal(newer.updateAvailable, false);
});

test('a tag is kept even when a source hands over only a version', () => {
  assert.equal(releaseFrom({ version: '2.4.1' }).tag, 'v2.4.1');
  assert.equal(releaseFrom({ tag: 'v2.4.1', notes: ['a'] }).version, '2.4.1');
  assert.equal(releaseFrom({ version: 'nightly' }), null);
});

/* -- Runner ----------------------------------------------------------------------------------------- */

let failed = 0;
for (const [name, run] of suites) {
  try {
    await run();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log('');
console.log(`update engine: ${suites.length - failed}/${suites.length} rules hold`);
process.exitCode = failed ? 1 : 0;
