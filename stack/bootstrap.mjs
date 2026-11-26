// FlagScope bootstrap: zero dependencies (Node 22 native fetch), REST only, idempotent.
// Runs as the one-shot `bootstrap` compose service. Running it again changes nothing ("0 change(s)").
//
// Flagsmith: first user -> organisation -> project -> Development + Production -> warehouse -> master API key
//            -> multivariate flag -> metric -> experiment -> start.
// Gatekeeper: the master key goes into /generated/gatekeeper/master-key, read only by the gatekeeper container.
// Grafana:   service account + token -> FlagScope data source (points at the gatekeeper, holds NO Flagsmith key)
//            -> PostgreSQL data source (read-only role) -> Flagsmith Grafana integration -> Feature Health provider
//            -> Grafana contact point that posts to it. The Experiment Room dashboard is provisioned from files.
// Secrets live in /generated/state.json and /generated/credentials.txt (gitignored) and are never printed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FLAGSMITH = (process.env.FLAGSMITH_URL ?? 'http://flagsmith:8000').replace(/\/+$/, '');
const GRAFANA = (process.env.GRAFANA_URL ?? 'http://grafana:3000').replace(/\/+$/, '');
const GRAFANA_ADMIN_PASSWORD = required('GRAFANA_ADMIN_PASSWORD');
const GRAFANA_RO_PASSWORD = process.env.GRAFANA_RO_PASSWORD ?? 'flagscope-ro';
// The FlagScope data source talks to this allow-list proxy, which holds the Flagsmith master key (not Grafana).
const GATEKEEPER = (process.env.GATEKEEPER_URL ?? 'http://gatekeeper:8080').replace(/\/+$/, '');
const PUBLIC_FLAGSMITH = process.env.PUBLIC_FLAGSMITH_URL ?? 'http://localhost:8000';
const PUBLIC_GRAFANA = process.env.PUBLIC_GRAFANA_URL ?? 'http://localhost:3000';
const GEN = process.env.GENERATED_DIR ?? '/generated';
// How Flagsmith reaches Grafana (annotations). Needs a dot (Django URLValidator) and SSRF_ALLOWED_HOSTS in the compose file.
const GRAFANA_FOR_FLAGSMITH = 'http://grafana.flagscope.local:3000';
// How Grafana reaches Flagsmith (contact point) and Postgres (data source) inside the compose network.
const FLAGSMITH_FOR_GRAFANA = 'http://flagsmith:8000';
const POSTGRES_FOR_GRAFANA = 'postgres:5432';

const NAMES = {
  org: 'FlagScope Org',
  project: 'FlagScope Demo',
  envs: ['Development', 'Production'],
  feature: 'paypal_button',
  metric: 'checkout_completed',
  experiment: 'PayPal button experiment',
  masterKey: 'flagscope-admin',
  serviceAccount: 'flagsmith',
  contactPoint: 'flagsmith-feature-health',
};
const UID = { flagscope: 'flagscope', postgres: 'flagscope-postgres' };
const PLUGIN_ID = 'abhi0404-flagscope-datasource';
const SMOKE_VERSION_PATH = `/api/datasources/proxy/uid/${UID.flagscope}/flagsmith/version/`;

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[bootstrap] missing environment variable ${name}`);
    process.exit(2);
  }
  return v;
}

let changes = 0;
const log = (area, msg) => console.log(`[bootstrap] ${area}: ${msg}`);
const did = (area, msg) => {
  changes++;
  log(area, `${msg} (created or updated)`);
};
const ok = (area, msg) => log(area, `${msg} (already done)`);
const list = (json) => (Array.isArray(json) ? json : (json?.results ?? []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} -> ${status} ${String(body).slice(0, 200)}`);
    this.status = status;
  }
}

