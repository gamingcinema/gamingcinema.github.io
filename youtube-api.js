// Gaming Cinema - YouTube Data API v3 helper
// Public read-only API; key is HTTP-referrer restricted to gamingcinema.github.io
(function () {
  'use strict';
  var API_KEY = 'AIzaSyA4MuyPi2LYvEq_FB2yVIqJdV7sdX3zoZc';
  var CHANNEL_ID = 'UCFJ7QojEjNQKIW0_hAQjxng';
  var BASE = 'https://www.googleapis.com/youtube/v3';

  // Cache TTLs (ms) — minimize API quota use
  var TTL = {
    channelStats: 1 * 60 * 60 * 1000,   // 1h
    viewCounts:   6 * 60 * 60 * 1000,   // 6h
    shorts:      12 * 60 * 60 * 1000,   // 12h
    uploads:      3 * 60 * 60 * 1000,   // 3h
    playlists:   24 * 60 * 60 * 1000    // 24h
  };

  function cacheGet(key) {
    try {
      var raw = localStorage.getItem('gc_yt_' + key);
      if (!raw) return null;
      var item = JSON.parse(raw);
      if (Date.now() - item.t > item.ttl) return null;
      return item.v;
    } catch (e) { return null; }
  }
  function cacheSet(key, value, ttl) {
    try {
      localStorage.setItem('gc_yt_' + key,
        JSON.stringify({ t: Date.now(), ttl: ttl, v: value }));
    } catch (e) {}
  }
  function call(path, params) {
    var url = new URL(BASE + path);
    Object.keys(params).forEach(function (k) {
      url.searchParams.set(k, params[k]);
    });
    url.searchParams.set('key', API_KEY);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('YouTube API ' + r.status);
      return r.json();
    });
  }

  function getChannelStats() {
    var cached = cacheGet('channelStats');
    if (cached) return Promise.resolve(cached);
    return call('/channels', { part: 'snippet,statistics', id: CHANNEL_ID })
      .then(function (data) {
        var c = data.items && data.items[0];
        if (!c) return null;
        var s = {
          title: c.snippet.title,
          description: c.snippet.description || '',
          thumbnail: (c.snippet.thumbnails && c.snippet.thumbnails.default && c.snippet.thumbnails.default.url) || '',
          subscribers: parseInt(c.statistics.subscriberCount, 10) || 0,
          views: parseInt(c.statistics.viewCount, 10) || 0,
          videoCount: parseInt(c.statistics.videoCount, 10) || 0
        };
        cacheSet('channelStats', s, TTL.channelStats);
        return s;
      });
  }

  function getVideoStats(videoIds) {
    if (!videoIds || !videoIds.length) return Promise.resolve({});
    var cached = cacheGet('viewCounts') || {};
    var missing = videoIds.filter(function (id) { return !cached[id]; });
    if (!missing.length) {
      var out = {};
      videoIds.forEach(function (id) { out[id] = cached[id]; });
      return Promise.resolve(out);
    }
    // Batch up to 50 per call
    var batches = [];
    for (var i = 0; i < missing.length; i += 50) {
      batches.push(missing.slice(i, i + 50));
    }
    return Promise.all(batches.map(function (batch) {
      return call('/videos', { part: 'statistics,contentDetails', id: batch.join(',') });
    })).then(function (results) {
      results.forEach(function (data) {
        (data.items || []).forEach(function (v) {
          cached[v.id] = {
            views: parseInt(v.statistics.viewCount, 10) || 0,
            likes: parseInt(v.statistics.likeCount || 0, 10) || 0,
            duration: v.contentDetails.duration
          };
        });
      });
      cacheSet('viewCounts', cached, TTL.viewCounts);
      var out = {};
      videoIds.forEach(function (id) { out[id] = cached[id] || null; });
      return out;
    });
  }

  function getShorts(maxResults) {
    var cached = cacheGet('shorts');
    if (cached) return Promise.resolve(cached);
    return call('/search', {
      part: 'snippet',
      channelId: CHANNEL_ID,
      type: 'video',
      videoDuration: 'short',
      order: 'date',
      maxResults: maxResults || 8
    }).then(function (data) {
      var shorts = (data.items || []).map(function (v) {
        return {
          videoId: v.id.videoId,
          title: v.snippet.title,
          thumbnail: v.snippet.thumbnails && v.snippet.thumbnails.high && v.snippet.thumbnails.high.url,
          publishedAt: v.snippet.publishedAt
        };
      });
      // Filter to public-only
      return filterPublicIds(shorts.map(function (s) { return s.videoId; })).then(function (pub) {
        var publicShorts = shorts.filter(function (s) { return pub.has(s.videoId); });
        cacheSet('shorts', publicShorts, TTL.shorts);
        return publicShorts;
      });
    });
  }

  function getRecentUploads(maxResults) {
    var cached = cacheGet('uploads');
    if (cached) return Promise.resolve(cached);
    return call('/channels', { part: 'contentDetails', id: CHANNEL_ID })
      .then(function (data) {
        var pl = data.items && data.items[0] && data.items[0].contentDetails
                 && data.items[0].contentDetails.relatedPlaylists
                 && data.items[0].contentDetails.relatedPlaylists.uploads;
        if (!pl) return [];
        return call('/playlistItems', {
          part: 'snippet,contentDetails',
          playlistId: pl,
          maxResults: maxResults || 20
        });
      })
      .then(function (data) {
        if (!data || !data.items) return [];
        var ups = data.items.map(function (it) {
          return {
            videoId: it.contentDetails.videoId,
            title: it.snippet.title,
            thumbnail: it.snippet.thumbnails && it.snippet.thumbnails.high && it.snippet.thumbnails.high.url,
            publishedAt: it.contentDetails.videoPublishedAt
          };
        });
        // Filter to public-only (skip unlisted/private)
        return filterPublicIds(ups.map(function (u) { return u.videoId; })).then(function (pub) {
          var publicUps = ups.filter(function (u) { return pub.has(u.videoId); });
          cacheSet('uploads', publicUps, TTL.uploads);
          return publicUps;
        });
      });
  }

  function getPlaylists() {
    var cached = cacheGet('playlists');
    if (cached) return Promise.resolve(cached);
    return call('/playlists', {
      part: 'snippet',
      channelId: CHANNEL_ID,
      maxResults: 50
    }).then(function (data) {
      var pls = (data.items || []).map(function (p) {
        return { id: p.id, title: p.snippet.title };
      });
      cacheSet('playlists', pls, TTL.playlists);
      return pls;
    });
  }

  // Find a playlist whose title matches a series name (fuzzy)
  function findSeriesPlaylist(seriesName) {
    return getPlaylists().then(function (pls) {
      var q = seriesName.toLowerCase();
      // Exact match first
      var hit = pls.find(function (p) { return p.title.toLowerCase() === q; });
      if (hit) return hit;
      // Contains match
      hit = pls.find(function (p) { return p.title.toLowerCase().indexOf(q) >= 0; });
      return hit || null;
    });
  }


  // Batch fetch privacy status for video IDs, return Set of public ones
  function filterPublicIds(videoIds) {
    if (!videoIds || !videoIds.length) return Promise.resolve(new Set());
    var batches = [];
    for (var i = 0; i < videoIds.length; i += 50) {
      batches.push(videoIds.slice(i, i + 50));
    }
    return Promise.all(batches.map(function (b) {
      return call('/videos', { part: 'status', id: b.join(',') });
    })).then(function (results) {
      var pubSet = new Set();
      results.forEach(function (d) {
        (d.items || []).forEach(function (v) {
          if (v.status && v.status.privacyStatus === 'public') {
            pubSet.add(v.id);
          }
        });
      });
      return pubSet;
    });
  }

  function formatCount(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function utmYouTubeUrl(videoId, source, medium, campaign) {
    var u = new URL('https://www.youtube.com/watch');
    u.searchParams.set('v', videoId);
    u.searchParams.set('utm_source', source || 'gamingcinema_site');
    u.searchParams.set('utm_medium', medium || 'web');
    if (campaign) u.searchParams.set('utm_campaign', campaign);
    return u.toString();
  }

  window.GamingCinemaYT = {
    CHANNEL_ID: CHANNEL_ID,
    getChannelStats: getChannelStats,
    getVideoStats: getVideoStats,
    getShorts: getShorts,
    getRecentUploads: getRecentUploads,
    getPlaylists: getPlaylists,
    findSeriesPlaylist: findSeriesPlaylist,
    formatCount: formatCount,
    utmYouTubeUrl: utmYouTubeUrl
  };
})();
