import fs from 'node:fs';
import path from 'node:path';
import { call, loadState, saveState, genDir } from './lib.mjs';
const st = loadState(); const auth = { apiKey: st.masterKey };
const env = Object.fromEntries(fs.readFileSync(path.join(genDir, '..', '.env'), 'utf8').trim().split('\n').map((l) => l.split('=')));
const G = 'http://localhost:3000';
const gb = 'Basic ' + Buffer.from('admin:' + env.GRAFANA_ADMIN_PASSWORD).toString('base64');
const g = async (m, p, body) => { const r = await fetch(G + p, { method: m, headers: { Authorization: gb, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); const t = await r.text(); console.log(m, p, r.status); try { return JSON.parse(t); } catch { return t; } };
if (!st.grafanaToken) {
  const sa = await g('POST', '/api/serviceaccounts', { name: 'flagsmith', role: 'Editor' });
  const tk = await g('POST', `/api/serviceaccounts/${sa.id}/tokens`, { name: 'flagsmith-annotations' });
  st.grafanaToken = tk.key; saveState(st);
}
const E = `/api/v1/projects/${st.project}/integrations/grafana/`;
const ex = await call('GET', E, { auth });
if (!ex.json.length) {
  const r = await call('POST', E, { auth, body: { base_url: 'http://grafana.flagscope.local:3000', api_key: st.grafanaToken }, save: 'integrations-grafana-project-create' });
  console.log(r.status, JSON.stringify(r.json).replace(st.grafanaToken, '<redacted>'));
}
// toggle the flag to trigger an annotation
const fs0 = (await call('GET', `/api/v1/environments/${st.envKey}/featurestates/?feature=${st.feature}`, { auth })).json.results[0];
console.log('featurestate', fs0.id, fs0.enabled);
const up = await call('PATCH', `/api/v1/environments/${st.envKey}/featurestates/${fs0.id}/`, { auth, body: { enabled: !fs0.enabled } });
console.log(up.status);
await new Promise((r) => setTimeout(r, 8000));
const an = await g('GET', '/api/annotations?limit=5');
console.log(JSON.stringify(an).slice(0, 600));
fs.writeFileSync(path.join('..', '..', 'plugin-fixtures', 'grafana-annotations-after-flag-change.json'), JSON.stringify(an, null, 2) + '\n');
// restore
await call('PATCH', `/api/v1/environments/${st.envKey}/featurestates/${fs0.id}/`, { auth, body: { enabled: fs0.enabled } });
