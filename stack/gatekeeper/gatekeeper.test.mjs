// Run: node --test stack/gatekeeper   (Node 22, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { judge, createServer, makeKeySource, RULES, MAX_BODY_BYTES, MAX_HOOK_BYTES, HOOK_PATH } from './gatekeeper.mjs';

const K = 'Rg3rZaBcDeFgHiJkLmNoPq'; // shaped like an environment API key
const EXP = `/api/v1/environments/${K}/experiments`;

const ALLOWED = [
  ['GET', '/version/'],
  ['GET', '/api/v1/projects/'],
  ['GET', '/api/v1/projects/?page=2'],
  ['GET', '/api/v1/environments/'],
  ['GET', '/api/v1/environments/?project=1'],
  ['GET', '/api/v1/environments/?project=12&page=3'],
  ['GET', `${EXP}/`],
  ['GET', `${EXP}/7/`],
  ['GET', `${EXP}/7/results/`],
  ['GET', `${EXP}/7/exposures/`],
  ['POST', `${EXP}/7/results/refresh/`],
];

const DENIED = [
  // wrong method on an allowed path
  ['POST', '/api/v1/projects/'],
  ['PUT', `${EXP}/7/`],
  ['PATCH', `${EXP}/7/`],
  ['DELETE', `${EXP}/7/`],
  ['POST', `${EXP}/7/`],
  ['POST', `${EXP}/`],
  ['GET', `${EXP}/7/results/refresh/`],
  ['POST', '/api/v1/environments/'],
  ['HEAD', '/version/'],
  ['OPTIONS', '/version/'],
  // paths the plugin never uses (secrets and PII live here)
  ['GET', '/api/v1/organisations/'],
  ['GET', '/api/v1/organisations/1/master-api-keys/'],
  ['GET', '/api/v1/users/'],
  ['GET', '/api/v1/projects/1/'],
  ['GET', '/api/v1/projects/1/feature-health/providers/'],
  // not used by any FlagScope query type: remote config values and feature owners (names, emails) live here
  ['GET', '/api/v1/projects/1/features/'],
  ['GET', '/api/v1/projects/1/features/?environment=2&search=paypal_button'],
  ['GET', `/api/v1/environments/${K}/featurestates/`],
  ['GET', `/api/v1/environments/${K}/featurestates/?feature=1`],
  ['GET', '/api/v1/projects/1/integrations/grafana/'],
  ['GET', `/api/v1/environments/${K}/`],
  ['GET', `/api/v1/environments/${K}/api-keys/`],
  ['GET', `/api/v1/environments/${K}/identities/`],
  ['GET', `/api/v1/environments/${K}/webhooks/`],
  ['GET', `/api/v1/environments/${K}/warehouse-connections/`],
  ['GET', `${EXP}/7/start/`],
  ['GET', `${EXP}/7/results/refresh`],
  ['GET', '/api/v1/swagger.json'],
  ['GET', '/'],
  ['GET', ''],
  // trailing slash is part of the contract
  ['GET', '/version'],
  ['GET', `${EXP}/7`],
  // traversal and path tricks
  ['GET', '/api/v1/environments/../organisations/'],
  ['GET', `${EXP}/../../../organisations/1/`],
  ['GET', `/api/v1/projects/./`],
  ['GET', '/api/v1/environments/%2e%2e/organisations/'],
  ['GET', '/api/v1/environments/%2E%2E/organisations/'],
  ['GET', `/api/v1/environments/${K}%2fapi-keys/`],
  ['GET', `/api/v1/environments/${K}%2Fapi-keys%2F`],
  ['GET', `/api/v1/environments/${K}%5capi-keys/`],
  ['GET', '/api/v1/projects/%00/'],
  ['GET', '/api/v1/projects%2F'],
  ['GET', '/api/v1/projects/%2e/'],
  ['GET', '//api/v1/projects/'],
  ['GET', '/api//v1/projects/'],
  ['GET', '/api/v1/projects/;x=1'],
  ['GET', '/api/v1/projects;/'],
  ['GET', '/api\\v1/projects/'],
  ['GET', 'http://evil.example/api/v1/projects/'],
  ['GET', 'api/v1/projects/'],
  ['GET', '/api/v1/projects/ '],
  ['GET', '/api/v1/projects/\n'],
  ['GET', '/api/v1/proéjects/'],
  ['GET', '/api/v1/projects/#x'],
  // experiment ids and keys must be exact
  ['GET', `${EXP}/abc/`],
  ['GET', `${EXP}/7abc/`],
  ['GET', `${EXP}/-1/`],
  ['GET', `${EXP}/7/results/x/`],
  ['GET', `/api/v1/environments/a/experiments/7/`],
  ['GET', `/api/v1/environments/${'a'.repeat(65)}/experiments/`],
  // query smuggling
  ['GET', '/api/v1/projects/?organisation=1'],
  ['GET', '/api/v1/projects/?page=2&page=3'],
  ['GET', '/api/v1/projects/?page=2&x=1'],
  ['GET', '/api/v1/projects/?page=x'],
  ['GET', '/api/v1/projects/?page=2;x=1'],
  ['GET', '/api/v1/projects/?page=%32'],
  ['GET', '/api/v1/projects/?page'],
  ['GET', '/api/v1/projects/?=2'],
  ['GET', '/api/v1/projects/?page=1&'],
  ['GET', '/api/v1/projects/??page=1'],
  ['GET', '/api/v1/projects/?__proto__=1'],
  ['GET', '/api/v1/projects/?constructor=1'],
  ['GET', '/api/v1/environments/?project=1%26page%3D2'],
  ['GET', '/api/v1/environments/?project=1/../..'],
  ['GET', `${EXP}/7/results/?refresh=true`],
  ['POST', `${EXP}/7/results/refresh/?x=1`],
  ['GET', `${EXP}/?page=1#frag`],
  ['GET', '/version/?x=1'],
  // case, trailing dots and other near misses of allowed paths
  ['GET', '/API/v1/projects/'],
  ['GET', '/api/V1/projects/'],
  ['GET', '/api/v1/Projects/'],
  ['GET', '/api/v1/projects./'],
  ['GET', '/api/v1/projects/.'],
  ['GET', '/version/.'],
  ['GET', '/version//'],
  ['GET', '/api/v1/projects/%252e%252e/'],
  ['GET', '/api/v1/projects/?page=1&&page=2'],
  ['GET', '/api/v1/projects/?page=1?page=2'],
  ['GET', '/api/v1/projects/?page=+1'],
  ['GET', '/api/v1/projects/?PAGE=1'],
  ['GET', `${EXP}/7/results/;refresh/`],
  ['GET', `/api/v1/environments/ser.${K}/experiments/`],
  // the Feature Health relay is not part of the plugin allow-list (it has its own handler, exact path, POST only)
  ['GET', '/hooks/feature-health'],
  ['POST', '/hooks/feature-health'],
  ['POST', '/hooks/feature-health/'],
  ['POST', '/api/v1/feature-health/abc/def'],
  ['GET', '/api/v1/feature-health/abc/def'],
  ['CONNECT', '/api/v1/projects/'],
  ['TRACE', '/version/'],
  // absurd length
  ['GET', `/api/v1/projects/?page=${'1'.repeat(600)}`],
];

