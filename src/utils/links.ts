import type { IncomingMessage } from 'node:http';

export interface YouTubeLink {
  type: 'youtube';
  videoId: string;
  url: string;
}

export interface YouTubePreview extends YouTubeLink {
  thumbnail: string;
  title: string;
}

import https from 'node:https';
import loggerBase from './logger';
const logger = loggerBase.child({ module: 'links' });

function isYouTubeUrl(value: unknown): YouTubeLink | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();

  // Extract just the URL portion instead of assuming the whole string is a URL —
  // messages often contain extra text/whitespace around a pasted link.
  const match = trimmed.match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/\S+/i);
  if (!match) return null;

  // Trim common trailing punctuation a user might have typed after the link.
  const candidate = (match[0] ?? '').replace(/[)\].,!?'"]+$/, '');

  let url;
  try {
    url = new URL(candidate);
  } catch (_) {
    return null;
  }

  const videoId = url.searchParams.get('v');
  if (videoId) return { type: 'youtube', videoId, url: candidate };

  const pathParts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (pathParts.length === 0) return null;

  // Shorts and live links look like /shorts/<id> or /live/<id>.
  if ((pathParts[0] === 'shorts' || pathParts[0] === 'live') && pathParts[1]) {
    return { type: 'youtube', videoId: pathParts[1], url: candidate };
  }

  // youtu.be/<id> style short links have just one path segment.
  if (pathParts.length === 1 && pathParts[0]) {
    return { type: 'youtube', videoId: pathParts[0], url: candidate };
  }

  return null;
}

function getYouTubePreviewData(url: unknown): Promise<YouTubePreview | null> {
  const parsed = isYouTubeUrl(url);
  if (!parsed) return Promise.resolve(null);

  const thumb = `https://img.youtube.com/vi/${parsed.videoId}/hqdefault.jpg`;
  const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(parsed.url)}&format=json`;

  return new Promise((resolve) => {
    const req = https.get(oEmbedUrl, { headers: { 'User-Agent': 'chalk-app' } }, (res: IncomingMessage) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
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
          } catch (err: any) {
            // Falls through to the generic-thumbnail/title fallback below —
            // this is graceful degradation, not a failure worth alerting
            // on, but worth knowing about if YouTube previews start
            // looking generic more often than expected.
            logger.debug({ err }, 'Failed to parse YouTube oEmbed response, using fallback preview');
          }
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

export { isYouTubeUrl, getYouTubePreviewData };
