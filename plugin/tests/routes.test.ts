import path from 'node:path';
import pluginJson from '../src/plugin.json';
import { FlagsmithClient } from '../src/api/client';
import { mockBackend } from './helpers';

jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn(), getTemplateSrv: jest.fn() }));

interface Route {
  path: string;
  method?: string;
  reqRole?: string;
  url: string;
  headers?: Array<{ name: string; content: string }>;
}
const routes = pluginJson.routes as Route[];

// Same rule as Grafana's data proxy (verified against grafana/grafana:13.2.7): the first route whose method
// matches (empty or "*" means any) and whose cleaned path is a prefix of the cleaned request path wins.
// No match: the request is not forwarded with the key (Grafana answers 502 because the data source has no url).
function match(method: string, proxyPath: string): Route | undefined {
  const clean = (p: string) => path.posix.normalize(p).replace(/\/+$/, '');
  return routes.find(
    (r) => (!r.method || r.method === '*' || r.method === method) && clean(proxyPath).startsWith(clean(r.path))
  );
}
const injectsKey = (r?: Route) => !!r?.headers?.some((h) => /Api-Key/.test(h.content));

describe('plugin.json data proxy routes (read only)', () => {
  it('every route names one method, GET or POST, never any-method', () => {
    for (const r of routes) {
      expect(['GET', 'POST']).toContain(r.method);
    }
  });

  it('the only POST route is limited to the Grafana Admin role', () => {
    const posts = routes.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].reqRole).toBe('Admin');
    expect(posts[0].path).toBe('flagsmith/api/v1/environments/');
  });

  it('/version/ does not get the API key', () => {
    expect(injectsKey(match('GET', 'flagsmith/version/'))).toBe(false);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('%s never matches a route, so nothing is forwarded with the key', (m) => {
    for (const p of ['flagsmith/api/v1/projects/1/', 'flagsmith/api/v1/environments/K/featurestates/1/', 'flagsmith/version/']) {
      expect(match(m, p)).toBeUndefined();
    }
  });

  it('GET outside projects/ and environments/ (organisations, master keys, users) is not forwarded', () => {
    for (const p of [
      'flagsmith/api/v1/organisations/1/master-api-keys/',
      'flagsmith/api/v1/users/',
      'flagsmith/api/v1/environments/../organisations/',
      'flagsmith/',
    ]) {
      expect(match('GET', p)).toBeUndefined();
    }
  });

  it('covers every request the client makes, with the right method', async () => {
    const BASE = '/api/datasources/proxy/uid/u1/flagsmith';
    const fetch = mockBackend({});
    const c = new FlagsmithClient(BASE);
    await Promise.allSettled([
      c.getVersion(),
      c.listProjects(),
      c.listEnvironments(1),
      c.listExperiments('K'),
      c.getExperiment('K', 1),
      c.getResults('K', 1),
      c.refreshResults('K', 1),
    ]);
    expect(fetch).toHaveBeenCalledTimes(7);
    for (const [req] of fetch.mock.calls) {
      const proxyPath = req.url.slice(BASE.length - 'flagsmith'.length).split('?')[0];
      const r = match(req.method ?? 'GET', proxyPath);
      expect(r).toBeDefined();
      // Grafana appends the rest of the request path to the route url: the forwarded path must stay the same.
      const forwarded = r!.url.replace('{{ .JsonData.flagsmithUrl }}', '') + proxyPath.slice(r!.path.length);
      expect(forwarded).toBe(proxyPath.slice('flagsmith'.length));
    }
  });
});
