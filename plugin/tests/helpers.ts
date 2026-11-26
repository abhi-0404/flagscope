import { getBackendSrv } from '@grafana/runtime';
import { of, throwError } from 'rxjs';

export interface FakeResponse {
  data?: unknown;
  error?: { status: number; data?: unknown; statusText?: string };
}

export const BASE = '/proxy/flagsmith';

/** Route table keyed by "METHOD path" (path relative to the proxy base URL). */
export function mockBackend(routes: Record<string, FakeResponse | (() => FakeResponse)>) {
  const fetch = jest.fn((req: { url: string; method?: string }) => {
    const path = req.url.startsWith(BASE) ? req.url.slice(BASE.length) : req.url.replace(/^.*\/flagsmith/, '');
    const key = `${req.method ?? 'GET'} ${path}`;
    const route = routes[key];
    if (!route) {
      return throwError(() => ({ status: 404, data: { detail: `no fake route for ${key}` } }));
    }
    const res = typeof route === 'function' ? route() : route;
    return res.error ? throwError(() => res.error) : of({ data: res.data, status: 200 });
  });
  (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
  return fetch;
}