test('allow-listed requests are accepted', () => {
  for (const [m, u] of ALLOWED) {
    const v = judge(m, u);
    assert.equal(v.ok, true, `${m} ${u} should be allowed (${v.reason})`);
  }
});

test('everything else is rejected', () => {
  for (const [m, u] of DENIED) {
    const v = judge(m, u);
    assert.equal(v.ok, false, `${m} ${JSON.stringify(u)} should be denied`);
  }
});

test('the only POST is the results refresh', () => {
  const posts = RULES.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].name, 'results-refresh');
  assert.ok(RULES.every((r) => r.method === 'GET' || r.method === 'POST'));
});

test('the canonical path and query are rebuilt from the parts that were validated', () => {
  const v = judge('GET', '/api/v1/environments/?page=2&project=3');
  assert.equal(v.path, '/api/v1/environments/');
  assert.equal(v.search, '?page=2&project=3');
});

test('/version/ is the only route that is forwarded without the key', () => {
  assert.deepEqual(RULES.filter((r) => !r.key).map((r) => r.name), ['version']);
});

// ---------- end to end against a fake Flagsmith ----------
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function call(port, method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withProxy(fn, { key = 'MASTERKEY123' } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sessionid=leak' }).end('{"ok":true}');
  });
  const upPort = await listen(upstream);
  const logs = [];
  const gate = createServer({ upstream: `http://127.0.0.1:${upPort}`, getKey: () => key, log: (...a) => logs.push(a.join(' ')) });
  const port = await listen(gate);
  try {
    await fn({ port, seen, logs });
  } finally {
    gate.close();
    upstream.close();
    gate.closeAllConnections?.();
    upstream.closeAllConnections?.();
  }
}

