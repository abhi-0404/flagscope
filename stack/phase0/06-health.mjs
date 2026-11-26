import { call, loadState } from './lib.mjs';
const st = loadState(); const auth = { apiKey: st.masterKey };
const p = await call('POST', `/api/v1/projects/${st.project}/feature-health/providers/`, { auth, body: { name: 'Grafana' }, save: 'feature-health-providers-create-grafana' });
console.log(p.status, JSON.stringify(p.json));
const l = await call('GET', `/api/v1/projects/${st.project}/feature-health/providers/`, { auth, save: 'feature-health-providers-list' });
console.log(JSON.stringify(l.json));
