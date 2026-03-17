const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Tratamento de erros globais
process.on('uncaughtException', function(err) {
  console.error('ERRO NAO TRATADO:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', function(reason) {
  console.error('PROMISE REJEITADA:', reason);
});

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// Requisição HTTPS externa
function httpsGet(reqUrl) {
  return new Promise(function(resolve, reject) {
    https.get(reqUrl, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve(data); });
    }).on('error', function(e) { reject(e); });
  });
}

// Mapa de arquivos estáticos
const FILEMAP = {
  '/':              'hitssoud.html',
  '/hitssoud.html': 'hitssoud.html',
  '/style.css':     'style.css',
  '/i18n.js':       'i18n.js',
  '/manifest.json': 'manifest.json',
  '/sw.js':         'sw.js',
  '/icon-192.png':  'icon-192.png',
  '/icon-512.png':  'icon-512.png',
  '/favicon.ico':   'icon-192.png',
};

const server = http.createServer(function(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  console.log(req.method, pathname);

  // API: busca
  if (pathname === '/api/search') {
    const q      = parsed.query.q   || '';
    const apiKey = parsed.query.key || '';
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sem key' }));
      return;
    }
    const apiUrl = 'https://www.googleapis.com/youtube/v3/search'
      + '?part=snippet&type=video&maxResults=12'
      + '&q='   + encodeURIComponent(q)
      + '&key=' + encodeURIComponent(apiKey);
    httpsGet(apiUrl)
      .then(function(body) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      })
      .catch(function(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  // API: trending
  if (pathname === '/api/trending') {
    const apiKey = parsed.query.key || '';
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sem key' }));
      return;
    }
    const apiUrl = 'https://www.googleapis.com/youtube/v3/videos'
      + '?part=snippet&chart=mostPopular&videoCategoryId=10&maxResults=8&regionCode=BR'
      + '&key=' + encodeURIComponent(apiKey);
    httpsGet(apiUrl)
      .then(function(body) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      })
      .catch(function(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  // Arquivos estáticos
  const filename = FILEMAP[pathname];
  if (filename) {
    const filepath = path.join(__dirname, filename);
    const ext      = path.extname(filename);
    fs.readFile(filepath, function(err, data) {
      if (err) {
        console.error('Arquivo nao encontrado:', filepath);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('nao encontrado: ' + filename);
        return;
      }
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
      };
      if (filename === 'sw.js')         headers['Service-Worker-Allowed'] = '/';
      if (filename === 'manifest.json') headers['Cache-Control'] = 'no-cache';
      res.writeHead(200, headers);
      res.end(data);
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, function() {
  console.log('');
  console.log('  HitsSoud rodando na porta ' + PORT);
  console.log('');
});
