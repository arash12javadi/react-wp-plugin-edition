/**
 * `npm run check:updates` — the update engine's rules, checked without a network.
 *
 * The rules, because each one has a silent failure mode:
 *
 *   1. **A version is a GitHub release tag.** `v2.4.1` parses, `nightly` does not, and `2.10.0` sorts
 *      above `2.9.9` — not lexicographically, which is what would offer a downgrade.
 *   2. **The platform answers, the site asks.** A deployment with neither a repository nor a token list
 *      serves no route at all, so a customer's `/api/admin/updates/check` keeps belonging to its own
 *      dashboard. A *check* is public — a site that was never given a token still reads a version — while
 *      the release *package* always costs one, and a half-configured platform names the missing variable
 *      instead of answering 404.
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
  releaseFromTag,
  releasesFromGithub,
  releasesFromTags,
  repoFrom,
  tagVersionFrom,
} from '../server/githubReleases.mjs';
import {
  clearCentralReleaseCache,
  clearStoredReleaseSource,
  centralConfigFrom,
  centralPlatformConfig,
  handleCentralUpdateRequest,
} from '../server/centralUpdates.mjs';
import {
  MANAGED_MESSAGES,
  centralReleasesFrom,
  checkAnswerFrom,
  checkForUpdates,
  fetchCentralCheck,
  githubUpdateSourceFrom,
  managedUpdateSupport,
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

/** GitHub's tag row (`GET /repos/{owner}/{repo}/tags`): a name and the commit it points at, nothing else. */
const tagRow = (tag) => ({
  name: tag,
  commit: { sha: `sha-${tag}`, url: `https://api.github.com/repos/acme/react-wp/commits/sha-${tag}` },
  zipball_url: `https://api.github.com/repos/acme/react-wp/zipball/refs/tags/${tag}`,
});

/**
 * A `fetch` stub for a check that asks more than one endpoint: the first route whose path is part of the
 * URL answers, so the release list and the tag list can differ.
 */
const stubRoutes = (routes) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const match = routes.find(([path]) => String(url).includes(path));
    const [body, status = 200] = match ? match.slice(1) : [];
    return new Response(JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
};

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

