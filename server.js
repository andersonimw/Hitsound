const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

function httpsGet(reqUrl) {
  return new Promise(function(resolve, reject) {
    https.get(reqUrl, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve(data); });
    }).on('error', function(e) { reject(e); });
  });
}

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (pathname === '/api/search') {
    var q   = parsed.query.q   || '';
    var key = parsed.query.key || '';
    if (!key) { res.writeHead(400); res.end(JSON.stringify({error:'sem key'})); return; }
    var apiUrl = 'https://www.googleapis.com/youtube/v3/search'
      + '?part=snippet&type=video&maxResults=12'
      + '&q=' + encodeURIComponent(q)
      + '&key=' + encodeURIComponent(key);
    httpsGet(apiUrl).then(function(body) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(body);
    }).catch(function(e) {
      res.writeHead(500);
      res.end(JSON.stringify({error: e.message}));
    });
    return;
  }

  if (pathname === '/api/trending') {
    var key = parsed.query.key || '';
    if (!key) { res.writeHead(400); res.end(JSON.stringify({error:'sem key'})); return; }
    var apiUrl = 'https://www.googleapis.com/youtube/v3/videos'
      + '?part=snippet&chart=mostPopular&videoCategoryId=10&maxResults=8&regionCode=BR'
      + '&key=' + encodeURIComponent(key);
    httpsGet(apiUrl).then(function(body) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(body);
    }).catch(function(e) {
      res.writeHead(500);
      res.end(JSON.stringify({error: e.message}));
    });
    return;
  }

  var filemap = {
    '/':              'hitssoud.html',
    '/hitssoud.html': 'hitssoud.html',
    '/manifest.json': 'manifest.json',
    '/sw.js':         'sw.js',
    '/icon-192.png':  'icon-192.png',
    '/icon-512.png':  'icon-512.png',
  };

  var filename = filemap[pathname];
  if (filename) {
    var ext = path.extname(filename);
    fs.readFile(path.join(__dirname, filename), function(err, data) {
      if (err) { res.writeHead(404); res.end('nao encontrado'); return; }
      res.setHeader('Content-Type', MIME[ext] || 'text/plain');
      if (filename === 'sw.js') res.setHeader('Service-Worker-Allowed', '/');
      if (filename === 'manifest.json') res.setHeader('Cache-Control', 'no-cache');
      res.writeHead(200);
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, function() {
  console.log('');
  console.log('  HitsSoud rodando!');
  console.log('  Abra no browser: http://localhost:' + PORT);
  console.log('');
});