async function http(base, method, p, { body, auth, expect = [200, 201, 202, 204] } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth?.token) headers.Authorization = `Token ${auth.token}`;
  if (auth?.apiKey) headers.Authorization = `Api-Key ${auth.apiKey}`;
  if (auth?.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
  if (auth?.basic) headers.Authorization = `Basic ${Buffer.from(auth.basic).toString('base64')}`;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (expect !== 'any' && !expect.includes(res.status)) throw new HttpError(method, p, res.status, text);
  return { status: res.status, json };
}

async function waitFor(label, fn, tries = 60, delayMs = 2000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) {
      last = e;
    }
    await sleep(delayMs);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

// ---------- state (secrets), gitignored ----------
fs.mkdirSync(GEN, { recursive: true });
// Only this folder is mounted into the gatekeeper container, so it never sees the other credentials.
const gatekeeperDir = path.join(GEN, 'gatekeeper');
fs.mkdirSync(gatekeeperDir, { recursive: true });
const statePath = path.join(GEN, 'state.json');
const credsPath = path.join(GEN, 'credentials.txt');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};

function writeIfChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.writeFileSync(file, content, { mode: 0o600 });
  return true;
}
// `docker compose up --wait` waits for this marker (see the bootstrap healthcheck in docker-compose.yml).
const doneMarker = path.join(GEN, '.bootstrap-ok');
fs.rmSync(doneMarker, { force: true });
const saveState = () => writeIfChanged(statePath, JSON.stringify(state, null, 2) + '\n');

// ---------- Flagsmith ----------
const fs_ = (method, p, opts) => http(FLAGSMITH, method, p, opts);

