// Post a Grafana-style alert to the Feature Health provider webhook and read the resulting event.
import { call, loadState } from './lib.mjs';
const st = loadState(); const auth = { apiKey: st.masterKey };
const prov = await call('GET', `/api/v1/projects/${st.project}/feature-health/providers/`, { auth });
const url = new URL(prov.json[0].webhook_url);
const payload = { receiver: 'flagsmith', status: 'firing', alerts: [{ status: 'firing', labels: { alertname: 'FlagScope SRM', flagsmith_feature: 'paypal_button', flagsmith_environment: 'Development' }, annotations: { summary: 'Sample ratio mismatch' }, startsAt: new Date().toISOString(), fingerprint: 'srm-paypal-1', generatorURL: 'http://localhost:3000/alerting/grafana/srm/view', endsAt: '0001-01-01T00:00:00Z', dashboardURL: 'http://localhost:3000/d/flagscope-experiment-room' }], commonLabels: { flagsmith_feature: 'paypal_button', flagsmith_environment: 'Development' }, version: '1' };
const r = await call('POST', url.pathname, { body: payload });
console.log(r.status, JSON.stringify(r.json));
await new Promise((x) => setTimeout(x, 3000));
await call('GET', `/api/v1/projects/${st.project}/feature-health/events/`, { auth, save: 'feature-health-events-after-webhook' });
