import { DataQueryRequest, DataSourceInstanceSettings } from '@grafana/data';
import { getTemplateSrv } from '@grafana/runtime';
import { DataSource } from '../src/datasource';
import { FlagscopeDataSourceOptions, FlagscopeQuery } from '../src/types';
import { BASE, mockBackend } from './helpers';
import version from './fixtures/version.json';
import projects from './fixtures/projects-list.json';
import environments from './fixtures/environments-list.json';
import experiments from './fixtures/experiments-list.json';
import experimentDetail from './fixtures/experiments-detail-running-with-data.json';
import results from './fixtures/experiments-results.json';

jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn(), getTemplateSrv: jest.fn() }));

const ENV = 'iVKfD7DrG4H9U6iaNdWfgc';
const X = `/api/v1/environments/${ENV}/experiments`;

const settings = {
  id: 1,
  uid: 'u1',
  url: '/proxy',
  jsonData: {},
} as unknown as DataSourceInstanceSettings<FlagscopeDataSourceOptions>;

function request(targets: Array<Partial<FlagscopeQuery>>): DataQueryRequest<FlagscopeQuery> {
  return {
    targets: targets.map((t, i) => ({ refId: `R${i}`, queryType: 'results', ...t })),
    scopedVars: {},
  } as unknown as DataQueryRequest<FlagscopeQuery>;
}

beforeEach(() => {
  (getTemplateSrv as jest.Mock).mockReturnValue({
    replace: (s: string) => s.replace('$environment', ENV).replace('$experiment', '1'),
  });
});

const routes = () => ({
  [`GET ${X}/`]: { data: experiments },
  [`GET ${X}/1/`]: { data: experimentDetail },
  [`GET ${X}/1/results/`]: { data: results },
  [`POST ${X}/1/results/refresh/`]: { data: null },
});

describe('DataSource.query', () => {
  it('builds the proxy route url from the instance url', async () => {
    const fetch = mockBackend({ 'GET /version/': { data: version }, 'GET /api/v1/projects/': { data: projects } });
    const ds = new DataSource({ ...settings, url: '/api/datasources/proxy/uid/u1' });
    await ds.testDatasource();
    expect(fetch.mock.calls[0][0].url).toBe('/api/datasources/proxy/uid/u1/flagsmith/version/');
  });

  it('runs an experiments query into one frame', async () => {
    mockBackend(routes());
    const out = await new DataSource(settings).query(request([{ queryType: 'experiments', environmentKey: ENV }]));
    expect(out.errors).toBeUndefined();
    expect(out.data).toHaveLength(1);
    expect(out.data[0].refId).toBe('R0');
    expect(out.data[0].length).toBe(1);
  });

  it('runs a results query: refresh POST first, then experiment and results GETs', async () => {
    const fetch = mockBackend(routes());
    const out = await new DataSource(settings).query(request([{ environmentKey: ENV, experimentId: '1' }]));
    const calls = fetch.mock.calls.map((c) => `${c[0].method} ${c[0].url.replace(BASE, '')}`);
    expect(calls[0]).toBe(`POST ${X}/1/results/refresh/`);
    expect(calls).toEqual(expect.arrayContaining([`GET ${X}/1/`, `GET ${X}/1/results/`]));
    expect(out.data[0].length).toBe(3);
    expect(out.data[0].meta.notices[0].text).toBe('Next refresh in 05:00');
  });

  it('still shows results to a Viewer whose refresh POST is refused with 403', async () => {
    mockBackend({
      ...routes(),
      [`POST ${X}/1/results/refresh/`]: { error: { status: 403, data: { message: 'plugin proxy route access denied' } } },
    });
    const out = await new DataSource(settings).query(request([{ environmentKey: ENV, experimentId: '1' }]));
    expect(out.errors).toBeUndefined();
    expect(out.data[0].length).toBe(3);
    expect(out.data[0].meta.notices[0].text).toMatch(/needs the Grafana Admin role/);
  });

  it('never refreshes twice within 5 minutes across runs, and skips refresh when switched off', async () => {
    const fetch = mockBackend(routes());
    const ds = new DataSource(settings);
    const q = { environmentKey: ENV, experimentId: '1' };
    await ds.query(request([q]));
    await ds.query(request([q]));
    await ds.query(request([{ ...q, refresh: false }]));
    expect(fetch.mock.calls.filter((c) => c[0].method === 'POST')).toHaveLength(1);
  });

  it('resolves $variables in environment and experiment', async () => {
    const fetch = mockBackend(routes());
    await new DataSource(settings).query(
      request([{ environmentKey: '$environment', experimentId: '$experiment', refresh: false }])
    );
    expect(fetch.mock.calls.map((c) => c[0].url)).toContain(`${BASE}${X}/1/results/`);
  });

  it('skips hidden and incomplete queries (filterQuery)', async () => {
    const fetch = mockBackend(routes());
    const out = await new DataSource(settings).query(
      request([{ hide: true, environmentKey: ENV, experimentId: '1' }, { environmentKey: ENV }, {}])
    );
    expect(out.data).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a per-query error and keeps the good frames', async () => {
    mockBackend({
      ...routes(),
      [`GET ${X}/9/`]: { error: { status: 404, data: { detail: 'Not found.' } } },
      [`POST ${X}/9/results/refresh/`]: { data: null },
    });
    const out = await new DataSource(settings).query(
      request([
        { queryType: 'experiments', environmentKey: ENV },
        { environmentKey: ENV, experimentId: '9' },
      ])
    );
    expect(out.data).toHaveLength(1);
    expect(out.errors).toEqual([expect.objectContaining({ refId: 'R1', status: 404 })]);
  });
});

