import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { call, loadState, saveState, genDir } from './lib.mjs';

const st = loadState();
const email = 'admin@flagscope.local';
const password = st.password ?? crypto.randomBytes(12).toString('base64url') + 'aA1!';
st.email = email; st.password = password;

const ver0 = await call('GET', '/version/', { save: 'version-before-bootstrap' });
console.log(ver0.json.self_hosted_data);

if (!st.token) {
  const r = await call('POST', '/api/v1/auth/users/', { body: { email, password, re_password: password, first_name: 'Flag', last_name: 'Scope', superuser: true }, save: 'auth-users-create' });
  if (r.status >= 300) console.log(JSON.stringify(r.json));
  const l = await call('POST', '/api/v1/auth/login/', { body: { email, password }, save: 'auth-login' });
  st.token = l.json.key;
}
const auth = { token: st.token };
const orgs = await call('GET', '/api/v1/organisations/', { auth, save: 'organisations-list-empty' });
if (!orgs.json.results.length) {
  const o = await call('POST', '/api/v1/organisations/', { auth, body: { name: 'FlagScope Org' }, save: 'organisations-create' });
  st.org = o.json.id;
} else st.org = orgs.json.results[0].id;
const pr = await call('GET', `/api/v1/projects/?organisation=${st.org}`, { auth });
let project = (pr.json.results ?? pr.json)[0];
if (!project) {
  const p = await call('POST', '/api/v1/projects/', { auth, body: { name: 'FlagScope Demo', organisation: st.org }, save: 'projects-create' });
  project = p.json;
}
st.project = project.id;
const envs = await call('GET', `/api/v1/environments/?project=${st.project}`, { auth, save: 'environments-list' });
let list = envs.json.results ?? envs.json;
console.log(list.map((e) => `${e.name} ${e.api_key} ${e.id}`));
if (!list.length) {
  for (const name of ['Development', 'Production']) await call('POST', '/api/v1/environments/', { auth, body: { name, project: st.project } });
  list = (await call('GET', `/api/v1/environments/?project=${st.project}`, { auth, save: 'environments-list' })).json.results;
}
const dev = list.find((e) => e.name === 'Development') ?? list[0];
st.envKey = dev.api_key; st.envId = dev.id;
// master API key
if (!st.masterKey) {
  const m = await call('POST', `/api/v1/organisations/${st.org}/master-api-keys/`, { auth, body: { name: 'flagscope-admin', is_admin: true }, save: 'master-api-keys-create' });
  st.masterKey = m.json.key;
}
saveState(st);
fs.writeFileSync(path.join(genDir, 'credentials.txt'), `Flagsmith UI: http://localhost:8000\nemail: ${st.email}\npassword: ${st.password}\nmaster api key: ${st.masterKey}\nenvironment key (Development): ${st.envKey}\nproject id: ${st.project}\norg id: ${st.org}\n`);
console.log('done; org', st.org, 'project', st.project, 'env', st.envKey);
