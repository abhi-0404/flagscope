import { call, loadState, saveState } from './lib.mjs';
const st = loadState(); const auth = { apiKey: st.masterKey };
const E = `/api/v1/environments/${st.envKey}`;
const ml = await call('GET', `${E}/experiment-metrics/`, { auth });
let m = (ml.json.results ?? ml.json).find((x) => x.name === 'checkout_completed');
if (!m) {
  const r = await call('POST', `${E}/experiment-metrics/`, { auth, save: 'experiment-metrics-create',
    body: { name: 'checkout_completed', aggregation: 'occurrence', direction: 'up', definition: { version: 1, event: 'checkout_completed' } } });
  console.log(JSON.stringify(r.json)); m = r.json;
}
st.metric = m.id;
await call('GET', `${E}/experiment-metrics/`, { auth, save: 'experiment-metrics-list' });
await call('GET', `${E}/metrics/`, { auth, save: 'metrics-list' });
const mv = (await call('GET', `/api/v1/projects/${st.project}/features/${st.feature}/mv-options/`, { auth })).json.results;
const el = await call('GET', `${E}/experiments/`, { auth, save: 'experiments-list-empty' });
let x = (el.json.results ?? el.json)[0];
if (!x) {
  const body = {
    feature: st.feature, name: 'PayPal button experiment', hypothesis: 'A more prominent PayPal button increases checkout completion',
    metrics: [{ metric: String(st.metric), expected_direction: 'increase' }],
    experiment_rollout: { enabled: true, rollout_percentage: 100,
      feature_state_value: { type: 'string', value: 'control' },
      multivariate_feature_state_values: mv.map((o) => ({ multivariate_feature_option: o.id, percentage_allocation: 33.3 })),
      audience: { match: 'any', segment_ids: [] } } };
  const r = await call('POST', `${E}/experiments/`, { auth, body, save: 'experiments-create' });
  console.log(JSON.stringify(r.json)); x = r.json;
}
st.experiment = x.id; saveState(st);
console.log('experiment', st.experiment, x.status);
