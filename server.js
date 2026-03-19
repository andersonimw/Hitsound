const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

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

app.listen(PORT, function() {
  console.log('HitsSoud rodando na porta ' + PORT);
});
