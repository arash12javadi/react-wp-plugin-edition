/**
 * Transporting a built site from the machine that built it to the server that deploys it.
 *
 * Why the bytes have to travel at all
 * -----------------------------------
 * The deployment engine (`vercelApi.mjs`) uploads a `Map<path, Buffer>` to Vercel. Only the site's own server
 * may do that, because only it holds the sealed token. But only a machine with a checkout can *produce* those
 * bytes. So the payload crosses between them, and this module is that crossing: a ZIP of the deployable tree,
 * cut into chunks small enough for any host's request limit, reassembled and verified before anything is
 * deployed.
 *
 * The properties that matter
 * --------------------------
 *   - **Chunked.** A built React-WP site is a few megabytes; a single POST of it would break on Vercel's 4.5 MB
 *     request limit and would have to be re-sent in full after any failure. 512 KB chunks are small enough for
 *     every host, and a chunk is idempotent (the same index overwrites itself), so an interrupted upload
 *     resumes instead of restarting.
 *   - **Verified.** The payload's `sha256` is what the server checks before deploying: the bytes that reach
 *     Vercel are the bytes the worker says it built, not whatever a retried chunk left behind.
 *   - **Bounded.** A package is capped at the plugin ZIP limit, a payload at 48 MB and 6000 files, and every
 *     entry name is checked for traversal. The limits are refusals with a sentence, not truncation.
 *
 * The storage port (implemented by `plugins/rwp-saas-installer/jobStore.mjs`):
 *
 *   `putBlobChunk({ job_id, kind, chunk, total, sha256, size, data })` -> void    upsert on (job_id, kind, chunk)
 *   `blobManifest(job_id, kind)` -> { sha256, size, total, received } | null
 *   `readBlobChunks(job_id, kind)` -> [{ chunk, data }] ordered by chunk, `data` base64
 *   `deleteArtifact(job_id)` -> void
 */
import { createHash } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { DeployError } from './errors.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** How much of an artifact travels in one request. */
export const ARTIFACT_CHUNK_BYTES = 512 * 1024;

/** A plugin package is the same artefact as a menu upload, so the same ceiling applies. */
export const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;

/** A built site: `dist/` plus the function bundles. Generous, and far below a database blob limit. */
export const MAX_PAYLOAD_BYTES = 48 * 1024 * 1024;

/** More files than this and the payload is not a React-WP build. */
export const MAX_PAYLOAD_FILES = 6000;

/** The two artifacts a job carries: what was installed, and what was built from it. */
export const ARTIFACT_KINDS = Object.freeze(['package', 'payload']);

/** The ceiling for one kind, so a caller cannot pick the larger one for the smaller artifact. */
export const artifactLimit = (kind) => (str(kind) === 'payload' ? MAX_PAYLOAD_BYTES : MAX_PACKAGE_BYTES);

const isKind = (kind) => ARTIFACT_KINDS.includes(str(kind));

/** How many chunks a blob needs, and how large the last one may be. */
export function chunkPlan(size, { chunkBytes = ARTIFACT_CHUNK_BYTES } = {}) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new DeployError(400, 'The upload is empty, so there is nothing to store.', { code: 'artifact_empty' });
  }
  const total = Math.ceil(bytes / chunkBytes);
  if (total > 512) {
    throw new DeployError(413, `That file needs ${total} chunks, which is more than this server accepts. Deploy it from the server instead of a worker.`, { code: 'artifact_too_large' });
  }
  return { size: Math.floor(bytes), chunkBytes, total };
}

export const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Stores one chunk of an artifact.
 *
 * The chunk index is the identity: re-sending chunk 3 replaces chunk 3, which is what makes an upload that
 * was interrupted by a laptop lid or a flaky link resumable without a session to resume. The digest travels
 * with every chunk because every chunk names the same whole — a chunk from a different build cannot slip into
 * this one without the final check refusing the artifact.
 */
export async function putArtifactChunk({ store, jobId, kind, index, total, sha256, size, data }) {
  const id = str(jobId);
  const type = str(kind);
  if (!id) throw new DeployError(400, 'A job id is required to store an artifact.', { code: 'job_missing' });
  if (!isKind(type)) throw new DeployError(400, `An artifact is one of ${ARTIFACT_KINDS.join(' or ')}.`, { code: 'artifact_kind' });
  const plan = chunkPlan(size);
  const chunk = Number(index);
  if (!Number.isInteger(chunk) || chunk < 0 || chunk >= plan.total) {
    throw new DeployError(400, `Chunk ${index} is outside this upload: it has ${plan.total} chunks, numbered from 0.`, { code: 'artifact_chunk_range' });
  }
  if (Number(total) !== plan.total) {
    throw new DeployError(409, `This upload says it has ${total} chunks, but ${plan.size} bytes need ${plan.total}. The worker and the server disagree, so nothing was stored.`, { code: 'artifact_chunk_count' });
  }
  const bytes = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data || []);
  if (!bytes.length) throw new DeployError(400, `Chunk ${chunk} is empty.`, { code: 'artifact_chunk_empty' });
  if (bytes.length > plan.chunkBytes) {
    throw new DeployError(413, `Chunk ${chunk} is ${bytes.length} bytes; the limit is ${plan.chunkBytes}.`, { code: 'artifact_chunk_too_large' });
  }
  if (plan.size > artifactLimit(type)) {
    throw new DeployError(413, `That ${type} is ${Math.round(plan.size / 1024 / 1024)} MB, which is over the ${Math.round(artifactLimit(type) / 1024 / 1024)} MB limit.`, { code: 'artifact_too_large' });
  }
  await store.putBlobChunk({
    job_id: id,
    kind: type,
    chunk,
    total: plan.total,
    sha256: str(sha256),
    size: plan.size,
    data: bytes.toString('base64'),
  });
  return { chunk, total: plan.total };
}

