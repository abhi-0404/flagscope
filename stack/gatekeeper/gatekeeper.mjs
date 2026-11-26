// FlagScope gatekeeper: a tiny allow-list reverse proxy in front of Flagsmith.
//
// Why: Grafana's data source proxy routes match by path PREFIX only, so a plugin route for /api/v1/projects/ also lets
// every Grafana Viewer read everything below it with the Flagsmith master key (identities, server-side keys, webhooks).
// The gatekeeper holds the master key instead of Grafana and forwards ONLY the exact method + path combinations the
// FlagScope plugin needs. Everything else answers 403 and never reaches Flagsmith.
//
// Zero dependencies (node:http only). Configuration (environment):
//   UPSTREAM_URL         Flagsmith base URL, default http://flagsmith:8000
//   MASTER_KEY           Flagsmith organisation master API key, OR
//   MASTER_KEY_FILE      path of a file holding the key (re-read when it changes; the stack bootstrap writes it)
//   PORT                 listen port, default 8080
//   HOST                 listen address, default 0.0.0.0
// Logs: method, path, status only. Keys and query values are never logged.
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENV_KEY = '[A-Za-z0-9_-]{8,64}';
const ID = '[0-9]{1,12}';
const DIGITS = /^[0-9]{1,12}$/;

/**
 * The complete allow-list. A request is forwarded only when its method matches, its normalised path matches the
 * regex exactly (trailing slash required) and every query parameter is listed in `query` with a matching value.
 * Keep it to what the plugin really calls: project features and environment feature states are deliberately NOT here
 * (they carry remote config values and feature owners' names and emails, and no FlagScope query type reads them).
 */
export const RULES = [
  { name: 'version', method: 'GET', path: new RegExp('^/version/$'), key: false, query: {} },
  { name: 'projects', method: 'GET', path: new RegExp('^/api/v1/projects/$'), key: true, query: { page: DIGITS } },
  { name: 'environments', method: 'GET', path: new RegExp('^/api/v1/environments/$'), key: true, query: { project: DIGITS, page: DIGITS } },
  { name: 'experiments', method: 'GET', path: new RegExp(`^/api/v1/environments/${ENV_KEY}/experiments/$`), key: true, query: { page: DIGITS } },
  { name: 'experiment', method: 'GET', path: new RegExp(`^/api/v1/environments/${ENV_KEY}/experiments/${ID}/$`), key: true, query: {} },
  { name: 'results', method: 'GET', path: new RegExp(`^/api/v1/environments/${ENV_KEY}/experiments/${ID}/results/$`), key: true, query: {} },
  { name: 'exposures', method: 'GET', path: new RegExp(`^/api/v1/environments/${ENV_KEY}/experiments/${ID}/exposures/$`), key: true, query: {} },
  { name: 'results-refresh', method: 'POST', path: new RegExp(`^/api/v1/environments/${ENV_KEY}/experiments/${ID}/results/refresh/$`), key: true, query: {} },
];

const MAX_URL_LENGTH = 512;
/** No route takes a body. A client that keeps streaming one past this many bytes gets its connection closed. */
export const MAX_BODY_BYTES = 16 * 1024;
/** A usable key is printable ASCII without spaces; anything else (for example a stray CR or LF) counts as no key. */
const KEY_SHAPE = /^[\x21-\x7e]{1,200}$/;

/**
 * Normalise and judge one request target (the raw `req.url`).
 * Returns { ok: true, rule, path, search } with the canonical upstream path and query string, or { ok: false, reason }.
 * Rejected outright: anything that is not an origin-form target, percent-encoding of any kind in the path (so no
 * encoded slashes, dots or NUL), backslashes, `//`, `.` and `..` segments, control or non-ASCII characters,
 * fragments, repeated or unknown query parameters, and query values that do not match the rule.
 */
export function judge(method, rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) return deny('bad target');
  if (!/^[\x21-\x7e]+$/.test(rawUrl)) return deny('bad characters'); // printable ASCII only, no spaces
  if (rawUrl[0] !== '/' || rawUrl.startsWith('//')) return deny('not origin-form');
  if (rawUrl.includes('#') || rawUrl.includes('\\')) return deny('bad characters');

  const q = rawUrl.indexOf('?');
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = q === -1 ? '' : rawUrl.slice(q + 1);

  if (path.includes('%') || path.includes(';')) return deny('encoded path');
  if (path.includes('//')) return deny('empty segment');
  if (path.split('/').some((s) => s === '.' || s === '..')) return deny('dot segment');

  const rule = RULES.find((r) => r.method === method && r.path.test(path));
  if (!rule) return deny('not allow-listed');

  const pairs = [];
  if (query !== '') {
    if (query.includes('%') || query.includes(';') || query.includes('+') || query.includes('?')) return deny('bad query');
    const seen = new Set();
    for (const part of query.split('&')) {
      const eq = part.indexOf('=');
      if (eq <= 0) return deny('bad query');
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      const check = Object.hasOwn(rule.query, k) ? rule.query[k] : undefined;
      if (!check || seen.has(k) || !check.test(v)) return deny('query not allowed');
      seen.add(k);
      pairs.push(`${k}=${v}`);
    }
  }
  return { ok: true, rule, path, search: pairs.length ? `?${pairs.join('&')}` : '' };
}

