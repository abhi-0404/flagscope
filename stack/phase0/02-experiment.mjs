import { call, loadState, saveState } from './lib.mjs';
const st = loadState();
const auth = { apiKey: st.masterKey };
const E = `/api/v1/environments/${st.envKey}`;

const v = await call('GET', '/version/', { save: 'version' });
console.log('experimentation_enabled', v.json.experimentation_enabled);

// warehouse
let wh = await call('GET', `${E}/warehouse-connections/`, { auth, save: 'warehouse-connections-list-empty' });
if (!(wh.json.results ?? wh.json).length) {
  wh = await call('POST', `${E}/warehouse-connections/`, { auth, body: { warehouse_type: 'postgres', config: { source: 'flagsmith_database' } }, save: 'warehouse-connections-create' });
  console.log(JSON.stringify(wh.json));
}
const whl = await call('GET', `${E}/warehouse-connections/`, { auth, save: 'warehouse-connections-list' });
console.log(JSON.stringify(whl.json));

// MV feature
let feats = await call('GET', `/api/v1/projects/${st.project}/features/?environment=${st.envId}`, { auth });
let f = (feats.json.results).find((x) => x.name === 'paypal_button');
if (!f) {
  const c = await call('POST', `/api/v1/projects/${st.project}/features/`, { auth, save: 'features-create-mv', body: {
    name: 'paypal_button', type: 'MULTIVARIATE', default_enabled: true, initial_value: 'control',
    multivariate_options: [
      { type: 'unicode', string_value: 'variant_a', default_percentage_allocation: 0, key: 'variant_a' },
      { type: 'unicode', string_value: 'variant_b', default_percentage_allocation: 0, key: 'variant_b' },
    ] } });
  console.log(JSON.stringify(c.json).slice(0, 800));
  f = c.json;
}
st.feature = f.id; saveState(st);
const mv = await call('GET', `/api/v1/projects/${st.project}/features/${st.feature}/mv-options/`, { auth, save: 'mv-options-list' });
console.log(JSON.stringify(mv.json));
