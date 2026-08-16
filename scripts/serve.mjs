/* 零依赖静态服务器。浏览器闸门起的是它,file:// 下 ES 模块加载不了。 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

export function startServer(root, port) {
  const base = path.resolve(root);
  const server = http.createServer(function (req, res) {
    let rel = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(base, '.' + path.posix.normalize(rel));
    if (!file.startsWith(base)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403');
      return;
    }
    fs.readFile(file, function (err, buf) {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 ' + rel);
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      res.end(buf);
    });
  });
  return new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(port === undefined ? 0 : port, '127.0.0.1', function () {
      const addr = server.address();
      resolve({
        server: server,
        port: addr.port,
        url: 'http://127.0.0.1:' + addr.port,
        close: function () { return new Promise(function (done) { server.close(function () { done(null); }); }); }
      });
    });
  });
}

const here = url.fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here)) {
  const root = path.resolve(path.dirname(here), '..');
  const started = await startServer(root, Number(process.env.PORT || 8080));
  process.stdout.write('serving ' + root + ' at ' + started.url + '\n');
}