test('a bare tag is a release too, with only what a tag knows', () => {
  const release = releaseFromTag(tagRow('v2.4.2'), 'acme/react-wp');
  assert.equal(release.version, '2.4.2');
  assert.equal(release.tag, 'v2.4.2');
  assert.equal(release.commit, 'sha-v2.4.2');
  assert.equal(release.draft, false, 'a tag has no draft state, and is never withheld');
  assert.equal(release.prerelease, false);
  assert.deepEqual(release.notes, [], 'a tag carries no body, so the screen shows no notes');
  assert.equal(release.download_url, '', 'a tag has no asset, and the archive URL is not guessed at');
  assert.equal(release.released, '');
  assert.equal(release.changelog_url, 'https://github.com/acme/react-wp/releases/tag/v2.4.2');

  // A `-rc.1` tag is a pre-release because the version says so, exactly as a Release's flag would.
  assert.equal(releaseFromTag(tagRow('v2.5.0-rc.1'), 'acme/react-wp').prerelease, true);
  // A tag that is not a version is not a release this feature can compare.
  assert.equal(releaseFromTag(tagRow('nightly'), 'acme/react-wp'), null);
  assert.equal(releaseFromTag(null, 'acme/react-wp'), null);
  assert.deepEqual(
    releasesFromTags([tagRow('v2.4.2'), tagRow('nightly'), tagRow('2.4.3')], 'acme/react-wp').map((row) => row.version),
    ['2.4.2', '2.4.3'],
  );
  assert.deepEqual(releasesFromTags('not a list', 'acme/react-wp'), []);
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

test('a repository that publishes by tag alone is read from /tags when /releases is empty', async () => {
  const fetchImpl = stubRoutes([
    ['/releases', []],
    ['/tags', [tagRow('v2.4.2'), tagRow('v2.5.0-rc.1'), tagRow('nightly')]],
  ]);
  const fetched = await fetchGithubReleases({ repo: 'acme/react-wp', token: 'ghp_secret', fetchImpl });

  assert.equal(fetched.source, 'tags', 'the answer says it came from tags, not Releases');
  assert.equal(fetched.url, 'https://api.github.com/repos/acme/react-wp/tags?per_page=30');
  assert.deepEqual(fetchImpl.calls.map((call) => new URL(call.url).pathname), [
    '/repos/acme/react-wp/releases',
    '/repos/acme/react-wp/tags',
  ]);
  assert.equal(fetchImpl.calls[1].init.headers.Authorization, 'Bearer ghp_secret', 'the same credential reads tags');
  assert.deepEqual(fetched.releases.map((release) => release.version), ['2.4.2', '2.5.0-rc.1']);

  // A `-rc` tag is offered on beta only, and a version with no Release still has a page on GitHub.
  assert.equal(latestReleaseFrom(fetched.releases, { channel: 'stable' }).version, '2.4.2');
  assert.equal(latestReleaseFrom(fetched.releases, { channel: 'beta' }).version, '2.5.0-rc.1');
  assert.equal(fetched.releases[0].changelog_url, 'https://github.com/acme/react-wp/releases/tag/v2.4.2');
});

test('a published Release wins: the tag list is a fallback, never a merge', async () => {
  const fetchImpl = stubRoutes([
    ['/releases', [githubRow('v2.4.1')]],
    ['/tags', [tagRow('v2.9.0')]],
  ]);
  const fetched = await fetchGithubReleases({ repo: 'acme/react-wp', fetchImpl });

  assert.equal(fetched.source, 'releases');
  assert.equal(fetchImpl.calls.length, 1, 'tags are not asked for while Releases answer');
  assert.deepEqual(fetched.releases.map((release) => release.version), ['2.4.1']);
  assert.equal(fetched.authenticated, false);
});

test('a failed tag read is a failure, not "no release yet"', async () => {
  const fetchImpl = stubRoutes([
    ['/releases', []],
    ['/tags', { message: 'Not Found' }, 404],
  ]);
  await assert.rejects(
    fetchGithubReleases({ repo: 'acme/react-wp', fetchImpl }),
    /no repository or no release tags/,
  );
});

/* -- 5. Who may ask --------------------------------------------------------------------------------- */

const platformEnv = { RWP_RELEASE_REPO: 'acme/react-wp', RWP_CENTRAL_TOKENS: 'site-token' };

test('a deployment is the platform when it holds a token or names a repository', () => {
  assert.equal(centralConfigFrom({}).enabled, false, 'a site with neither half answers 404, as it always did');
  // Either half mounts the routes. Requiring both is what made a real platform answer `No API endpoint at
  // /api/v1/updates/apply.` to its own sites: its repository was on the installer card, not in the
  // environment.
  const repositoryOnly = centralConfigFrom({ RWP_RELEASE_REPO: 'acme/react-wp' });
  assert.equal(repositoryOnly.enabled, true);
  assert.equal(repositoryOnly.checkEnabled, true);
  assert.equal(repositoryOnly.applyEnabled, false, 'no token means no release package');
  const tokenOnly = centralConfigFrom({ RWP_CENTRAL_TOKENS: 't1' });
  assert.equal(tokenOnly.enabled, true);
  assert.equal(tokenOnly.checkEnabled, false, 'no repository means nothing to answer against');
  assert.equal(tokenOnly.applyEnabled, false);
  const config = centralConfigFrom(platformEnv);
  assert.equal(config.enabled, true);
  assert.equal(config.checkEnabled, true);
  assert.equal(config.applyEnabled, true);
  assert.deepEqual(config.tokens, ['site-token']);
  assert.equal(config.channel, 'stable');
  assert.equal(config.cacheSeconds, 60);
  assert.equal(centralConfigFrom({ RWP_RELEASE_CHANNEL: 'beta' }).channel, 'beta');
  // Checks are public unless the platform says otherwise.
  assert.equal(config.publicChecks, true);
  assert.equal(centralConfigFrom({ RWP_CENTRAL_PUBLIC_CHECKS: 'off' }).publicChecks, false);
  // A repository read from this deployment's own rows fills the same slot as the environment's.
  assert.equal(centralConfigFrom({ RWP_CENTRAL_TOKENS: 't1' }, { repo: 'acme/stored' }).repo, 'acme/stored');
});

test('a customer site answers nothing at the platform paths, so its own routes stay its own', async () => {
  assert.equal(await handleCentralUpdateRequest({ pathname: '/api/v1/updates/check', method: 'POST', env: {} }), null);
  assert.equal(await handleCentralUpdateRequest({ pathname: '/api/admin/updates/check', method: 'POST', env: {} }), null);
  assert.equal(await handleCentralUpdateRequest({ pathname: '/api/admin/updates', method: 'GET', env: platformEnv }), null);
});

test('a check is public, and a token that is sent is still verified', async () => {
  clearCentralReleaseCache();
  const fetchImpl = stubFetch([githubRow('v2.4.1')]);
  const anonymous = await handleCentralUpdateRequest({
    pathname: '/api/v1/updates/check',
    method: 'POST',
    headers: {},
    body: { installedVersion: 'v1.3.1' },
    env: platformEnv,
    fetchImpl,
  });
  assert.equal(anonymous.status, 200, 'a site with no token still reads the release list');
  assert.equal(anonymous.body.latestVersion, 'v2.4.1');
  const wrong = await handleCentralUpdateRequest({ pathname: '/api/v1/updates/check', method: 'POST', headers: { authorization: 'Bearer nope' }, env: platformEnv, fetchImpl });
  assert.equal(wrong.status, 403, 'a token that is not one of ours is refused rather than ignored');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined, 'no token is invented for the public check');
  clearCentralReleaseCache();
  const closed = await handleCentralUpdateRequest({
    pathname: '/api/v1/updates/check',
    method: 'POST',
    headers: {},
    body: { installedVersion: 'v1.3.1' },
    env: { ...platformEnv, RWP_CENTRAL_PUBLIC_CHECKS: 'off' },
    fetchImpl,
  });
  assert.equal(closed.status, 401, 'RWP_CENTRAL_PUBLIC_CHECKS=off restores the token requirement');
  const read = await handleCentralUpdateRequest({ pathname: '/api/v1/updates/check', method: 'GET', headers: { authorization: 'Bearer site-token' }, env: platformEnv, fetchImpl });
  assert.equal(read.status, 405);
});

test('a half-configured platform names what is missing instead of answering 404', async () => {
  const noRepo = await handleCentralUpdateRequest({
    pathname: '/api/v1/updates/apply',
    method: 'POST',
    headers: { authorization: 'Bearer site-token' },
    env: { RWP_CENTRAL_TOKENS: 'site-token' },
  });
  assert.equal(noRepo.status, 503, 'a token with no repository is a configuration problem, not a wrong path');
  assert.match(noRepo.body.error, /RWP_RELEASE_REPO/);
  const noToken = await handleCentralUpdateRequest({
    pathname: '/api/v1/updates/apply',
    method: 'POST',
    headers: { authorization: 'Bearer site-token' },
    env: { RWP_RELEASE_REPO: 'acme/react-wp' },
  });
  assert.equal(noToken.status, 503);
  assert.match(noToken.body.error, /RWP_CENTRAL_TOKEN/);
  // A platform that closed its checks and accepts no token cannot answer one either, and says which half
  // is missing rather than pretending the route does not exist.
  const closed = await handleCentralUpdateRequest({
    pathname: '/api/v1/updates/check',
    method: 'POST',
    env: { RWP_RELEASE_REPO: 'acme/react-wp', RWP_CENTRAL_PUBLIC_CHECKS: 'off' },
  });
  assert.equal(closed.status, 503);
  assert.match(closed.body.error, /RWP_CENTRAL_TOKEN/);
});

test('a platform whose repository is only in its own rows still answers', async () => {
  // How a real platform is configured: the template repository is saved on the installer card, which writes
  // `saas_installer_config`. None of that is in the environment, and it used to leave the platform
  // answering `No API endpoint at /api/v1/updates/apply.`
  clearStoredReleaseSource();
  const rows = {
    saas_installer_config: JSON.stringify({ template_repo: 'acme/react-wp' }),
    github_config: JSON.stringify({ repository: '', token: 'ghp_stored' }),
  };
  const config = await centralPlatformConfig({
    env: { RWP_CENTRAL_TOKENS: 'site-token' },
    readOptions: { readSetting: async (name) => rows[name] || '' },
  });
  assert.equal(config.repo, 'acme/react-wp');
  assert.equal(config.checkEnabled, true);
  assert.equal(config.applyEnabled, true);
  assert.equal(config.githubToken, 'ghp_stored', 'the credential the GitHub card saved is used to read it');

  const fetched = stubFetch([githubRow('v2.4.1')]);
  const answer = await handleCentralUpdateRequest({
    pathname: '/api/v1/updates/check',
    method: 'POST',
    body: { installedVersion: 'v1.3.1' },
    env: {},
    config,
    fetchImpl: fetched,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.latestVersion, 'v2.4.1');

  // Nothing stored and nothing in the environment is still a 404: an ordinary site answers nothing.
  clearStoredReleaseSource();
  const plain = await centralPlatformConfig({ env: {}, readOptions: { readSetting: async () => '' } });
  assert.equal(plain.enabled, false);
  clearStoredReleaseSource();
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

test('the repository a check reads is the one Settings → Updates names, then the environment, then the integration', () => {
  const stored = { repository: 'acme/integration', token: 'ghp_stored' };

  // The screen wins over everything: it is the administrator naming the tags this site is released on.
  assert.deepEqual(
    githubUpdateSourceFrom({ RWP_RELEASE_REPO: 'acme/env', RWP_RELEASE_TOKEN: 'ghp_env' }, stored, 'acme/settings'),
    { repo: 'acme/settings', token: 'ghp_env', explicit: true },
  );
  // A name typed as a URL is accepted, and is still the screen's answer.
  assert.equal(githubUpdateSourceFrom({}, {}, 'https://github.com/acme/settings').repo, 'https://github.com/acme/settings');
  // With nothing named, the environment answers, then the integration's row.
  assert.deepEqual(
    githubUpdateSourceFrom({ GITHUB_REPO: 'acme/env', GITHUB_TOKEN: 'ghp_env' }, stored),
    { repo: 'acme/env', token: 'ghp_env', explicit: false },
  );
  assert.deepEqual(githubUpdateSourceFrom({}, stored), { repo: 'acme/integration', token: 'ghp_stored', explicit: false });
  // A public repository is a source with no credential, which is a supported state.
  assert.deepEqual(githubUpdateSourceFrom({}, { repository: 'acme/public' }), { repo: 'acme/public', token: '', explicit: false });
  // Nothing that is not `owner/name` is a source, and a hand-typed name is not trusted over the stored row.
  assert.equal(githubUpdateSourceFrom({}, {}, 'not-a-repo'), null);
  assert.equal(githubUpdateSourceFrom({ RWP_RELEASE_REPO: 'not-a-repo' }, {}, ''), null);
  assert.equal(githubUpdateSourceFrom({}, {}, ''), null);
});

test('a named repository answers a check first, even when an update token is stored', async () => {
  const fetchImpl = stubRoutes([['/releases', [githubRow('v2.4.1')]]]);
  const answer = await checkForUpdates({
    config: { token: 'site-token', channel: 'stable', repository: 'acme/settings' },
    current: { app: '1.3.1' },
    plugins: [],
    github: { repo: 'acme/settings', token: 'ghp_stored', explicit: true },
    fetchImpl,
  });

  assert.equal(answer.source, 'github');
  assert.equal(answer.app.latest, '2.4.1');
  assert.equal(answer.error, '', 'nothing failed, so nothing is reported beside the answer');
  assert.equal(fetchImpl.calls.length, 1, 'the platform is not asked when the named repository answered');
  assert.match(fetchImpl.calls[0].url, /repos\/acme\/settings\/releases/);
});

test('a licensed site that names no repository asks the platform, and GitHub only when that fails', async () => {
  const central = stubFetch({ latestVersion: 'v2.4.1', updateAvailable: true, releaseNotes: '- x' });
  const answer = await checkForUpdates({
    config: { central_url: 'https://react-wp.com', token: 'site-token', channel: 'stable' },
    current: { app: '1.3.1' },
    plugins: [],
    github: { repo: 'acme/integration', token: 'ghp_stored', explicit: false },
    fetchImpl: central,
  });

  assert.equal(answer.source, 'central');
  assert.equal(central.calls.length, 1, 'the integration repository is the fallback, not the first answer');
  assert.equal(central.calls[0].url, 'https://react-wp.com/api/v1/updates/check');
});

test('a tag-only repository answers the whole check, and says nothing it does not know', async () => {
  const fetchImpl = stubRoutes([
    ['/releases', []],
    ['/tags', [tagRow('v2.4.2'), tagRow('v2.5.0-rc.1')]],
  ]);
  const answer = await checkForUpdates({
    config: { channel: 'stable', repository: 'acme/react-wp' },
    current: { app: '1.3.1' },
    plugins: [],
    github: { repo: 'acme/react-wp', token: '', explicit: true },
    fetchImpl,
  });

  assert.equal(answer.source, 'github');
  assert.equal(answer.latestVersion, 'v2.4.2', 'stable is offered the newest tag that is not a pre-release');
  assert.equal(answer.releaseNotes, '', 'a tag has no body, and the answer does not invent one');
  assert.equal(answer.releaseUrl, 'https://github.com/acme/react-wp/releases/tag/v2.4.2');
  assert.equal(answer.updateAvailable, true);
});

test('when every source refuses, the answer is the joined sentences and the last status', async () => {
  const fetchImpl = stubRoutes([
    ['/releases', { message: 'Not Found' }, 404],
    ['/tags', { message: 'Not Found' }, 404],
    ['updates/check', { error: 'down' }, 503],
  ]);
  await assert.rejects(
    checkForUpdates({
      config: { central_url: 'https://react-wp.com', token: 'site-token', channel: 'stable', repository: 'acme/private' },
      current: { app: '1.3.1' },
      plugins: [],
      github: { repo: 'acme/private', token: '', explicit: true },
      fetchImpl,
    }),
    (error) => {
      assert.equal(error.status, 502, 'the platform was tried last, so its status is the one that answers');
      assert.match(error.message, /no repository or no release tags/, 'the first failure is kept');
      assert.match(error.message, /HTTP 503/, 'and so is the last');
      return true;
    },
  );
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

/* -- 8. A managed site ------------------------------------------------------------------------------ */

test('a managed site is answered by the platform, and nothing else is ever asked', async () => {
  // Everything the owner's check would use is present — a token, a named repository, a GitHub credential —
  // and none of it may be read for an end user: their site has one release channel, react-wp.com.
  const fetchImpl = stubRoutes([['/updates/check', { latestVersion: 'v2.4.1', releaseNotes: '- x' }]]);
  const answer = await checkForUpdates({
    config: { central_url: 'https://react-wp.com', token: 'site-token', channel: 'stable', repository: 'acme/private' },
    current: { app: '1.3.1' },
    plugins: [{ id: 'seo', name: 'SEO', version: '1.0.0' }],
    github: { repo: 'acme/private', token: 'ghp_stored', explicit: true },
    fetchImpl,
    owner: false,
  });

  assert.equal(answer.source, 'central');
  assert.equal(answer.app.latest, '2.4.1');
  assert.deepEqual(answer.plugins, {}, 'an end user is told about the core, never about plugin releases');
  assert.deepEqual(answer.updates.map((entry) => entry.kind), ['app'], 'one update, one button');
  assert.equal(answer.error, '');
  assert.equal(fetchImpl.calls.length, 1, 'the platform is the only source asked');
  assert.match(fetchImpl.calls[0].url, /^https:\/\/react-wp\.com\/api\/v1\/updates\/check$/);
  assert.ok(fetchImpl.calls.every((call) => !call.url.includes('github.com')), 'no GitHub read, not even as a fallback');
});

test('a managed site is never answered by GitHub, even when the platform refuses', async () => {
  // The stub would happily answer a GitHub read: the point is that a managed check never makes one.
  const fetchImpl = stubRoutes([
    ['/updates/check', { error: 'down' }, 503],
    ['/releases', [githubRow('v9.9.9')]],
  ]);
  await assert.rejects(
    checkForUpdates({
      config: { central_url: 'https://react-wp.com', token: 'site-token', channel: 'stable' },
      current: { app: '1.3.1' },
      plugins: [],
      github: { repo: 'acme/react-wp', token: 'ghp_stored' },
      fetchImpl,
      owner: false,
    }),
    (error) => {
      assert.equal(error.message, MANAGED_MESSAGES.unavailable(503), 'the customer is told what happened, in their words');
      assert.equal(error.status, 502);
      assert.ok(fetchImpl.calls.every((call) => !call.url.includes('github.com')), 'the release tags are not a fallback for a managed site');
      assert.doesNotMatch(error.message, /token|repository|deploy hook|git/i, 'nothing here asks a customer to configure a source');
      return true;
    },
  );
});

test('a managed site with no token still reads the release list', async () => {
  // The fix for a site provisioned before it was handed a token: a check is public, so "no token saved" is
  // no longer a reason to answer nothing at all.
  const fetchImpl = stubRoutes([['/updates/check', { latestVersion: 'v2.4.1', releaseNotes: '- x' }]]);
  const answer = await checkForUpdates({
    config: { central_url: 'https://react-wp.com', channel: 'stable' },
    current: { app: '1.3.1' },
    plugins: [],
    github: { repo: 'acme/react-wp', token: 'ghp_stored' },
    fetchImpl,
    owner: false,
  });
  assert.equal(answer.source, 'central');
  assert.equal(answer.app.latest, '2.4.1');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined, 'no token is invented for it');
  assert.ok(fetchImpl.calls.every((call) => !call.url.includes('github.com')), 'a managed site never reads GitHub');
});

test('a managed site the platform will not answer is pointed at support, not at a settings screen', async () => {
  await assert.rejects(
    checkForUpdates({
      config: { central_url: 'https://react-wp.com', channel: 'stable' },
      current: { app: '1.3.1' },
      plugins: [],
      github: { repo: 'acme/react-wp', token: 'ghp_stored' },
      fetchImpl: async () => new Response(JSON.stringify({ error: 'a token is required' }), { status: 401 }),
      owner: false,
    }),
    (error) => {
      assert.equal(error.message, MANAGED_MESSAGES.not_connected);
      assert.equal(error.status, 401, 'the site cannot check, which is not the customer asking something wrong');
      assert.doesNotMatch(error.message, /token|repository|GitHub|Settings →/);
      return true;
    },
  );
});

test('a managed site support answer is the package it installs, with no repository and no host detail', () => {
  assert.deepEqual(
    managedUpdateSupport({ supported: true, reason: '', restart: 'pm2', app_name: 'react-wp' }),
    { available: true, repo: false, supported: true, reason: '', restart: 'pm2', app_name: 'react-wp' },
  );
  const refused = managedUpdateSupport({ supported: false, reason: 'This folder has no package.json.', restart: 'pm2', app_name: 'x' });
  assert.equal(refused.supported, false);
  assert.equal(refused.repo, false, 'a customer has no repository to name');
  assert.equal(refused.available, false);
  assert.equal(refused.reason, MANAGED_MESSAGES.cannot_apply, 'the host probe\'s sentence is replaced, never shown');
  assert.equal(refused.restart, 'manual');
  assert.equal(refused.app_name, '');
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