test('forwards an allowed call with the server-side key and drops the client Authorization', async () => {
  await withProxy(async ({ port, seen }) => {
    const r = await call(port, 'GET', '/api/v1/projects/?page=1', {
      authorization: 'Api-Key ATTACKERKEY',
      cookie: 'grafana_session=x',
      'x-forwarded-for': '1.2.3.4',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"ok":true}');
    assert.equal(r.headers['set-cookie'], undefined, 'upstream cookies are not passed back');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/api/v1/projects/?page=1');
    assert.equal(seen[0].headers.authorization, 'Api-Key MASTERKEY123');
    assert.equal(seen[0].headers.cookie, undefined);
    assert.equal(seen[0].headers['x-forwarded-for'], undefined);
  });
});

test('/version/ is forwarded without any Authorization header, even a client one', async () => {
  await withProxy(async ({ port, seen }) => {
    const r = await call(port, 'GET', '/version/', { authorization: 'Api-Key ATTACKERKEY' });
    assert.equal(r.status, 200);
    assert.equal(seen[0].headers.authorization, undefined);
  });
});

test('the refresh POST is forwarded without the client body', async () => {
  await withProxy(async ({ port, seen }) => {
    const r = await call(port, 'POST', `${EXP}/7/results/refresh/`, { 'content-type': 'application/json' }, '{"evil":1}');
    assert.equal(r.status, 200);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].headers['content-length'], '0');
  });
});

test('a disallowed request answers 403 and never reaches upstream', async () => {
  await withProxy(async ({ port, seen, logs }) => {
    for (const [m, u] of [
      ['GET', '/api/v1/organisations/1/master-api-keys/'],
      ['DELETE', `${EXP}/7/`],
      ['GET', '/api/v1/environments/%2e%2e/organisations/'],
      ['GET', '/api/v1/projects/?organisation=1'],
    ]) {
      const r = await call(port, m, u, { authorization: 'Api-Key ATTACKERKEY' });
      assert.equal(r.status, 403, `${m} ${u}`);
    }
    assert.equal(seen.length, 0);
    assert.equal(logs.length, 4);
    assert.ok(logs.every((l) => / 403$/.test(l)));
  });
});

test('logs carry method, path and status only, never a key or a query value', async () => {
  await withProxy(async ({ port, logs }) => {
    await call(port, 'GET', '/api/v1/environments/?project=77', { authorization: 'Api-Key ATTACKERKEY' });
    await call(port, 'GET', '/api/v1/users/?token=SECRETTOKEN', { authorization: 'Api-Key ATTACKERKEY' });
    const all = logs.join('\n');
    assert.match(all, /GET \/api\/v1\/environments\/ 200/);
    assert.match(all, /GET \/api\/v1\/users\/ 403/);
    for (const secret of ['MASTERKEY123', 'ATTACKERKEY', 'SECRETTOKEN', 'project=77']) {
      assert.ok(!all.includes(secret), `log must not contain ${secret}`);
    }
  });
});

test('answers 503 for key routes while no key is configured, but still serves /version/', async () => {
  await withProxy(
    async ({ port, seen }) => {
      assert.equal((await call(port, 'GET', '/api/v1/projects/')).status, 503);
      assert.equal((await call(port, 'GET', '/version/')).status, 200);
      assert.equal(seen.length, 1);
    },
    { key: '' }
  );
});

test('answers 502 when Flagsmith is down', async () => {
  const gate = createServer({ upstream: 'http://127.0.0.1:1', getKey: () => 'k', log: () => {} });
  const port = await listen(gate);
  try {
    assert.equal((await call(port, 'GET', '/version/')).status, 502);
  } finally {
    gate.close();
  }
});

test('the key file is read lazily and picked up when it changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-'));
  const file = path.join(dir, 'master-key');
  const get = makeKeySource({ file });
  assert.equal(get(), '');
  fs.writeFileSync(file, 'first-key\n');
  assert.equal(get(), 'first-key');
  fs.writeFileSync(file, 'second-key-longer\n');
  assert.equal(get(), 'second-key-longer');
  assert.equal(makeKeySource({ key: 'env-key', file })(), 'env-key');
  fs.rmSync(dir, { recursive: true });
});

// ---------- raw sockets, bodies, bad keys ----------
function rawExchange(port, text, waitMs = 300) {
  return new Promise((resolve) => {
    let data = '';
    const c = net.connect(port, '127.0.0.1', () => c.write(text));
    c.on('data', (d) => (data += d));
    c.on('error', () => {});
    setTimeout(() => {
      c.destroy();
      resolve(data.split('\r\n').filter((l) => l.startsWith('HTTP/')));
    }, waitMs);
  });
}