async function bootstrapFlagsmith() {
  const version = (await waitFor('Flagsmith /version/', async () => (await fs_('GET', '/version/')).json)) ?? {};
  log('flagsmith', `version ${version.image_tag}, experimentation_enabled=${version.experimentation_enabled}`);
  if (!version.experimentation_enabled) throw new Error('Flagsmith has experimentation disabled (EXPERIMENTATION_ENABLED)');

  // 1. first user
  state.email ??= 'admin@flagscope.local';
  state.password ??= crypto.randomBytes(12).toString('base64url') + 'aA1!';
  const login = async () => {
    const r = await fs_('POST', '/api/v1/auth/login/', { body: { email: state.email, password: state.password }, expect: 'any' });
    return r.status === 200 ? r.json.key : null;
  };
  let token = await login();
  if (!token) {
    if (version.self_hosted_data?.has_users) {
      throw new Error(
        'Flagsmith already has users but the saved admin password does not work. Restore stack/.generated/state.json ' +
          'or wipe the data with `docker compose down -v`.'
      );
    }
    await fs_('POST', '/api/v1/auth/users/', {
      body: { email: state.email, password: state.password, re_password: state.password, first_name: 'Flag', last_name: 'Scope', superuser: true },
    });
    token = await login();
    if (!token) throw new Error('created the first user but login failed');
    did('flagsmith', `first user ${state.email}`);
  } else ok('flagsmith', `user ${state.email}`);
  const user = { token };

  // 2. organisation and project
  let org = list((await fs_('GET', '/api/v1/organisations/', { auth: user })).json)[0];
  if (!org) {
    org = (await fs_('POST', '/api/v1/organisations/', { auth: user, body: { name: NAMES.org } })).json;
    did('flagsmith', `organisation "${NAMES.org}"`);
  } else ok('flagsmith', `organisation "${org.name}"`);
  state.org = org.id;

  let project = list((await fs_('GET', `/api/v1/projects/?organisation=${org.id}`, { auth: user })).json)[0];
  if (!project) {
    project = (await fs_('POST', '/api/v1/projects/', { auth: user, body: { name: NAMES.project, organisation: org.id } })).json;
    did('flagsmith', `project "${NAMES.project}"`);
  } else ok('flagsmith', `project "${project.name}"`);
  state.project = project.id;

  // 3. environments
  const listEnvs = async () => list((await fs_('GET', `/api/v1/environments/?project=${project.id}`, { auth: user })).json);
  let envs = await listEnvs();
  for (const name of NAMES.envs) {
    if (!envs.some((e) => e.name === name)) {
      await fs_('POST', '/api/v1/environments/', { auth: user, body: { name, project: project.id } });
      did('flagsmith', `environment ${name}`);
    }
  }
  envs = await waitFor('environments', async () => {
    const e = await listEnvs();
    return NAMES.envs.every((n) => e.some((x) => x.name === n)) ? e : null;
  });
  const dev = envs.find((e) => e.name === 'Development');
  state.envKey = dev.api_key;
  state.envId = dev.id;
  state.prodKey = envs.find((e) => e.name === 'Production')?.api_key;
  ok('flagsmith', 'environments Development and Production');

  // 4. organisation master API key (the only credential the FlagScope data source holds)
  const keyWorks = async (k) => (await fs_('GET', `/api/v1/projects/`, { auth: { apiKey: k }, expect: 'any' })).status === 200;
  if (!(state.masterKey && (await keyWorks(state.masterKey)))) {
    const existing = list((await fs_('GET', `/api/v1/organisations/${org.id}/master-api-keys/`, { auth: user })).json);
    const name = existing.some((k) => k.name === NAMES.masterKey) ? `${NAMES.masterKey}-${Date.now().toString(36)}` : NAMES.masterKey;
    const created = (await fs_('POST', `/api/v1/organisations/${org.id}/master-api-keys/`, { auth: user, body: { name, is_admin: true } })).json;
    state.masterKey = created.key;
    did('flagsmith', `master API key "${name}"`);
  } else ok('flagsmith', 'master API key');
  if (writeIfChanged(path.join(gatekeeperDir, 'master-key'), state.masterKey + '\n')) did('gatekeeper', 'master key file written');
  else ok('gatekeeper', 'master key file');
  const api = { apiKey: state.masterKey };
  const E = `/api/v1/environments/${dev.api_key}`;
  const P = `/api/v1/projects/${project.id}`;

  // 5. warehouse (Flagsmith database) on Development
  const wh = list((await fs_('GET', `${E}/warehouse-connections/`, { auth: api })).json);
  if (!wh.length) {
    await fs_('POST', `${E}/warehouse-connections/`, { auth: api, body: { warehouse_type: 'postgres', config: { source: 'flagsmith_database' } } });
    did('flagsmith', 'warehouse connection (Flagsmith database, Development)');
  } else ok('flagsmith', `warehouse connection (${wh[0].status})`);

  // 6. multivariate flag. The option `key` is ignored on create and PATCH returns 500: PUT the full body instead.
  const findFeature = async () =>
    list((await fs_('GET', `${P}/features/?environment=${dev.id}&search=${NAMES.feature}`, { auth: api })).json).find((f) => f.name === NAMES.feature);
  let feature = await findFeature();
  if (!feature) {
    feature = (
      await fs_('POST', `${P}/features/`, {
        auth: api,
        body: {
          name: NAMES.feature,
          type: 'MULTIVARIATE',
          default_enabled: true,
          initial_value: 'control',
          multivariate_options: ['variant_a', 'variant_b'].map((v) => ({ type: 'unicode', string_value: v, default_percentage_allocation: 0, key: v })),
        },
      })
    ).json;
    did('flagsmith', `feature ${NAMES.feature} (multivariate)`);
  } else ok('flagsmith', `feature ${NAMES.feature}`);
  state.feature = feature.id;
  const options = list((await fs_('GET', `${P}/features/${feature.id}/mv-options/`, { auth: api })).json);
  for (const o of options.filter((x) => !x.key)) {
    await fs_('PUT', `${P}/features/${feature.id}/mv-options/${o.id}/`, {
      auth: api,
      body: { type: 'unicode', string_value: o.string_value, default_percentage_allocation: o.default_percentage_allocation ?? 0, key: o.string_value, feature: feature.id },
    });
    did('flagsmith', `variation key ${o.string_value}`);
  }

  // 7. metric
  let metric = list((await fs_('GET', `${E}/experiment-metrics/`, { auth: api })).json).find((m) => m.name === NAMES.metric);
  if (!metric) {
    metric = (
      await fs_('POST', `${E}/experiment-metrics/`, {
        auth: api,
        body: { name: NAMES.metric, aggregation: 'occurrence', direction: 'up', definition: { version: 1, event: NAMES.metric } },
      })
    ).json;
    did('flagsmith', `metric ${NAMES.metric}`);
  } else ok('flagsmith', `metric ${NAMES.metric}`);
  state.metric = metric.id;

  // 8. experiment, then start
  let experiment = list((await fs_('GET', `${E}/experiments/`, { auth: api })).json).find((x) => x.name === NAMES.experiment);
  if (!experiment) {
    const mv = list((await fs_('GET', `${P}/features/${feature.id}/mv-options/`, { auth: api })).json);
    experiment = (
      await fs_('POST', `${E}/experiments/`, {
        auth: api,
        body: {
          feature: feature.id,
          name: NAMES.experiment,
          hypothesis: 'A more prominent PayPal button increases checkout completion',
          metrics: [{ metric: String(metric.id), expected_direction: 'increase' }],
          experiment_rollout: {
            enabled: true,
            rollout_percentage: 100,
            feature_state_value: { type: 'string', value: 'control' },
            multivariate_feature_state_values: mv.map((o) => ({ multivariate_feature_option: o.id, percentage_allocation: 33.3 })),
            audience: { match: 'any', segment_ids: [] },
          },
        },
      })
    ).json;
    did('flagsmith', `experiment "${NAMES.experiment}"`);
  } else ok('flagsmith', `experiment "${NAMES.experiment}"`);
  state.experiment = experiment.id;
  const status = (await fs_('GET', `${E}/experiments/${experiment.id}/`, { auth: api })).json.status;
  if (status === 'created') {
    await fs_('POST', `${E}/experiments/${experiment.id}/start/`, { auth: api });
    did('flagsmith', 'experiment started');
  } else ok('flagsmith', `experiment status ${status}`);

  return { api, P };
}

