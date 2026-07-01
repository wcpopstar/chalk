const https = require('node:https');

function isYouTubeUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const patterns = [
    /https?:\/\/(?:www\.)?(?:youtube\.com|m\.youtube\.com|youtu\.be)\/.*?/i,
  ];
  const matched = patterns.some((pattern) => pattern.test(trimmed));
  if (!matched) return null;

  const url = new URL(trimmed);
  const videoId = url.searchParams.get('v');
  if (videoId) return { type: 'youtube', videoId, url: trimmed };

  const shortPath = url.pathname.replace(/^\//, '');
  if (shortPath && !shortPath.includes('/')) return { type: 'youtube', videoId: shortPath, url: trimmed };
  return null;
}

function getYouTubePreviewData(url) {
  const parsed = isYouTubeUrl(url);
  if (!parsed) return Promise.resolve(null);

  const thumb = `https://img.youtube.com/vi/${parsed.videoId}/hqdefault.jpg`;
  const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(parsed.url)}&format=json`;

  return new Promise((resolve) => {
    const req = https.get(oEmbedUrl, { headers: { 'User-Agent': 'chalk-app' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data);
            resolve({
              type: 'youtube',
              videoId: parsed.videoId,
              url: parsed.url,
              thumbnail: json.thumbnail_url || thumb,
              title: json.title || 'YouTube video',
            });
            return;
          } catch (_) {}
        }
        resolve({
          type: 'youtube',
          videoId: parsed.videoId,
          url: parsed.url,
          thumbnail: thumb,
          title: 'YouTube video',
        });
      });
    });

    req.on('error', () => {
      resolve({
        type: 'youtube',
        videoId: parsed.videoId,
        url: parsed.url,
        thumbnail: thumb,
        title: 'YouTube video',
      });
    });
  });
}

module.exports = { isYouTubeUrl, getYouTubePreviewData };