test('request smuggling: CL+TE is refused, duplicate Content-Length is refused, a pipelined disallowed request still gets 403', async () => {
  await withProxy(async ({ port, seen }) => {
    const refresh = `${EXP}/7/results/refresh/`;
    const smuggled = 'GET /api/v1/users/ HTTP/1.1\r\nHost: x\r\n\r\n';
    const both = await rawExchange(
      port,
      `POST ${refresh} HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n${smuggled}`
    );
    assert.deepEqual(both, ['HTTP/1.1 400 Bad Request']);
    const piped = await rawExchange(port, `POST ${refresh} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n${smuggled}`);
    assert.deepEqual(piped, ['HTTP/1.1 200 OK', 'HTTP/1.1 403 Forbidden']);
    const dupCl = await rawExchange(port, 'GET /version/ HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello');
    assert.deepEqual(dupCl, ['HTTP/1.1 400 Bad Request']);
    const lower = await rawExchange(port, 'get /version/ HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.deepEqual(lower, ['HTTP/1.1 400 Bad Request']);
    const absolute = await rawExchange(port, 'GET http://evil.example/api/v1/projects/ HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.deepEqual(absolute, ['HTTP/1.1 403 Forbidden']);
    // only the one legitimate refresh reached Flagsmith
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, refresh);
  });
});

test('Host, X-Forwarded-*, X-HTTP-Method-Override and URL-rewrite headers are not passed upstream', async () => {
  await withProxy(async ({ port, seen }) => {
    const r = await call(port, 'GET', '/api/v1/projects/', {
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      'x-http-method-override': 'DELETE',
      'x-original-url': '/api/v1/users/',
      'x-rewrite-url': '/api/v1/users/',
    });
    assert.equal(r.status, 200);
    const h = seen[0].headers;
    assert.match(h.host, /^127\.0\.0\.1:\d+$/);
    for (const name of ['x-forwarded-host', 'x-forwarded-proto', 'x-http-method-override', 'x-original-url', 'x-rewrite-url']) {
      assert.equal(h[name], undefined, name);
    }
    assert.equal(seen[0].method, 'GET');
  });
});

test('a client that streams an endless body is cut off', async () => {
  await withProxy(async ({ port, seen }) => {
    const limit = 4 * 1024 * 1024;
    const sentBeforeClose = await new Promise((resolve) => {
      let sent = 0;
      const c = net.connect(port, '127.0.0.1', () => {
        c.write('GET /api/v1/users/ HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n');
        const chunk = Buffer.alloc(4096, 97);
        const pump = () => {
          if (c.destroyed) return;
          if (sent > limit) {
            c.destroy();
            return resolve(sent);
          }
          sent += chunk.length;
          c.write(`${chunk.length.toString(16)}\r\n`);
          c.write(chunk);
          c.write('\r\n', () => setImmediate(pump));
        };
        pump();
      });
      c.on('error', () => {});
      c.on('close', () => resolve(sent));
    });
    assert.ok(sentBeforeClose <= limit, `connection still open after ${sentBeforeClose} bytes`);
    assert.ok(MAX_BODY_BYTES <= 64 * 1024);
    assert.equal(seen.length, 0);
  });
});

test('a malformed key (CR/LF inside) answers 503 instead of crashing the proxy or injecting a header', async () => {
  await withProxy(
    async ({ port, seen }) => {
      assert.equal((await call(port, 'GET', '/api/v1/projects/')).status, 503);
      assert.equal((await call(port, 'GET', '/version/')).status, 200, 'the proxy is still alive');
      assert.equal(seen.length, 1);
    },
    { key: 'abc\r\nX-Evil: 1' }
  );
});

test('MASTER_KEY from the environment is trimmed (a trailing CR from a CRLF .env file)', () => {
  assert.equal(makeKeySource({ key: 'env-key\r' })(), 'env-key');
});

test('the master key never appears in a response, even when upstream echoes request headers back', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'x-echo-auth': String(req.headers.authorization) }).end('{}');
  });
  const upPort = await listen(upstream);
  const gate = createServer({ upstream: `http://127.0.0.1:${upPort}`, getKey: () => 'MASTERKEY123', log: () => {} });
  const port = await listen(gate);
  try {
    const r = await call(port, 'GET', '/api/v1/projects/');
    assert.equal(r.status, 500);
    assert.ok(!JSON.stringify(r.headers).includes('MASTERKEY123'));
    assert.ok(!r.body.includes('MASTERKEY123'));
  } finally {
    gate.close();
    upstream.close();
    gate.closeAllConnections?.();
    upstream.closeAllConnections?.();
  }
});