// ---------- Grafana ----------
const gAdmin = { basic: `admin:${GRAFANA_ADMIN_PASSWORD}` };
const g = (method, p, opts = {}) => http(GRAFANA, method, p, { auth: gAdmin, ...opts });

async function ensureServiceAccountToken() {
  const found = (await g('GET', `/api/serviceaccounts/search?query=${NAMES.serviceAccount}`)).json?.serviceAccounts ?? [];
  let sa = found.find((s) => s.name === NAMES.serviceAccount);
  if (!sa) {
    sa = (await g('POST', '/api/serviceaccounts', { body: { name: NAMES.serviceAccount, role: 'Editor' } })).json;
    did('grafana', `service account ${NAMES.serviceAccount} (Editor)`);
  } else ok('grafana', `service account ${NAMES.serviceAccount}`);
  let rotated = false;
  const valid = state.grafanaToken && (await http(GRAFANA, 'GET', '/api/org', { auth: { bearer: state.grafanaToken }, expect: 'any' })).status === 200;
  if (!valid) {
    const tokens = (await g('GET', `/api/serviceaccounts/${sa.id}/tokens`)).json ?? [];
    const name = tokens.some((t) => t.name === 'flagsmith-annotations') ? `flagsmith-annotations-${Date.now().toString(36)}` : 'flagsmith-annotations';
    state.grafanaToken = (await g('POST', `/api/serviceaccounts/${sa.id}/tokens`, { body: { name } })).json.key;
    rotated = true;
    did('grafana', `service account token "${name}"`);
  } else ok('grafana', 'service account token');
  return rotated;
}

