// Mock customer endpoints for end-to-end testing. Records every POST it
// receives to a JSON-lines file, and can be told to fail the first N hits on a
// path (to exercise the retry engine).
import http from 'node:http';
import fs from 'node:fs';

const LOG = process.env.RECV_LOG || '/tmp/claude-1003/-home-freelancer/2b139226-8eee-4ad5-be7c-6f7d63943910/scratchpad/recv.log';
fs.writeFileSync(LOG, '');
const failCounts = {}; // path -> remaining forced failures

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const rec = { path: req.url, at: new Date().toISOString(), auth: req.headers['authorization'] || null, ctype: req.headers['content-type'] || null, body: safeJson(body) };
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
    if ((failCounts[req.url] || 0) > 0) {
      failCounts[req.url]--;
      res.writeHead(503); res.end('temporarily down'); return;
    }
    res.writeHead(200); res.end('OK');
  });
});
function safeJson(s){ try { return JSON.parse(s); } catch { return s; } }

// Control channel: GET /_fail?path=/mo-a&n=2 sets forced failures.
const ctrl = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/_fail') { failCounts[u.searchParams.get('path')] = +u.searchParams.get('n'); res.end('ok'); return; }
  res.end('ctrl');
});

server.listen(8790, () => console.log('receiver on 8790'));
ctrl.listen(8791, () => console.log('ctrl on 8791'));
