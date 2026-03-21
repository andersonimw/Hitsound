const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const LASTFM_KEY = process.env.LASTFM_API_KEY || "";

const YT_KEYS = [
  process.env.YOUTUBE_API_KEY,
  process.env.YOUTUBE_API_KEY2,
  process.env.YOUTUBE_API_KEY3,
  process.env.YOUTUBE_API_KEY4,
  process.env.YOUTUBE_API_KEY5,
  process.env.YOUTUBE_API_KEY6,
  process.env.YOUTUBE_API_KEY7,
  process.env.YOUTUBE_API_KEY8,
  process.env.YOUTUBE_API_KEY9,
  process.env.YOUTUBE_API_KEY10
].filter(Boolean);

let currentKey = 0;

function getKey() {
  return YT_KEYS[currentKey];
}

function rotateKey() {
  currentKey = (currentKey + 1) % YT_KEYS.length;
}

async function fetchYT(url) {
  for (let i = 0; i < YT_KEYS.length; i++) {
    const fullUrl = url + '&key=' + getKey();
    const r = await fetch(fullUrl);
    const data = await r.json();
    if (data.error && data.error.code === 403) {
      rotateKey();
      continue;
    }
    return data;
  }
  return { error: { message: 'Todas as cotas esgotadas.' } };
}

app.use(express.static(path.join(__dirname)));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'hitssoud.html'));
});

app.get('/api/search', async function(req, res) {
  try {
    const q = req.query.q;
    if (!q) return res.json({ items: [] });
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=50&q=${encodeURIComponent(q)}`;
    const data = await fetchYT(url);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trending', async function(req, res) {
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&videoCategoryId=10&regionCode=BR&maxResults=50`;
    const data = await fetchYT(url);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/lastfm-novidades', async function(req, res) {
  try {
    const genre = req.query.genre || 'brasil';
    const genreMap = {
      'brasil':        { method: 'geo.gettoptracks', country: 'brazil' },
      'internacional': { method: 'chart.gettoptracks' },
      'gospel':        { method: 'tag.gettoptracks', tag: 'christian music' },
      'sertanejo':     { method: 'tag.gettoptracks', tag: 'sertanejo' },
      'funk':          { method: 'tag.gettoptracks', tag: 'funk brasileiro' },
      'rap':           { method: 'tag.gettoptracks', tag: 'hip-hop' },
      'pagode':        { method: 'tag.gettoptracks', tag: 'pagode' },
      'rock':          { method: 'tag.gettoptracks', tag: 'rock' },
      'pop':           { method: 'tag.gettoptracks', tag: 'pop' },
    };
    const g = genreMap[genre] || genreMap['brasil'];
    var lastfmUrl = '';
    if (g.method === 'geo.gettoptracks') {
      lastfmUrl = `https://ws.audioscrobbler.com/2.0/?method=geo.gettoptracks&country=${g.country}&limit=15&api_key=${LASTFM_KEY}&format=json`;
    } else if (g.method === 'chart.gettoptracks') {
      lastfmUrl = `https://ws.audioscrobbler.com/2.0/?method=chart.gettoptracks&limit=15&api_key=${LASTFM_KEY}&format=json`;
    } else {
      lastfmUrl = `https://ws.audioscrobbler.com/2.0/?method=tag.gettoptracks&tag=${encodeURIComponent(g.tag)}&limit=15&api_key=${LASTFM_KEY}&format=json`;
    }
    const lfRes = await fetch(lastfmUrl);
    const lfData = await lfRes.json();
    var rawTracks = [];
    if (lfData.tracks && lfData.tracks.track) rawTracks = lfData.tracks.track;
    else if (lfData.toptracks && lfData.toptracks.track) rawTracks = lfData.toptracks.track;
    var results = [];
    for (var i = 0; i < Math.min(rawTracks.length, 15); i++) {
      var t = rawTracks[i];
      var artistName = t.artist && t.artist.name ? t.artist.name : (typeof t.artist === 'string' ? t.artist : '');
      var q = encodeURIComponent(artistName + ' ' + t.name);
      try {
        var ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${q}`;
        var ytData = await fetchYT(ytUrl);
        if (ytData.items && ytData.items.length > 0) {
          var it = ytData.items[0];
          results.push({ name: t.name, artist: artistName, ytId: it.id.videoId, thumb: it.snippet.thumbnails.medium.url });
        }
      } catch(e) {}
    }
    res.json({ items: results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/artist-videos', async function(req, res) {
  try {
    const artist = req.query.artist;
    if (!artist) return res.json({ items: [] });
    // Primeiro busca o canal oficial do artista
    const chUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(artist)}`;
    const chData = await fetchYT(chUrl);
    if(chData.items && chData.items.length > 0) {
      const channelId = chData.items[0].id.channelId;
      // Busca albuns e lancamentos recentes do canal oficial
      const vUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=6&channelId=${channelId}&q=album+lancamento+novo+clipe`;
      const vData = await fetchYT(vUrl);
      res.json(vData);
    } else {
      // Fallback: busca lancamentos por nome do artista
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=6&q=${encodeURIComponent(artist + ' album lancamento novo')}`;
      const data = await fetchYT(url);
      res.json(data);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reels', async function(req, res) {
  try {
    const artist = req.query.artist;
    if (!artist) return res.json({ items: [] });
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=6&videoDuration=short&q=${encodeURIComponent(artist + ' #shorts')}`;
    const data = await fetchYT(url);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, function() {
  console.log('HitsSoud rodando na porta ' + PORT);
});