async function ensureDatasource(uid, wanted, { forceUpdate = false, dropSecureFields = [] } = {}) {
  let existing = await g('GET', `/api/datasources/uid/${uid}`, { expect: [200, 404] });
  if (existing.status === 200 && dropSecureFields.some((f) => existing.json.secureJsonFields?.[f])) {
    // Grafana keeps old secure fields on update, so remove the data source and create it again without them.
    await g('DELETE', `/api/datasources/uid/${uid}`);
    did('grafana', `data source "${wanted.name}": removed the stored ${dropSecureFields.join(', ')}`);
    existing = { status: 404 };
  }
  if (existing.status === 404) {
    await g('POST', '/api/datasources', { body: { uid, access: 'proxy', isDefault: false, ...wanted } });
    did('grafana', `data source "${wanted.name}"`);
    return;
  }
  const cur = existing.json;
  const drift = forceUpdate || Object.entries(wanted.jsonData ?? {}).some(([k, v]) => cur.jsonData?.[k] !== v) || cur.name !== wanted.name || (wanted.url ?? '') !== (cur.url ?? '') || (wanted.user ?? '') !== (cur.user ?? '');
  if (drift) {
    await g('PUT', `/api/datasources/uid/${uid}`, { body: { ...cur, ...wanted, uid, access: 'proxy' } });
    did('grafana', `data source "${wanted.name}" updated`);
  } else ok('grafana', `data source "${wanted.name}"`);
}

async function bootstrapGrafana({ api, P }) {
  await waitFor('Grafana /api/health', async () => (await http(GRAFANA, 'GET', '/api/health')).json?.database === 'ok');
  const tokenRotated = await ensureServiceAccountToken();

  // FlagScope data source: points at the gatekeeper and holds no Flagsmith key at all (an older stored key is removed).
  await ensureDatasource(
    UID.flagscope,
    { name: 'FlagScope', type: PLUGIN_ID, jsonData: { flagsmithUrl: GATEKEEPER } },
    { dropSecureFields: ['apiKey'] }
  );
  await ensureDatasource(UID.postgres, {
    name: 'Flagsmith DB',
    type: 'grafana-postgresql-datasource',
    url: POSTGRES_FOR_GRAFANA,
    user: 'grafana_ro',
    jsonData: { database: 'flagsmith', sslmode: 'disable', postgresVersion: 1500, timescaledb: false },
    secureJsonData: { password: GRAFANA_RO_PASSWORD },
  });

  // Flagsmith -> Grafana annotations (project level integration, the environment level path returns 403)
  const integrations = list((await fs_('GET', `${P}/integrations/grafana/`, { auth: api })).json);
  const integrationBody = { base_url: GRAFANA_FOR_FLAGSMITH, api_key: state.grafanaToken };
  if (!integrations.length) {
    await fs_('POST', `${P}/integrations/grafana/`, { auth: api, body: integrationBody });
    did('flagsmith', 'Grafana integration (annotations)');
  } else if (tokenRotated) {
    const r = await fs_('PUT', `${P}/integrations/grafana/${integrations[0].id}/`, { auth: api, body: integrationBody, expect: 'any' });
    if (r.status < 300) did('flagsmith', 'Grafana integration token refreshed');
    else log('flagsmith', `could not refresh the Grafana integration token (HTTP ${r.status}); delete and re-add it in Flagsmith if annotations stop`);
  } else ok('flagsmith', 'Grafana integration (annotations)');

  // Feature Health provider and the Grafana contact point that posts to it
  let providers = list((await fs_('GET', `${P}/feature-health/providers/`, { auth: api })).json);
  let provider = providers.find((p) => p.name === 'Grafana');
  if (!provider) {
    provider = (await fs_('POST', `${P}/feature-health/providers/`, { auth: api, body: { name: 'Grafana' } })).json;
    did('flagsmith', 'Feature Health provider "Grafana"');
  } else ok('flagsmith', 'Feature Health provider "Grafana"');
  const hookUrl = `${FLAGSMITH_FOR_GRAFANA}${new URL(provider.webhook_url).pathname}`;
  const points = (await g('GET', '/api/v1/provisioning/contact-points')).json ?? [];
  const point = points.find((c) => c.name === NAMES.contactPoint);
  if (!point) {
    await g('POST', '/api/v1/provisioning/contact-points', { body: { name: NAMES.contactPoint, type: 'webhook', settings: { url: hookUrl, httpMethod: 'POST' } } });
    did('grafana', `contact point ${NAMES.contactPoint}`);
  } else if (point.settings?.url !== hookUrl) {
    await g('PUT', `/api/v1/provisioning/contact-points/${point.uid}`, { body: { name: NAMES.contactPoint, type: 'webhook', settings: { url: hookUrl, httpMethod: 'POST' } } });
    did('grafana', `contact point ${NAMES.contactPoint} updated`);
  } else ok('grafana', `contact point ${NAMES.contactPoint}`);
}

