// TIA tester: serves the test page and makes requests to a TIA deployment on its behalf, so
// checks work against self-signed certificates and without CORS. Only TIA's own paths can be
// requested, and the server listens on localhost unless HOST says otherwise.
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4300;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 1_000_000;

const ALLOWED_PATHS = [
  /^\/health$/,
  /^\/widget(\/[^/]*)?\/?$/,
  /^\/widget-loader\.js$/,
  /^\/api\/v1\/tia\/[\w\-/]+$/,
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// { baseUrl, path, method, body, insecure } -> { ok, status, ms, headers, body | text }
function probe({ baseUrl, path, method = 'GET', body, insecure = true }) {
  let url;
  try {
    url = new URL(path, baseUrl);
  } catch {
    return Promise.resolve({ ok: false, error: 'Invalid TIA URL' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return Promise.resolve({ ok: false, error: 'TIA URL must be http or https' });
  }
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(url.pathname))) {
    return Promise.resolve({ ok: false, error: `Path not allowed: ${url.pathname}` });
  }
  if (!['GET', 'POST'].includes(method)) {
    return Promise.resolve({ ok: false, error: `Method not allowed: ${method}` });
  }

  const payload = body === undefined ? null : JSON.stringify(body);
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const started = performance.now();

  return new Promise((resolve) => {
    const req = doRequest(
      url,
      {
        method,
        timeout: TIMEOUT_MS,
        rejectUnauthorized: !insecure,
        headers: {
          Accept: 'application/json, text/html, */*',
          ...(payload && {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const type = res.headers['content-type'] || '';
          let json;
          if (type.includes('json')) {
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            ms: Math.round(performance.now() - started),
            headers: {
              'content-type': type,
              'x-frame-options': res.headers['x-frame-options'] ?? null,
              'content-security-policy': res.headers['content-security-policy'] ?? null,
            },
            bytes: Buffer.byteLength(text),
            ...(json === undefined ? { text: text.slice(0, 4000) } : { body: json }),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`No answer within ${TIMEOUT_MS / 1000}s`)));
    req.on('error', (error) =>
      resolve({ ok: false, ms: Math.round(performance.now() - started), error: error.message }),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    send(res, 200, data, TYPES[extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/probe') {
      return send(res, 200, await probe(await readJson(req)));
    }
    if (req.method === 'GET') return await serveStatic(req, res);
    send(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`TIA tester running at http://${HOST}:${PORT}`);
});
