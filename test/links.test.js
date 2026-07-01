const test = require('node:test');
const assert = require('node:assert/strict');
const { isYouTubeUrl, getYouTubePreviewData } = require('../src/utils/links');

test('detects youtube links and extracts video id', () => {
  const result = isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.deepEqual(result, {
    type: 'youtube',
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
});

test('returns preview data for supported youtube links', async () => {
  const result = await getYouTubePreviewData('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(result.type, 'youtube');
  assert.equal(result.videoId, 'dQw4w9WgXcQ');
  assert.ok(
    result.thumbnail.startsWith('https://img.youtube.com/vi/dQw4w9WgXcQ/') ||
    result.thumbnail.startsWith('https://i.ytimg.com/')
  );
});