// Same calls the plugin's "Save & test" makes, but through Grafana's data proxy and the gatekeeper, so the key held by
// the gatekeeper is proven too. Then one path the plugin never uses must be refused with 403 (the allow-list at work).
async function smokeTest() {
  const proxy = (p) => `/api/datasources/proxy/uid/${UID.flagscope}/flagsmith${p}`;
  const v = (await waitFor('FlagScope data source via the gatekeeper', async () => (await g('GET', SMOKE_VERSION_PATH)).json)) ?? {};
  if (!v.experimentation_enabled) throw new Error('FlagScope data source proxy: /version/ did not report experimentation_enabled');
  const projects = list((await g('GET', proxy('/api/v1/projects/'))).json);
  if (!projects.length) throw new Error('FlagScope data source proxy: the gatekeeper key sees no projects');
  const denied = await g('GET', proxy(`/api/v1/environments/${state.envKey}/identities/`), { expect: 'any' });
  if (denied.status !== 403) throw new Error(`gatekeeper allow-list: GET .../identities/ answered ${denied.status}, expected 403`);
  const pg = (await g('GET', `/api/datasources/uid/${UID.postgres}/health`, { expect: 'any' })).json;
  if (pg?.status !== 'OK') throw new Error(`PostgreSQL data source health: ${pg?.message ?? 'not OK'}`);
  log('verify', `FlagScope data source OK (Flagsmith ${v.image_tag}, ${projects.length} project), PostgreSQL data source OK`);
}

function credentialsText() {
  return [
    'FlagScope credentials (generated by stack/bootstrap.mjs, never commit this file)',
    '',
    `Flagsmith UI:        ${PUBLIC_FLAGSMITH}`,
    `  email:             ${state.email}`,
    `  password:          ${state.password}`,
    `  organisation id:   ${state.org}`,
    `  project id:        ${state.project}`,
    `  master API key:    ${state.masterKey}`,
    `  Development key:   ${state.envKey}`,
    `  Production key:    ${state.prodKey}`,
    `  experiment id:     ${state.experiment}`,
    '',
    `Grafana:             ${PUBLIC_GRAFANA}`,
    '  login:             admin / GRAFANA_ADMIN_PASSWORD from stack/.env',
    `  service account token (Flagsmith annotations): ${state.grafanaToken}`,
    '  data sources:      FlagScope (uid flagscope, via the gatekeeper, no key stored in Grafana), Flagsmith DB (uid flagscope-postgres, role grafana_ro)',
    '  dashboard:         Experiment Room (uid flagscope-experiment-room); anonymous Viewer access is on in this demo stack',
    '',
  ].join('\n');
}

try {
  const ctx = await bootstrapFlagsmith();
  await bootstrapGrafana(ctx);
  await smokeTest();
  if (saveState()) changes++;
  if (writeIfChanged(credsPath, credentialsText())) log('files', `wrote ${path.basename(credsPath)}`);
  fs.writeFileSync(doneMarker, new Date().toISOString());
  console.log(`[bootstrap] done: ${changes} change(s)${changes === 0 ? ' (no-op)' : ''}`);
  console.log(`[bootstrap] Flagsmith ${PUBLIC_FLAGSMITH}   Grafana ${PUBLIC_GRAFANA}   credentials: stack/.generated/credentials.txt`);
} catch (e) {
  saveState(); // keep any key we already created so the next run does not orphan it
  console.error(`[bootstrap] FAILED: ${e.message}`);
  process.exit(1);
}
