import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __testables,
  extractHashtags,
  hasRequiredTag,
  normalizeMime,
  normalizeTag,
  shouldSyncEnvelope,
  splitText,
  weightedLength,
} from '../worker.js';

const {
  buildSyncPlan,
  groupImages,
  oauthBaseString,
  sortedOAuthParameters,
  constantTimeEqual,
} = __testables;

test('normalizes MIME values and tags', () => {
  assert.equal(normalizeMime('Image/JPEG; charset=binary'), 'image/jpeg');
  assert.equal(normalizeTag('#TO_X'), 'to_x');
});

test('extracts tags but ignores URL fragments', () => {
  assert.deepEqual(
    extractHashtags('hello #To_X and #no_to_x https://example.test/path#not_a_tag', ['Other_TAG']),
    ['other_tag', 'to_x', 'no_to_x'],
  );
});

test('requires only to_x and ignores no_to_x semantics', () => {
  assert.equal(hasRequiredTag({ text: 'hello #to_x' }), true);
  assert.equal(hasRequiredTag({ text: 'hello #no_to_x' }), false);
  assert.equal(hasRequiredTag({ text: 'hello #to_x #no_to_x' }), true);
});

test('filters non-post and invalid or reply or renote envelopes', () => {
  assert.equal(shouldSyncEnvelope({ type: 'follow', body: {} }).action, 'ignored_not_post');
  assert.equal(shouldSyncEnvelope({ type: 'note', body: { text: '#to_x' } }).action, 'invalid_note');
  assert.equal(
    shouldSyncEnvelope({ type: 'note', body: { id: '1', text: '#to_x', replyId: '2' } }).action,
    'ignored_reply_or_renote',
  );
  assert.equal(
    shouldSyncEnvelope({ type: 'note', body: { id: '1', text: '#to_x', renoteId: '2' } }).action,
    'ignored_reply_or_renote',
  );
  assert.equal(
    shouldSyncEnvelope({ type: 'note', body: { id: '1', text: 'hello' } }).action,
    'ignored_no_tag',
  );
  assert.equal(
    shouldSyncEnvelope({ type: 'note', body: { id: '1', text: '#to_x' } }).action,
    'queue',
  );
});

test('uses weighted text length for URLs and CJK', () => {
  assert.equal(weightedLength('abc'), 3);
  assert.equal(weightedLength('中'), 2);
  assert.equal(weightedLength('https://example.test/a/very/long/path'), 23);
});

test('splits long text without cutting URLs', () => {
  const url = 'https://example.test/this-is-a-long-path-that-must-stay-intact';
  const text = `${url} ${'中'.repeat(200)}`;
  const chunks = splitText(text, 280);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => weightedLength(chunk) <= 280));
  assert.ok(chunks.some((chunk) => chunk.includes(url)));
});

test('groups static images in fours and GIFs alone', () => {
  const files = [
    { id: 'a', type: 'image/png', url: 'https://files.test/a.png', size: 10 },
    { id: 'b', type: 'image/png', url: 'https://files.test/b.png', size: 10 },
    { id: 'g', type: 'image/gif', url: 'https://files.test/g.gif', size: 10 },
    { id: 'c', type: 'image/png', url: 'https://files.test/c.png', size: 10 },
  ];
  assert.deepEqual(groupImages(files).map((group) => group.map((file) => file.id)), [
    ['a', 'b'],
    ['g'],
    ['c'],
  ]);
});

test('builds text-first thread units with media groups', () => {
  const plan = buildSyncPlan({
    id: 'note-1',
    text: '#to_x ' + '中'.repeat(300),
    files: [
      { id: 'a', type: 'image/png', url: 'https://files.test/a.png', size: 10 },
      { id: 'b', type: 'image/png', url: 'https://files.test/b.png', size: 10 },
      { id: 'c', type: 'image/png', url: 'https://files.test/c.png', size: 10 },
      { id: 'd', type: 'image/png', url: 'https://files.test/d.png', size: 10 },
      { id: 'e', type: 'image/png', url: 'https://files.test/e.png', size: 10 },
    ],
  });
  assert.equal(plan.units[0].files.length, 4);
  assert.equal(plan.units.at(-1).files.length, 1);
  assert.equal(plan.units[0].text.includes('CW:'), false);
});

test('prepends content warning text', () => {
  const plan = buildSyncPlan({ id: 'note-2', cw: 'spoiler', text: '#to_x body', files: [] });
  assert.equal(plan.units[0].text, 'CW: spoiler\n\n#to_x body');
});

test('OAuth normalization sorts encoded parameters', () => {
  assert.equal(
    sortedOAuthParameters({ b: '2', a: '1', c: 'a b' }),
    'a=1&b=2&c=a%20b',
  );
  assert.equal(
    oauthBaseString('POST', 'https://api.x.com/2/tweets?b=2&a=1', {
      a: '1',
      b: '2',
      oauth_token: 'token',
    }),
    'POST&https%3A%2F%2Fapi.x.com%2F2%2Ftweets&a%3D1%26b%3D2%26oauth_token%3Dtoken',
  );
});

test('constant-time comparison handles mismatched values', () => {
  assert.equal(constantTimeEqual('same', 'same'), true);
  assert.equal(constantTimeEqual('same', 'different'), false);
  assert.equal(constantTimeEqual('', 'x'), false);
});