// ---------- Feature Health relay: POST /hooks/feature-health ----------
const SECRET_PATH = '/api/v1/feature-health/WZWxsby/sEcReT-tOkEn_123';
const ALERT = JSON.stringify({ status: 'firing', alerts: [{ status: 'firing', labels: { flagsmith_feature: 'paypal_button' } }] });

async function withHook(fn, { hookPath = SECRET_PATH, status = 200 } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const logs = [];
  const gate = createServer({
    upstream: `http://127.0.0.1:${upPort}`,
    getKey: () => 'MASTERKEY123',
    getHookPath: () => hookPath,
    log: (...a) => logs.push(a.join(' ')),
  });
  const port = await listen(gate);
  try {
    await fn({ port, seen, logs });
  } finally {
    gate.close();
    upstream.close();
    gate.closeAllConnections?.();
    upstream.closeAllConnections?.();
  }
}

test('the hook relays the alert JSON to the secret Feature Health path, without any key or client header', async () => {
  await withHook(async ({ port, seen, logs }) => {
    const r = await call(port, 'POST', HOOK_PATH, { 'content-type': 'application/json', authorization: 'Bearer X', cookie: 'a=b' }, ALERT);
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, SECRET_PATH);
    assert.equal(seen[0].body, ALERT);
    assert.equal(seen[0].headers.authorization, undefined, 'neither the client nor the master key is sent');
    assert.equal(seen[0].headers.cookie, undefined);
    assert.equal(seen[0].headers['content-length'], String(Buffer.byteLength(ALERT)));
    assert.deepEqual(logs, [`POST ${HOOK_PATH} 200`]);
    assert.ok(!logs.join('').includes('sEcReT'), 'the secret path is never logged');
    assert.ok(!JSON.stringify(r).includes('sEcReT'));
  });
});

test('the hook passes the upstream status through (Flagsmith 400 for a malformed payload)', async () => {
  await withHook(async ({ port }) => {
    assert.equal((await call(port, 'POST', HOOK_PATH, { 'content-type': 'application/json; charset=utf-8' }, '{}')).status, 400);
  }, { status: 400 });
});

test('the hook needs JSON, an exact path and a valid configured target', async () => {
  await withHook(async ({ port, seen }) => {
    assert.equal((await call(port, 'POST', HOOK_PATH, { 'content-type': 'text/plain' }, ALERT)).status, 415);
    assert.equal((await call(port, 'POST', HOOK_PATH, {}, ALERT)).status, 415);
    assert.equal((await call(port, 'POST', `${HOOK_PATH}?x=1`, { 'content-type': 'application/json' }, ALERT)).status, 403);
    assert.equal((await call(port, 'GET', HOOK_PATH)).status, 403);
    assert.equal((await call(port, 'PUT', HOOK_PATH, { 'content-type': 'application/json' }, ALERT)).status, 403);
    assert.equal(seen.length, 0);
  });
  for (const bad of ['', '/api/v1/projects/1/', '/api/v1/feature-health/a/b/../../../x', '/api/v1/feature-health/a/b?x=1', 'http://evil.example/x']) {
    await withHook(async ({ port, seen }) => {
      assert.equal((await call(port, 'POST', HOOK_PATH, { 'content-type': 'application/json' }, ALERT)).status, 503, bad);
      assert.equal(seen.length, 0);
    }, { hookPath: bad });
  }
});

test('the hook cuts off a body over the limit and never reaches upstream', async () => {
  await withHook(async ({ port, seen }) => {
    const big = JSON.stringify({ pad: 'x'.repeat(MAX_HOOK_BYTES + 1024) });
    await assert.rejects(call(port, 'POST', HOOK_PATH, { 'content-type': 'application/json' }, big));
    assert.equal(seen.length, 0);
    const ok = await call(port, 'POST', HOOK_PATH, { 'content-type': 'application/json' }, ALERT);
    assert.equal(ok.status, 200, 'the proxy is still alive');
  });
});

test('the hook feature health target is read from a file when it changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-hook-'));
  const file = path.join(dir, 'feature-health-path');
  const get = makeKeySource({ file });
  assert.equal(get(), '');
  fs.writeFileSync(file, `${SECRET_PATH}
`);
  assert.equal(get(), SECRET_PATH);
  fs.rmSync(dir, { recursive: true });
});