function deny(reason) {
  return { ok: false, reason };
}

/** Reads the master key from MASTER_KEY or MASTER_KEY_FILE (re-read whenever the file changes). */
export function makeKeySource({ key, file }) {
  let cached = '';
  let cachedStamp = '';
  return () => {
    if (key) return String(key).trim();
    if (!file) return '';
    try {
      const st = fs.statSync(file);
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamp !== cachedStamp) {
        cached = fs.readFileSync(file, 'utf8').trim();
        cachedStamp = stamp;
      }
      return cached;
    } catch {
      return '';
    }
  };
}

export function createServer({ upstream, getKey, log = defaultLog, timeoutMs = 30_000 }) {
  const base = new URL(upstream);
  const lib = base.protocol === 'https:' ? null : http;

  return http.createServer((req, res) => {
    const method = req.method ?? '';
    // The client body is never forwarded: drain it, but cut off a client that streams an endless one.
    let bodyBytes = 0;
    req.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) req.socket.destroy();
    });
    req.resume();

    if (method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }

    const verdict = judge(method, req.url);
    if (!verdict.ok) {
      log(method, safePath(req.url), 403);
      send(res, 403, { detail: 'Forbidden by the FlagScope gatekeeper.' });
      return;
    }

    const headers = { accept: 'application/json', 'user-agent': 'flagscope-gatekeeper' };
    if (verdict.rule.key) {
      const key = getKey();
      if (!key || !KEY_SHAPE.test(key)) {
        log(method, verdict.path, 503);
        send(res, 503, { detail: 'The gatekeeper has no Flagsmith key yet.' });
        return;
      }
      headers.authorization = `Api-Key ${key}`; // any client-sent Authorization was dropped: headers are built from scratch
    }
    if (method === 'POST') headers['content-length'] = '0';

    if (!lib) {
      log(method, verdict.path, 502);
      send(res, 502, { detail: 'https upstream is not supported, put a TLS terminator in front of Flagsmith.' });
      return;
    }
    let up;
    try {
      up = lib.request(
        { hostname: base.hostname, port: base.port || 80, method, path: base.pathname.replace(/\/+$/, '') + verdict.path + verdict.search, headers, timeout: timeoutMs },
        (upRes) => {
          const out = { 'content-type': upRes.headers['content-type'] ?? 'application/json' };
          res.writeHead(upRes.statusCode ?? 502, out);
          upRes.pipe(res);
          log(method, verdict.path, upRes.statusCode ?? 502);
        }
      );
    } catch {
      // A synchronous throw here must not take the whole proxy down, and the error (which can quote headers) is not logged.
      log(method, verdict.path, 502);
      send(res, 502, { detail: 'The gatekeeper could not build the upstream request.' });
      return;
    }
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', () => {
      if (!res.headersSent) {
        log(method, verdict.path, 502);
        send(res, 502, { detail: 'Flagsmith is unreachable from the gatekeeper.' });
      } else {
        res.destroy();
      }
    });
    up.end();
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** Log path only, never the query string (it can carry ids), and cap its length. */
function safePath(url) {
  return String(url ?? '').split('?')[0].replace(/[^\x21-\x7e]/g, '?').slice(0, 120);
}

function defaultLog(method, path, status) {
  console.log(`${new Date().toISOString()} ${method} ${path} ${status}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const upstream = process.env.UPSTREAM_URL ?? 'http://flagsmith:8000';
  const getKey = makeKeySource({ key: process.env.MASTER_KEY, file: process.env.MASTER_KEY_FILE });
  const port = Number(process.env.PORT ?? 8080);
  createServer({ upstream, getKey }).listen(port, process.env.HOST ?? '0.0.0.0', () => {
    console.log(`flagscope-gatekeeper listening on :${port}, upstream ${new URL(upstream).origin}, ${RULES.length} allow-listed routes`);
  });
}
