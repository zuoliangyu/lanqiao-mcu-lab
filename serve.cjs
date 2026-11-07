// SPDX-License-Identifier: MIT
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, 'site'), port = Number(process.env.PORT || 8128);
http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  const file = path.resolve(root, '.' + (url.endsWith('/') ? url + 'index.html' : url));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };
  fs.readFile(file, (error, body) => { if (error) { res.writeHead(404).end('Not found'); return; } res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body); });
}).listen(port, '127.0.0.1', () => console.log(`蓝桥杯单片机实验台：http://127.0.0.1:${port}`));
