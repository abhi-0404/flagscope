import fs from 'node:fs';
import path from 'node:path';
import { call, loadState, genDir } from './lib.mjs';
const st = loadState(); const auth = { apiKey: st.masterKey };
const env = Object.fromEntries(fs.readFileSync(path.join(genDir, '..', '.env'), 'utf8').trim().split('\n').map((l) => l.split('=')));
const gb = 'Basic ' + Buffer.from('admin:' + env.GRAFANA_ADMIN_PASSWORD).toString('base64');
const g = async (m, p, body) => { const r = await fetch('http://localhost:3000' + p, { method: m, headers: { Authorization: gb, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); const t = await r.text(); console.log(m, p, r.status, t.slice(0, 300)); return t; };
const prov = await call('GET', `/api/v1/projects/${st.project}/feature-health/providers/`, { auth });
const url = new URL(prov.json[0].webhook_url);
const inner = `http://flagsmith:8000${url.pathname}`; // reachable from the Grafana container
await g('POST', '/api/v1/provisioning/contact-points', { name: 'flagsmith-feature-health', type: 'webhook', settings: { url: inner, httpMethod: 'POST' } });
// fire a test notification through the contact point with the Flagsmith labels
await g('POST', '/api/alertmanager/grafana/config/api/v1/receivers/test', { receivers: [{ name: 'flagsmith-feature-health', grafana_managed_receiver_configs: [{ name: 'flagsmith-feature-health', type: 'webhook', settings: { url: inner, httpMethod: 'POST' } }] }], alert: { annotations: { summary: 'FlagScope test' }, labels: { alertname: 'FlagScopeTest', flagsmith_feature: 'paypal_button', flagsmith_environment: 'Development' } } });
await new Promise((r) => setTimeout(r, 3000));
const ev = await call('GET', `/api/v1/projects/${st.project}/feature-health/events/`, { auth });
console.log(ev.json.map((e) => `${e.id} ${e.type} ${e.provider_name}`));
