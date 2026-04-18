#!/usr/bin/env node
/**
 * GitHub push webhook listener.
 *
 * - Verifies the HMAC-SHA256 signature (X-Hub-Signature-256)
 * - Only reacts to `push` events on the configured branch
 * - Spawns deploy/update.sh with a fresh shell (detached from the request)
 *
 * Stdlib only — no npm deps needed on the VPS for this file.
 *
 * Env:
 *   WEBHOOK_PORT    (default 9000)
 *   WEBHOOK_SECRET  (required — shared with GitHub)
 *   WEBHOOK_BRANCH  (default claude/deploy-vercel-5TXlD)
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.resolve(__dirname, '..');

// Load deploy/.env without a dependency
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.WEBHOOK_PORT || 9000);
const SECRET = process.env.WEBHOOK_SECRET;
const BRANCH = process.env.WEBHOOK_BRANCH || 'claude/deploy-vercel-5TXlD';

if (!SECRET) {
  console.error('[webhook] WEBHOOK_SECRET is not set — refusing to start');
  process.exit(1);
}

function verify(sigHeader, body) {
  if (!sigHeader || !sigHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function runUpdate() {
  console.log('[webhook] triggering update.sh');
  const child = spawn('bash', [path.join(__dirname, 'update.sh')], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, APP_DIR },
  });
  child.unref();
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (req.method !== 'POST' || req.url !== '/__hooks/github') {
    res.writeHead(404);
    return res.end();
  }

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1_000_000) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    if (!verify(req.headers['x-hub-signature-256'], body)) {
      console.warn('[webhook] bad signature from', req.socket.remoteAddress);
      res.writeHead(401);
      return res.end('bad signature');
    }

    const event = req.headers['x-github-event'];
    if (event === 'ping') {
      res.writeHead(200);
      return res.end('pong');
    }
    if (event !== 'push') {
      res.writeHead(204);
      return res.end();
    }

    let payload;
    try { payload = JSON.parse(body.toString('utf8')); }
    catch { res.writeHead(400); return res.end('bad json'); }

    const ref = payload.ref || '';
    if (ref !== `refs/heads/${BRANCH}`) {
      console.log(`[webhook] ignoring push on ${ref} (watching ${BRANCH})`);
      res.writeHead(202);
      return res.end('ignored');
    }

    // Respond fast — GitHub times out at 10s
    res.writeHead(202, { 'content-type': 'text/plain' });
    res.end('accepted');
    runUpdate();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[webhook] listening on 127.0.0.1:${PORT} (branch=${BRANCH})`);
});
