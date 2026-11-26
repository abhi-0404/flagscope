import { FlagsmithApiError, FlagsmithClient, REFRESH_INTERVAL_MS } from '../src/api/client';
import { BASE, mockBackend } from './helpers';
import version from './fixtures/version.json';
import projects from './fixtures/projects-list.json';
import environments from './fixtures/environments-list.json';
import experiments from './fixtures/experiments-list.json';
import experimentDetail from './fixtures/experiments-detail-running-with-data.json';
import results from './fixtures/experiments-results.json';
import throttled from './fixtures/experiments-results-refresh-throttled.json';

jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn(), getTemplateSrv: jest.fn() }));

const ENV = 'iVKfD7DrG4H9U6iaNdWfgc';
const X = `/api/v1/environments/${ENV}/experiments`;

describe('FlagsmithClient requests', () => {
  it('calls the root /version/ route (not /api/v1/version/) and never sends an auth header itself', async () => {
    const fetch = mockBackend({ 'GET /version/': { data: version } });
    const v = await new FlagsmithClient(BASE).getVersion();
    expect(v.experimentation_enabled).toBe(true);
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ url: `${BASE}/version/`, method: 'GET' }));
    expect(JSON.stringify(fetch.mock.calls[0][0])).not.toMatch(/api-key/i);
  });

  it('lists projects, unwrapping a paginated body or a bare array', async () => {
    // Recorded: a bare array with an organisation master key.
    mockBackend({ 'GET /api/v1/projects/': { data: projects } });
    expect((await new FlagsmithClient(BASE).listProjects()).map((p) => p.name)).toEqual(['FlagScope Demo']);
    mockBackend({ 'GET /api/v1/projects/': { data: { count: 1, results: projects } } });
    expect(await new FlagsmithClient(BASE).listProjects()).toHaveLength(1);
  });

  it('lists environments of a project with the project id in the query string', async () => {
    const fetch = mockBackend({ 'GET /api/v1/environments/?project=1': { data: environments } });
    const envs = await new FlagsmithClient(BASE).listEnvironments(1);
    expect(envs.map((e) => e.name)).toEqual(['Development', 'Production']);
    expect(fetch.mock.calls[0][0].url).toBe(`${BASE}/api/v1/environments/?project=1`);
  });

  it('lists experiments, gets one experiment and reads its results', async () => {
    mockBackend({
      [`GET ${X}/`]: { data: experiments },
      [`GET ${X}/1/`]: { data: experimentDetail },
      [`GET ${X}/1/results/`]: { data: results },
    });
    const c = new FlagsmithClient(BASE);
    expect((await c.listExperiments(ENV))[0].name).toBe('PayPal button experiment');
    expect((await c.getExperiment(ENV, 1)).status).toBe('running');
    expect((await c.getResults(ENV, '1')).results?.payload.metrics[0].variants.control.n).toBe(510);
  });

  it('url-encodes path segments', async () => {
    const fetch = mockBackend({});
    await new FlagsmithClient(BASE).listExperiments('a/b c').catch(() => undefined);
    expect(fetch.mock.calls[0][0].url).toBe(`${BASE}/api/v1/environments/a%2Fb%20c/experiments/`);
  });

  it('maps HTTP failures to FlagsmithApiError with status and detail', async () => {
    mockBackend({ 'GET /api/v1/projects/': { error: { status: 401, data: { detail: 'Invalid API key' } } } });
    const err = await new FlagsmithClient(BASE).listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(FlagsmithApiError);
    expect(err).toMatchObject({ status: 401, message: 'Invalid API key' });
  });

  it('maps a network failure without detail to status 0 and the status text', async () => {
    mockBackend({ 'GET /version/': { error: { status: 0, statusText: 'Bad Gateway' } } });
    const err = await new FlagsmithClient(BASE).getVersion().catch((e) => e);
    expect(err).toMatchObject({ status: 0, message: 'Bad Gateway' });
  });
});

describe('refresh throttle (fake timers)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-26T10:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  const post = (fetch: jest.Mock) => fetch.mock.calls.filter((c) => c[0].method === 'POST');

  it('sends one POST then blocks for 5 minutes, then allows again', async () => {
    const fetch = mockBackend({ [`POST ${X}/1/results/refresh/`]: { data: null } });
    const c = new FlagsmithClient(BASE);

    expect(await c.refreshResults(ENV, 1)).toEqual({ requested: true, nextRefreshInSeconds: 300 });
    expect(post(fetch)).toHaveLength(1);

    jest.advanceTimersByTime(60_000);
    expect(await c.refreshResults(ENV, 1)).toEqual({ requested: false, nextRefreshInSeconds: 240 });
    expect(post(fetch)).toHaveLength(1);

    jest.advanceTimersByTime(REFRESH_INTERVAL_MS - 60_000 - 1);
    expect((await c.refreshResults(ENV, 1)).requested).toBe(false);

    jest.advanceTimersByTime(1);
    expect(c.secondsUntilRefresh(ENV, 1)).toBe(0);
    expect((await c.refreshResults(ENV, 1)).requested).toBe(true);
    expect(post(fetch)).toHaveLength(2);
  });

  it('throttles per experiment and per environment independently', async () => {
    const fetch = mockBackend({
      [`POST ${X}/1/results/refresh/`]: { data: null },
      [`POST ${X}/2/results/refresh/`]: { data: null },
      ['POST /api/v1/environments/other/experiments/1/results/refresh/']: { data: null },
    });
    const c = new FlagsmithClient(BASE);
    await c.refreshResults(ENV, 1);
    await c.refreshResults(ENV, 2);
    await c.refreshResults('other', 1);
    expect(post(fetch)).toHaveLength(3);
  });

  it('does not double-send when two panels refresh at the same time', async () => {
    const fetch = mockBackend({ [`POST ${X}/1/results/refresh/`]: { data: null } });
    const c = new FlagsmithClient(BASE);
    const [a, b] = await Promise.all([c.refreshResults(ENV, 1), c.refreshResults(ENV, 1)]);
    expect([a.requested, b.requested].sort()).toEqual([false, true]);
    expect(post(fetch)).toHaveLength(1);
  });

  it('treats a 429 as a wait hint, using the seconds from the response body', async () => {
    mockBackend({ [`POST ${X}/1/results/refresh/`]: { error: { status: 429, data: throttled } } });
    const c = new FlagsmithClient(BASE);
    expect(await c.refreshResults(ENV, 1)).toEqual({ requested: false, nextRefreshInSeconds: 289 });
    expect(c.secondsUntilRefresh(ENV, 1)).toBe(289);
  });

  it('treats a 403 (POST route needs Grafana Admin) as read only and does not retry every run', async () => {
    const fetch = mockBackend({
      [`POST ${X}/1/results/refresh/`]: { error: { status: 403, data: { message: 'plugin proxy route access denied' } } },
    });
    const c = new FlagsmithClient(BASE);
    expect(await c.refreshResults(ENV, 1)).toEqual({ requested: false, nextRefreshInSeconds: 300, denied: true });
    expect((await c.refreshResults(ENV, 1)).requested).toBe(false);
    expect(post(fetch)).toHaveLength(1);
  });

  it('frees the slot and rethrows on a server error so the next run can retry', async () => {
    mockBackend({ [`POST ${X}/1/results/refresh/`]: { error: { status: 500, data: { detail: 'boom' } } } });
    const c = new FlagsmithClient(BASE);
    await expect(c.refreshResults(ENV, 1)).rejects.toMatchObject({ status: 500 });
    expect(c.secondsUntilRefresh(ENV, 1)).toBe(0);
  });
});
