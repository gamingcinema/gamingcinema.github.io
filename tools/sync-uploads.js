#!/usr/bin/env node
/**
 * Gaming Cinema — daily YouTube upload sync
 * Fetches recent uploads from the channel, identifies videos not yet in games.json,
 * and appends them as DRAFT entries (with TODO placeholders) for Fatih to review.
 *
 * Run: YT_API_KEY=xxx node tools/sync-uploads.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CHANNEL_ID = 'UCqDjRtMmffcFcCWLL_sNw7Q';
const API_KEY = process.env.YT_API_KEY;
const BASE = 'https://www.googleapis.com/youtube/v3';
const GAMES_PATH = path.join(__dirname, '..', 'games.json');

if (!API_KEY) {
  console.error('ERROR: YT_API_KEY env var required');
  process.exit(1);
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

function isoDurationToHMS(iso) {
  // PT1H23M45S -> 1:23:45
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const h = parseInt(m[1] || 0);
  const min = parseInt(m[2] || 0);
  const s = parseInt(m[3] || 0);
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

async function callApi(endpoint, params) {
  const url = new URL(BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('key', API_KEY);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`YouTube API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function getUploadsPlaylistId() {
  const data = await callApi('/channels', { part: 'contentDetails', id: CHANNEL_ID });
  return data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
}

async function getRecentVideos(playlistId, maxResults = 50) {
  const data = await callApi('/playlistItems', {
    part: 'snippet,contentDetails',
    playlistId,
    maxResults
  });
  return (data.items || []).map(it => ({
    videoId: it.contentDetails.videoId,
    title: it.snippet.title,
    description: it.snippet.description,
    publishedAt: it.contentDetails.videoPublishedAt
  }));
}

async function getVideoMeta(videoIds) {
  const out = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data = await callApi('/videos', { part: 'contentDetails,status', id: batch.join(',') });
    (data.items || []).forEach(v => {
      out[v.id] = {
        duration: isoDurationToHMS(v.contentDetails.duration),
        privacy: v.status.privacyStatus  // 'public' | 'unlisted' | 'private'
      };
    });
  }
  return out;
}

function getExistingVideoIds(games) {
  const ids = new Set();
  games.forEach(g => (g.videos || []).forEach(v => ids.add(v.id)));
  return ids;
}

function buildDraftEntry(video, duration) {
  const slug = slugify(video.title);
  const year = new Date(video.publishedAt).getFullYear();
  return {
    slug: `TODO-${slug}`,
    title: video.title,
    year,
    developer: 'TODO',
    publisher: 'TODO',
    series: null,
    genre: ['TODO'],
    tags: [],
    ageRestricted: false,
    videos: [{ label: 'Full Walkthrough', id: video.videoId, duration }],
    story: `TODO: Write comprehensive story for ${video.title}.\n\nVideo published: ${video.publishedAt.slice(0, 10)}\n\nDescription excerpt:\n${(video.description || '').substring(0, 500)}`,
    _autoSync: { addedAt: new Date().toISOString(), source: 'youtube-data-api' }
  };
}

async function main() {
  console.log('Loading games.json...');
  const games = JSON.parse(fs.readFileSync(GAMES_PATH, 'utf8'));
  const existing = getExistingVideoIds(games);
  console.log(`  ${games.length} existing entries, ${existing.size} known video IDs`);

  console.log('Fetching channel uploads playlist...');
  const playlistId = await getUploadsPlaylistId();
  if (!playlistId) {
    console.error('Could not find uploads playlist');
    process.exit(1);
  }

  console.log('Fetching recent uploads...');
  const recent = await getRecentVideos(playlistId, 50);
  console.log(`  ${recent.length} videos in playlist`);

  const newVideos = recent.filter(v => !existing.has(v.videoId));
  console.log(`  ${newVideos.length} NEW (not in games.json)`);

  if (!newVideos.length) {
    console.log('Nothing to sync. Exiting.');
    process.exit(0);
  }

  console.log('Fetching video metadata (duration + privacy status)...');
  const meta = await getVideoMeta(newVideos.map(v => v.videoId));

  // Filter to public-only — skip unlisted and private
  const publicVideos = newVideos.filter(v => meta[v.videoId]?.privacy === 'public');
  const skipped = newVideos.length - publicVideos.length;
  if (skipped > 0) {
    console.log(`  Skipped ${skipped} non-public video(s) (unlisted/private)`);
    newVideos.filter(v => meta[v.videoId]?.privacy !== 'public').forEach(v => {
      console.log(`    SKIP: ${v.title} (${meta[v.videoId]?.privacy || 'unknown'})`);
    });
  }
  if (!publicVideos.length) {
    console.log('No new PUBLIC videos to sync. Exiting.');
    process.exit(0);
  }

  console.log('Building draft entries for public videos...');
  const drafts = publicVideos.map(v => buildDraftEntry(v, meta[v.videoId]?.duration || ''));
  drafts.forEach(d => {
    console.log(`  + ${d.slug} (${d.title})`);
  });

  games.push(...drafts);
  fs.writeFileSync(GAMES_PATH, JSON.stringify(games, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${games.length} total entries to games.json`);
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
