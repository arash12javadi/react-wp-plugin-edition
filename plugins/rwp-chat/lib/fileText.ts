import { strFromU8, unzipSync } from 'fflate';

/**
 * Turning an uploaded document into plain text, in the browser.
 *
 * The alternative is shipping the bytes to the server, and there is nowhere good to put them: the
 * plugin's routes cap the body (MAX_BODY), the deployment holds no service key to write to Storage,
 * and a PDF parser is a dependency this plugin does not have. The browser already has everything
 * needed for text, HTML and — because the shop's backup screen already carries fflate — a .docx,
 * which is a zip with one XML file in it.
 *
 * What comes out is a draft, never a published entry: extraction is rough by nature, so the person
 * who uploaded the file reads and edits it before the bot may quote it.
 */

export interface ExtractedDocument {
  /** The file name, tidied into something a person would search for. */
  title: string;
  text: string;
  /** Anything the person should know before saving: truncation, or what was skipped. */
  note: string;
}

/** A document larger than this is not knowledge, it is an archive. */
export const maxUploadBytes = 10 * 1024 * 1024;
/** More than this in one entry is never retrieved whole, and slows every write to the table. */
const MAX_CHARS = 150_000;

export const acceptedUploadExtensions = ['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.docx'];
/** For the file input's accept attribute. */
export const uploadAccept = acceptedUploadExtensions.join(',');
/** For a sentence a person reads. */
export const acceptLabel = acceptedUploadExtensions.join(' ');

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** The named entities a document body actually contains; anything else is left as written. */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
};

const fromCodePoint = (code: number, fallback: string): string => {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
};

const decodeEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    const key = name.toLowerCase();
    if (key.startsWith('#x')) return fromCodePoint(Number.parseInt(key.slice(2), 16), match);
    if (key.startsWith('#')) return fromCodePoint(Number.parseInt(key.slice(1), 10), match);
    return ENTITIES[key] ?? match;
  });

/** Prose as a person would type it: single spaces, blank lines between paragraphs. */
const collapse = (value: string): string =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const BLOCK_TAGS = 'p,div,br,li,tr,h1,h2,h3,h4,h5,h6,section,article,header,footer,blockquote,pre,dt,dd';

const htmlToText = (html: string): string => {
  // DOMParser is absent only outside a browser; the regex pass is good enough for that case, which
  // is the one place it happens (a test importing this file under Node).
  if (typeof DOMParser === 'undefined') {
    return decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, '\n'));
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,template,svg,iframe,form').forEach((element) => element.remove());
  doc.querySelectorAll(BLOCK_TAGS).forEach((element) => element.append('\n'));
  return decodeEntities(doc.body?.textContent || '');
};

/** A .docx is a zip; the words are in word/document.xml, one <w:p> per paragraph. */
const docxToText = (buffer: ArrayBuffer): string => {
  const files = unzipSync(new Uint8Array(buffer));
  const document = files['word/document.xml'];
  if (!document) {
    throw new Error('That file is a .docx in name only — it has no word/document.xml inside. Open it in Word and save it again, or paste the text.');
  }
  const xml = strFromU8(document);
  return decodeEntities(
    xml
      .replace(/<w:tab[^>]*\/>/g, ' ')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
};

const extensionOf = (name: string): string => {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? `.${match[1].toLowerCase()}` : '';
};

const titleFromName = (name: string): string =>
  name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled document';


export const extractDocument = async (file: File): Promise<ExtractedDocument> => {
  if (file.size > maxUploadBytes) {
    throw new Error(`${file.name} is ${formatBytes(file.size)}, and anything over ${formatBytes(maxUploadBytes)} is refused. Split it, or paste the part that matters into an entry.`);
  }
  const extension = extensionOf(file.name);
  if (extension === '.pdf') {
    throw new Error('A PDF is not read here: its text comes out as fragments in the wrong order, which is worse than nothing. Copy the text out of it and paste it into an entry.');
  }
  if (!acceptedUploadExtensions.includes(extension)) {
    throw new Error(`${file.name} is not a document type this screen reads. It takes ${acceptedUploadExtensions.join(', ')}.`);
  }

  const raw = extension === '.docx'
    ? docxToText(await file.arrayBuffer())
    : extension === '.html' || extension === '.htm'
      ? htmlToText(await file.text())
      : await file.text();

  const text = collapse(raw);
  if (text.length < 40) {
    throw new Error(`Nothing readable came out of ${file.name}. If it is a scan or a picture of a page, the words have to be typed in.`);
  }

  const cut = text.length > MAX_CHARS;
  const note = cut
    ? `Only the first ${MAX_CHARS.toLocaleString()} characters were kept — the rest of ${file.name} is not in this entry.`
    : extension === '.docx'
      ? 'Tables, images and text boxes are not carried over from a .docx; check that the facts you need are in the text below.'
      : '';
  return { title: titleFromName(file.name), text: cut ? text.slice(0, MAX_CHARS) : text, note };
};

