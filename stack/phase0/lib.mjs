// Phase 0 helper: tiny fetch wrapper that records every response as a fixture.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..', '..');
export const genDir = path.join(root, 'stack', '.generated');
export const fixDir = path.join(root, 'plugin-fixtures');
export const BASE = process.env.FLAGSMITH_URL ?? 'http://localhost:8000';
fs.mkdirSync(genDir, { recursive: true });
fs.mkdirSync(fixDir, { recursive: true });

const statePath = path.join(genDir, 'state.json');
export const loadState = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {});
export const saveState = (s) => fs.writeFileSync(statePath, JSON.stringify(s, null, 2));

// auth: {token} | {apiKey} | {envKey} | none
export async function call(method, p, { body, auth, save, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth?.token) h.Authorization = `Token ${auth.token}`;
  if (auth?.apiKey) h.Authorization = `Api-Key ${auth.apiKey}`;
  if (auth?.envKey) h['X-Environment-Key'] = auth.envKey;
  const res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 500) }; }
  console.log(`${method} ${p} -> ${res.status}`);
  if (save) {
    // Never persist secrets in fixtures: redact obvious key fields.
    const redacted = JSON.parse(JSON.stringify(json ?? null), function (k, v) {
      if (typeof v !== 'string') return v;
      if (['key', 'token'].includes(k) && v.length > 20) return '<redacted>';
      return v.replace(/glsa_[A-Za-z0-9_]+/g, '<redacted>').replace(/[A-Za-z0-9]+.pbkdf2[^"]*/g, '<redacted>');
    });
    fs.writeFileSync(path.join(fixDir, `${save}.json`), JSON.stringify(redacted, null, 2) + '\n');
  }
  return { status: res.status, json };
}
