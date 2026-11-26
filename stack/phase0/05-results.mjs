import { call, loadState } from './lib.mjs';
const st = loadState(); const auth = { apiKey: st.masterKey };
const X = `/api/v1/environments/${st.envKey}/experiments/${st.experiment}`;
const r1 = await call('POST', `${X}/results/refresh/`, { auth, save: 'experiments-results-refresh' });
console.log(JSON.stringify(r1.json));
const r2 = await call('POST', `${X}/exposures/refresh/`, { auth, save: 'experiments-exposures-refresh' });
console.log(JSON.stringify(r2.json));
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const r = await call('GET', `${X}/results/`, { auth });
  const e = await call('GET', `${X}/exposures/`, { auth });
  console.log(i, !!r.json?.results, !!e.json?.exposures);
  if (r.json?.results && e.json?.exposures) break;
}
await call('GET', `${X}/results/`, { auth, save: 'experiments-results' });
await call('GET', `${X}/exposures/`, { auth, save: 'experiments-exposures' });
await call('GET', `${X}/`, { auth, save: 'experiments-detail-running-with-data' });
await call('GET', `/api/v1/environments/${st.envKey}/warehouse-connections/`, { auth, save: 'warehouse-connections-list-after-events' });