describe('DataSource.testDatasource', () => {
  it('succeeds when /version/ reports experimentation and the key can list projects', async () => {
    mockBackend({ 'GET /version/': { data: version }, 'GET /api/v1/projects/': { data: projects } });
    const res = await new DataSource(settings).testDatasource();
    expect(res.status).toBe('success');
    expect(res.message).toMatch(/2\.295\.2.*Experimentation enabled.*1 project/);
  });

  it('fails when experimentation is disabled', async () => {
    mockBackend({ 'GET /version/': { data: { ...version, experimentation_enabled: false } } });
    const res = await new DataSource(settings).testDatasource();
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/Experimentation is disabled/);
  });

  it('fails when the url is unreachable', async () => {
    mockBackend({ 'GET /version/': { error: { status: 502, statusText: 'Bad Gateway' } } });
    const res = await new DataSource(settings).testDatasource();
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/Cannot reach Flagsmith/);
  });

  it('fails when the url answers with something that is not Flagsmith (HTML)', async () => {
    mockBackend({ 'GET /version/': { data: '<html></html>' } });
    const res = await new DataSource(settings).testDatasource();
    expect(res.message).toMatch(/does not look like Flagsmith/);
  });

  it('fails with a clear message when the api key is rejected', async () => {
    mockBackend({
      'GET /version/': { data: version },
      'GET /api/v1/projects/': { error: { status: 401, data: { detail: 'Invalid API key.' } } },
    });
    const res = await new DataSource(settings).testDatasource();
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/rejected the API key \(HTTP 401\)/);
  });
});

describe('DataSource.metricFindQuery (template variables)', () => {
  beforeEach(() => {
    mockBackend({
      'GET /api/v1/projects/': { data: projects },
      'GET /api/v1/environments/?project=1': { data: environments },
      [`GET ${X}/`]: { data: experiments },
    });
  });

  it('projects', async () => {
    expect(await new DataSource(settings).metricFindQuery('projects')).toEqual([
      { text: 'FlagScope Demo', value: '1' },
    ]);
  });

  it('environments(<project id>)', async () => {
    const out = await new DataSource(settings).metricFindQuery('environments(1)');
    expect(out.map((v) => v.text)).toEqual(['Development', 'Production']);
    expect(out[0].value).toBe(ENV);
  });

  it('experiments(<environment key>) with a variable argument', async () => {
    expect(await new DataSource(settings).metricFindQuery({ query: 'experiments($environment)' })).toEqual([
      { text: 'PayPal button experiment', value: '1' },
    ]);
  });

  it('rejects unknown and incomplete queries', async () => {
    const ds = new DataSource(settings);
    await expect(ds.metricFindQuery('flags')).rejects.toThrow(/Unsupported variable query/);
    await expect(ds.metricFindQuery('environments()')).rejects.toThrow(/needs an argument/);
  });
});