/**
 * Reassembles and verifies an artifact, or explains why it cannot be deployed.
 *
 * A missing chunk is a 409 with the count, because "upload it again" is the fix and the worker can compute
 * how much it still owes. A digest mismatch is a 409 too — and a much more serious one: it means the bytes on
 * this server are not the bytes the worker built, so deploying them would publish something nobody built.
 */
export async function readArtifact({ store, jobId, kind, expectedSha256 = '' }) {
  const type = str(kind);
  if (!isKind(type)) throw new DeployError(400, `An artifact is one of ${ARTIFACT_KINDS.join(' or ')}.`, { code: 'artifact_kind' });
  const manifest = await store.blobManifest(str(jobId), type);
  if (!manifest || !manifest.total) {
    throw new DeployError(409, `No ${type} has been uploaded for this job yet.`, { code: 'artifact_missing' });
  }
  if (Number(manifest.received) < Number(manifest.total)) {
    throw new DeployError(
      409,
      `The ${type} upload is incomplete: ${manifest.received} of ${manifest.total} chunks arrived. Upload the rest and this job continues.`,
      { code: 'artifact_incomplete', details: { received: Number(manifest.received), total: Number(manifest.total) } },
    );
  }
  const rows = await store.readBlobChunks(str(jobId), type);
  const bytes = Buffer.concat(rows
    .slice()
    .sort((a, b) => Number(a.chunk) - Number(b.chunk))
    .map((row) => Buffer.from(String(row.data || ''), 'base64')));
  if (Number(manifest.size) && bytes.length !== Number(manifest.size)) {
    throw new DeployError(409, `The ${type} is ${bytes.length} bytes but should be ${manifest.size}, so it was not deployed. Upload it again.`, { code: 'artifact_size_mismatch' });
  }
  const digest = sha256Of(bytes);
  const wanted = str(expectedSha256) || str(manifest.sha256);
  if (wanted && digest !== wanted) {
    throw new DeployError(409, `The ${type} on this server does not match what was built (sha256 ${digest.slice(0, 12)}… instead of ${wanted.slice(0, 12)}…), so nothing was deployed. Run the install again.`, { code: 'artifact_digest_mismatch' });
  }
  return { bytes, sha256: digest, size: bytes.length, chunks: rows.length };
}

/**
 * The payload's entry names, checked before anything is read out of the archive.
 *
 * A ZIP is a container somebody else wrote, so every name is a path a filesystem would follow: absolute
 * paths, `..`, Windows drive letters and control characters are all refusals, not sanitisation. Vercel would
 * receive these names verbatim, so a traversal here would not stay inside this process.
 */
function assertPayloadEntry(name) {
  const normalised = String(name || '').replace(/\\/g, '/');
  const segments = normalised.split('/');
  if (!normalised || normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) {
    throw new DeployError(400, `The built payload contains an absolute path (${JSON.stringify(name)}), so it was not deployed.`, { code: 'payload_unsafe_path' });
  }
  if (/[\u0000-\u001f]/.test(normalised) || segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new DeployError(400, `The built payload contains an unsafe path (${JSON.stringify(name)}), so it was not deployed.`, { code: 'payload_unsafe_path' });
  }
  return normalised;
}

/**
 * Reads a built payload back into the `Map<path, Buffer>` `createFileDeployment()` wants.
 *
 * The allowlist is *not* applied here: `assertDeployPayload()` (`prebuilt.mjs`) is the one rule about which
 * files may reach a customer's project, and it is the caller's promise. This function only guarantees that
 * every name is a relative path and that the archive stays inside its limits.
 */
export function payloadZipToFiles(bytes) {
  let archive;
  try {
    archive = unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
  } catch (error) {
    throw new DeployError(400, `The built payload is not a readable ZIP: ${error instanceof Error ? error.message : 'the archive is damaged'}.`, { code: 'payload_unreadable' });
  }
  const names = Object.keys(archive);
  if (!names.length) throw new DeployError(400, 'The built payload is an empty archive, so there is nothing to deploy.', { code: 'payload_empty' });
  const files = new Map();
  let total = 0;
  for (const name of names) {
    if (name.endsWith('/')) continue;
    const relative = assertPayloadEntry(name);
    const data = Buffer.from(archive[name]);
    total += data.length;
    if (total > MAX_PAYLOAD_BYTES) {
      throw new DeployError(413, `The built payload unpacks to more than ${Math.round(MAX_PAYLOAD_BYTES / 1024 / 1024)} MB, so it was not deployed.`, { code: 'payload_too_large' });
    }
    if (files.size >= MAX_PAYLOAD_FILES) {
      throw new DeployError(413, `The built payload has more than ${MAX_PAYLOAD_FILES} files, so it was not deployed.`, { code: 'payload_too_many_files' });
    }
    files.set(relative, data);
  }
  if (!files.size) throw new DeployError(400, 'The built payload contains no files, so there is nothing to deploy.', { code: 'payload_empty' });
  return files;
}

/** The inverse: a payload the worker can upload, and a test can round-trip. */
export function filesToZip(files) {
  const entries = {};
  for (const [name, data] of files instanceof Map ? files : Object.entries(files)) {
    entries[String(name)] = new Uint8Array(Buffer.from(data));
  }
  return Buffer.from(zipSync(entries, { level: 6 }));
}


