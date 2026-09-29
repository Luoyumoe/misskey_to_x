/*
 * Misskey -> X Cloudflare Worker.
 * Pure ES module. No build step or runtime dependencies.
 */

const MAX_BODY_BYTES = 256 * 1024;
const X_API_BASE = 'https://api.x.com';
const TWEET_TEXT_LIMIT = 280;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_GIF_BYTES = 15 * 1024 * 1024;
const MEDIA_CHUNK_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

class XApiError extends Error {
  constructor(message, status, body, retryAfter) {
    super(message);
    this.name = 'XApiError';
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

export function normalizeMime(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

export function normalizeTag(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/^#/, '')
    .toLocaleLowerCase();
}

function replaceUrlsWithSpaces(text) {
  return String(text || '').replace(/https?:\/\/[^\s<>"']+/giu, (match) => ' '.repeat(match.length));
}

export function extractHashtags(text, extraTags = []) {
  const tags = new Set();
  for (const value of extraTags || []) {
    const normalized = normalizeTag(value);
    if (normalized) tags.add(normalized);
  }
  const source = replaceUrlsWithSpaces(text);
  const pattern = /(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]+)/gu;
  for (const match of source.matchAll(pattern)) {
    const normalized = normalizeTag(match[1]);
    if (normalized) tags.add(normalized);
  }
  return [...tags];
}

export function hasRequiredTag(note, requiredTag = 'to_x') {
  const tags = extractHashtags(note?.text || '', note?.tags || []);
  return tags.includes(normalizeTag(requiredTag));
}

export function shouldSyncEnvelope(envelope, requiredTag = 'to_x') {
  if (!envelope || envelope.type !== 'note') return { action: 'ignored_not_post' };
  const note = envelope.body;
  if (!note || typeof note !== 'object') return { action: 'ignored_not_post' };
  if (!note.id) return { action: 'invalid_note' };
  if (note.replyId || note.reply || note.renoteId || note.renote) {
    return { action: 'ignored_reply_or_renote' };
  }
  if (!hasRequiredTag(note, requiredTag)) return { action: 'ignored_no_tag' };
  return { action: 'queue', note };
}

function bytesForComparison(value) {
  return value instanceof Uint8Array ? value : new TextEncoder().encode(String(value || ''));
}

export function constantTimeEqual(left, right) {
  const a = bytesForComparison(left);
  const b = bytesForComparison(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function isEmojiWeightTwo(codePoint) {
  return !(
    codePoint <= 0x10ff ||
    (codePoint >= 0x2000 && codePoint <= 0x200d) ||
    (codePoint >= 0x2010 && codePoint <= 0x201f) ||
    (codePoint >= 0x2032 && codePoint <= 0x2037)
  );
}

function graphemeWeight(text) {
  for (const character of text) {
    if (isEmojiWeightTwo(character.codePointAt(0))) return 2;
  }
  return 1;
}

function textWeight(text) {
  let total = 0;
  for (const grapheme of segmentGraphemes(text)) total += graphemeWeight(grapheme);
  return total;
}

function findUrls(text) {
  const result = [];
  const pattern = /https?:\/\/[^\s<>"']+/giu;
  for (const match of text.matchAll(pattern)) {
    let value = match[0];
    while (/[.,!?;:)\]}]$/.test(value)) value = value.slice(0, -1);
    result.push({ value, index: match.index });
  }
  return result;
}

export function weightedLength(text) {
  const source = String(text || '');
  const urls = findUrls(source);
  if (!urls.length) return textWeight(source);
  let total = 0;
  let cursor = 0;
  for (const url of urls) {
    if (url.index > cursor) total += textWeight(source.slice(cursor, url.index));
    total += 23;
    cursor = url.index + url.value.length;
  }
  if (cursor < source.length) total += textWeight(source.slice(cursor));
  return total;
}

function segmentGraphemes(text) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);
  }
  return [...text];
}

function tokenizeForSplit(text) {
  const source = String(text || '');
  const tokens = [];
  let cursor = 0;
  for (const url of findUrls(source)) {
    if (url.index > cursor) {
      for (const grapheme of segmentGraphemes(source.slice(cursor, url.index))) {
        tokens.push({ value: grapheme, weight: graphemeWeight(grapheme), atomic: false });
      }
    }
    tokens.push({ value: source.slice(url.index, url.index + url.value.length), weight: 23, atomic: true });
    cursor = url.index + url.value.length;
  }
  if (cursor < source.length) {
    for (const grapheme of segmentGraphemes(source.slice(cursor))) {
      tokens.push({ value: grapheme, weight: graphemeWeight(grapheme), atomic: false });
    }
  }
  return tokens;
}

export function splitText(text, limit = TWEET_TEXT_LIMIT) {
  const source = String(text || '');
  if (!source) return [];
  const tokens = tokenizeForSplit(source);
  const chunks = [];
  let current = '';
  let currentWeight = 0;
  let lastBreak = -1;

  const flush = (end = current.length) => {
    const value = current.slice(0, end).replace(/\s+$/u, '');
    if (value) chunks.push(value);
    current = current.slice(end).replace(/^\s+/u, '');
    currentWeight = weightedLength(current);
    lastBreak = -1;
  };

  for (const token of tokens) {
    if (current && currentWeight + token.weight > limit) {
      if (lastBreak > 0 && lastBreak < current.length) {
        flush(lastBreak);
      } else {
        flush();
      }
    }
    if (!current && token.weight > limit) {
      const pieces = segmentGraphemes(token.value);
      let piece = '';
      let pieceWeight = 0;
      for (const grapheme of pieces) {
        const graphemeTokenWeight = token.atomic ? graphemeWeight(grapheme) : graphemeWeight(grapheme);
        if (piece && pieceWeight + graphemeTokenWeight > limit) {
          chunks.push(piece);
          piece = '';
          pieceWeight = 0;
        }
        piece += grapheme;
        pieceWeight += graphemeTokenWeight;
      }
      if (piece) {
        current = piece;
        currentWeight = pieceWeight;
      }
      continue;
    }
    current += token.value;
    currentWeight += token.weight;
    if (!token.atomic && /\s|[\p{P}]/u.test(token.value)) lastBreak = current.length;
    if (currentWeight >= limit) flush();
  }
  flush();
  return chunks;
}

function normalizeNote(note) {
  return {
    id: String(note.id),
    text: String(note.text || ''),
    cw: note.cw == null ? '' : String(note.cw),
    tags: Array.isArray(note.tags) ? note.tags.map(String) : [],
    files: Array.isArray(note.files)
      ? note.files.map((file) => ({
          id: String(file.id || file.url || ''),
          name: String(file.name || ''),
          type: normalizeMime(file.type),
          size: Number(file.size || 0),
          url: String(file.url || ''),
          isSensitive: Boolean(file.isSensitive),
        }))
      : [],
  };
}

function isSupportedImage(file) {
  return SUPPORTED_IMAGE_TYPES.has(file.type) && Boolean(file.url);
}

function imageSizeLimit(type) {
  return type === 'image/gif' ? MAX_GIF_BYTES : MAX_IMAGE_BYTES;
}

export function groupImages(files) {
  const groups = [];
  let staticGroup = [];
  for (const file of files || []) {
    if (!isSupportedImage(file)) continue;
    if (file.size > imageSizeLimit(file.type)) continue;
    if (file.type === 'image/gif') {
      if (staticGroup.length) {
        groups.push(staticGroup);
        staticGroup = [];
      }
      groups.push([file]);
      continue;
    }
    staticGroup.push(file);
    if (staticGroup.length === 4) {
      groups.push(staticGroup);
      staticGroup = [];
    }
  }
  if (staticGroup.length) groups.push(staticGroup);
  return groups;
}

export function buildSyncPlan(rawNote) {
  const note = normalizeNote(rawNote);
  const text = note.cw ? `CW: ${note.cw}${note.text ? `\n\n${note.text}` : ''}` : note.text;
  const textUnits = splitText(text);
  const mediaGroups = groupImages(note.files);
  const units = [];

  if (!textUnits.length) {
    mediaGroups.forEach((files) => units.push({ text: '', files }));
  } else {
    textUnits.forEach((value, index) => {
      units.push({ text: value, files: index === 0 && mediaGroups.length ? mediaGroups[0] : [] });
    });
    mediaGroups.slice(1).forEach((files) => units.push({ text: '', files }));
  }

  return {
    note,
    units,
    media: [...new Map(units.flatMap((unit) => unit.files).map((file) => [file.id, file])).values()],
  };
}

function allowedMediaHosts(env) {
  return String(env.MEDIA_ALLOWED_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function validateMediaUrl(rawUrl, env) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('media URL must use HTTPS');
  if (url.username || url.password) throw new Error('media URL must not contain credentials');
  const allowed = allowedMediaHosts(env);
  const host = url.hostname.toLowerCase();
  if (allowed.length && !allowed.includes(host)) throw new Error('media host is not allowed');
  return url;
}

async function fetchMedia(file, env) {
  const url = validateMediaUrl(file.url, env);
  const response = await fetch(url, {
    redirect: 'error',
    headers: { Accept: 'image/*' },
  });
  if (!response.ok) throw new Error(`media fetch returned ${response.status}`);
  const contentType = normalizeMime(response.headers.get('content-type'));
  if (!SUPPORTED_IMAGE_TYPES.has(contentType)) throw new Error('media content type is unsupported');
  const contentLength = Number(response.headers.get('content-length') || 0);
  const limit = imageSizeLimit(contentType);
  if (contentLength > limit) throw new Error('media is too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw new Error('media is too large');
  return { bytes, type: contentType };
}

function randomHex(bytes = 16) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sortedOAuthParameters(parameters) {
  return Object.entries(parameters)
    .flatMap(([key, value]) => (Array.isArray(value) ? value.map((item) => [key, item]) : [[key, value]]))
    .map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
      return 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function oauthBaseString(method, endpoint, parameters) {
  const url = new URL(endpoint);
  const normalizedUrl = `${url.protocol}//${url.host}${url.pathname}`;
  return [method.toUpperCase(), percentEncode(normalizedUrl), percentEncode(sortedOAuthParameters(parameters))].join('&');
}

async function hmacSha1(value, key) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function buildOAuthHeader(method, endpoint, env, options = {}) {
  const timestamp = options.timestamp || Math.floor(Date.now() / 1000).toString();
  const nonce = options.nonce || randomHex();
  const url = new URL(endpoint);
  const parameters = {};
  for (const [key, value] of url.searchParams.entries()) parameters[key] = value;
  parameters.oauth_consumer_key = env.X_API_KEY;
  parameters.oauth_nonce = nonce;
  parameters.oauth_signature_method = 'HMAC-SHA1';
  parameters.oauth_timestamp = timestamp;
  parameters.oauth_token = env.X_ACCESS_TOKEN;
  parameters.oauth_version = '1.0';

  const signature = await hmacSha1(
    oauthBaseString(method, endpoint, parameters),
    `${percentEncode(env.X_API_KEY_SECRET)}&${percentEncode(env.X_ACCESS_TOKEN_SECRET)}`,
  );
  parameters.oauth_signature = signature;
  const header = Object.entries(parameters)
    .filter(([key]) => key.startsWith('oauth_'))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(', ');
  return `OAuth ${header}`;
}

async function xRequest(env, method, endpoint, options = {}) {
  const url = new URL(endpoint.startsWith('http') ? endpoint : `${X_API_BASE}${endpoint}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, String(value));
  }
  const headers = {
    Authorization: await buildOAuthHeader(method, url.toString(), env),
    Accept: 'application/json',
  };
  let body;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form !== undefined) {
    body = options.form;
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body,
    redirect: 'error',
  });
  const raw = await response.text();
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after') || 0);
    throw new XApiError(`X API ${response.status}`, response.status, parsed, retryAfter);
  }
  return parsed;
}

async function uploadChunkedMedia(env, file, mediaState, saveState) {
  if (mediaState.status === 'ready' && mediaState.mediaId) return mediaState.mediaId;
  const downloaded = await fetchMedia(file, env);
  const totalBytes = downloaded.bytes.byteLength;

  if (!mediaState.mediaId) {
    const initialized = await xRequest(env, 'POST', '/2/media/upload/initialize', {
      json: {
        media_type: downloaded.type,
        total_bytes: totalBytes,
        media_category: downloaded.type === 'image/gif' ? 'tweet_gif' : 'tweet_image',
      },
    });
    mediaState.mediaId = String(initialized.data?.id || initialized.id || '');
    mediaState.sessionId = mediaState.mediaId;
    mediaState.uploadedBytes = 0;
    mediaState.segmentIndex = 0;
    mediaState.status = 'initialized';
    if (!mediaState.mediaId) throw new Error('X media initialize returned no id');
    await saveState();
  }

  let offset = Number(mediaState.uploadedBytes || 0);
  let segmentIndex = Number(mediaState.segmentIndex || 0);
  while (offset < totalBytes) {
    const end = Math.min(offset + MEDIA_CHUNK_BYTES, totalBytes);
    const form = new FormData();
    form.append('segment_index', String(segmentIndex));
    form.append('media', new Blob([downloaded.bytes.slice(offset, end)], { type: downloaded.type }), file.name || 'upload');
    await xRequest(env, 'POST', `/2/media/upload/${encodeURIComponent(mediaState.mediaId)}/append`, { form });
    offset = end;
    segmentIndex += 1;
    mediaState.uploadedBytes = offset;
    mediaState.segmentIndex = segmentIndex;
    mediaState.status = 'appending';
    await saveState();
  }

  const finalized = await xRequest(env, 'POST', `/2/media/upload/${encodeURIComponent(mediaState.mediaId)}/finalize`);
  mediaState.status = 'finalizing';
  await saveState();

  let processing = finalized.data?.processing_info;
  let result = finalized;
  for (let attempt = 0; processing && attempt < 30; attempt += 1) {
    const waitSeconds = Math.max(1, Number(processing.check_after_secs || 1));
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitSeconds, 5) * 1000));
    result = await xRequest(env, 'GET', '/2/media/upload', {
      query: { command: 'STATUS', media_id: mediaState.mediaId },
    });
    processing = result.data?.processing_info;
    if (processing?.state === 'failed') throw new Error('X media processing failed');
    if (processing?.state === 'succeeded') processing = null;
  }
  if (processing) throw new Error('X media processing timed out');

  mediaState.status = 'ready';
  await saveState();
  return mediaState.mediaId;
}

function backoffMs(attempts) {
  return Math.min(60 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, attempts - 1)));
}

function isoAfter(ms) {
  return new Date(Date.now() + ms).toISOString();
}

async function loadJob(env, id) {
  return env.DB.prepare('SELECT * FROM sync_jobs WHERE id = ?').bind(id).first();
}

async function saveState(env, job, state, plan) {
  await env.DB.prepare(
    `UPDATE sync_jobs
     SET state_json = ?, plan_json = COALESCE(?, plan_json), updated_at = ?
     WHERE id = ?`,
  )
    .bind(JSON.stringify(state), plan ? JSON.stringify(plan) : null, new Date().toISOString(), job.id)
    .run();
}

async function claimJob(env, id) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE sync_jobs
     SET status = 'processing', updated_at = ?
     WHERE id = ? AND status IN ('queued', 'retry') AND next_retry_at <= ?
     RETURNING *`,
  )
    .bind(now, id, now)
    .first();
  return result || null;
}

async function finishJob(env, id, status, error = '') {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE sync_jobs
     SET status = ?, last_error = ?, completed_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(status, error, status === 'completed' ? now : null, now, id)
    .run();
}

async function retryJob(env, id, attempts, error, retryAfterMs = 0) {
  const nextRetryAt = isoAfter(retryAfterMs || backoffMs(attempts));
  await env.DB.prepare(
    `UPDATE sync_jobs
     SET status = ?, attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(attempts >= 5 ? 'dead' : 'retry', attempts, nextRetryAt, error, new Date().toISOString(), id)
    .run();
}

async function processJob(id, env) {
  const job = await claimJob(env, id);
  if (!job) return;
  let plan = job.plan_json ? JSON.parse(job.plan_json) : null;
  const state = job.state_json ? JSON.parse(job.state_json) : { published: {}, media: {} };
  state.published ||= {};
  state.media ||= {};
  let attempts = Number(job.attempts || 0) + 1;

  try {
    if (!plan) {
      plan = buildSyncPlan(JSON.parse(job.note_json));
      await saveState(env, job, state, plan);
    }

    const mediaState = state.media;
    for (const file of plan.media) {
      const item = mediaState[file.id] || {};
      if (item.status === 'ready' && item.mediaId) continue;
      if (item.status === 'skipped') continue;
      try {
        await uploadChunkedMedia(env, file, item, async () => {
          mediaState[file.id] = item;
          await saveState(env, job, state);
        });
        mediaState[file.id] = item;
      } catch (error) {
        if (error instanceof XApiError && error.retryable) throw error;
        item.status = 'skipped';
        item.error = String(error.message || error);
        mediaState[file.id] = item;
        await saveState(env, job, state);
      }
    }

    let previousTweetId = '';
    for (const value of Object.values(state.published)) {
      if (value && value !== 'skipped') previousTweetId = value;
    }

    for (let index = 0; index < plan.units.length; index += 1) {
      const unit = plan.units[index];
      const published = state.published[index];
      if (published && published !== 'skipped') {
        previousTweetId = published;
        continue;
      }
      const mediaIds = unit.files
        .map((file) => mediaState[file.id])
        .filter((item) => item?.status === 'ready' && item.mediaId)
        .map((item) => item.mediaId);
      if (!unit.text && !mediaIds.length) {
        state.published[index] = 'skipped';
        await saveState(env, job, state);
        continue;
      }
      const request = {
        text: unit.text || '',
        ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
        ...(previousTweetId ? { reply: { in_reply_to_tweet_id: previousTweetId } } : {}),
      };
      const result = await xRequest(env, 'POST', '/2/tweets', { json: request });
      const tweetId = String(result.data?.id || result.id || '');
      if (!tweetId) throw new Error('X create post returned no id');
      state.published[index] = tweetId;
      previousTweetId = tweetId;
      await saveState(env, job, state);
    }

    await finishJob(env, id, 'completed');
  } catch (error) {
    if (error instanceof XApiError && !error.retryable) {
      await finishJob(env, id, 'dead', String(error.message || error));
      return;
    }
    const retryAfterMs = error instanceof XApiError && error.retryAfter
      ? error.retryAfter * 1000
      : 0;
    await retryJob(env, id, attempts, String(error.stack || error.message || error), retryAfterMs);
  }
}

async function cleanupJobs(env) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `DELETE FROM sync_jobs WHERE status IN ('completed', 'dead') AND updated_at < ?`,
  )
    .bind(cutoff)
    .run();
}

async function runDueJobs(env) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `SELECT id FROM sync_jobs
     WHERE status IN ('queued', 'retry') AND next_retry_at <= ?
     ORDER BY next_retry_at
     LIMIT 10`,
  )
    .bind(now)
    .all();
  for (const row of result.results || []) {
    await processJob(row.id, env);
  }
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleWebhook(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });
  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) return jsonResponse(415, { error: 'content_type_must_be_json' });
  const secret = env.MISSKEY_WEBHOOK_SECRET;
  if (!secret) return jsonResponse(500, { error: 'missing_webhook_secret' });

  const suppliedSecret = request.headers.get('X-Misskey-Hook-Secret') || '';
  const secretDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(suppliedSecret));
  const expectedDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  if (!constantTimeEqual(new Uint8Array(secretDigest), new Uint8Array(expectedDigest))) {
    return jsonResponse(401, { error: 'invalid_webhook_secret' });
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: 'request_body_too_large' });
  }

  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const decision = shouldSyncEnvelope(envelope, env.REQUIRED_TAG || 'to_x');
  if (decision.action === 'invalid_note') return jsonResponse(400, { error: 'invalid_note' });
  if (decision.action !== 'queue') return jsonResponse(202, { action: decision.action });
  const note = normalizeNote(decision.note);
  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(
    `INSERT INTO sync_jobs
       (id, status, attempts, note_json, state_json, next_retry_at, created_at, updated_at)
     VALUES (?, 'queued', 0, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
  )
    .bind(note.id, JSON.stringify(note), JSON.stringify({ published: {}, media: {} }), now, now, now)
    .first();

  if (!inserted) return jsonResponse(202, { action: 'duplicate' });
  ctx.waitUntil(processJob(note.id, env).catch(() => undefined));
  return jsonResponse(202, { action: 'queued', noteId: note.id });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return jsonResponse(200, { ok: true });
    }
    if (url.pathname === '/webhooks/misskey') {
      return handleWebhook(request, env, ctx);
    }
    return jsonResponse(404, { error: 'not_found' });
  },

  async scheduled(_event, env, _ctx) {
    await cleanupJobs(env);
    await runDueJobs(env);
  },
};

export const __testables = {
  oauthBaseString,
  sortedOAuthParameters,
  buildSyncPlan,
  groupImages,
  splitText,
  extractHashtags,
  normalizeMime,
  normalizeTag,
  weightedLength,
  constantTimeEqual,
  shouldSyncEnvelope,
};
