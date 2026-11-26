import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { Experiment, FlagsmithEnvironment, FlagsmithProject, Paginated, ResultsResponse, VersionInfo } from './types';

/** Flagsmith refuses a second results refresh inside this window (HTTP 429). */
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class FlagsmithApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'FlagsmithApiError';
  }
}

export interface RefreshOutcome {
  /** True when a POST was really sent to Flagsmith. */
  requested: boolean;
  /** Seconds until the next refresh is allowed (0 when allowed now). */
  nextRefreshInSeconds: number;
  /**
   * True when the refresh was refused with 403. The plugin.json POST route requires the Grafana Admin role,
   * so Viewers and Editors read the last computed results and never write to Flagsmith.
   */
  denied?: boolean;
}

interface FetchErrorLike {
  status?: number;
  statusText?: string;
  data?: { detail?: string; message?: string } | string;
}

function toApiError(err: unknown): FlagsmithApiError {
  const e = (err ?? {}) as FetchErrorLike;
  const status = typeof e.status === 'number' ? e.status : 0;
  const data = e.data;
  const detail = typeof data === 'string' ? data : (data?.detail ?? data?.message);
  const wait = detail ? /available in (\d+) seconds/i.exec(detail) : null;
  const message = detail ?? e.statusText ?? (err instanceof Error ? err.message : 'Request failed');
  return new FlagsmithApiError(status, message, wait ? Number(wait[1]) : undefined);
}

function unwrap<T>(data: Paginated<T> | T[]): T[] {
  return Array.isArray(data) ? data : (data?.results ?? []);
}

function experimentsPath(environmentKey: string): string {
  return `/api/v1/environments/${encodeURIComponent(environmentKey)}/experiments`;
}

function experimentPath(environmentKey: string, experimentId: string | number): string {
  return `${experimentsPath(environmentKey)}/${encodeURIComponent(String(experimentId))}`;
}

function throttleKey(environmentKey: string, experimentId: string | number): string {
  return `${environmentKey}:${experimentId}`;
}

/**
 * Typed read-only Flagsmith Admin API calls through the Grafana data proxy route.
 * `baseUrl` is the proxy URL of the route (for example /api/datasources/proxy/uid/abc/flagsmith).
 * The Api-Key header is added server side by Grafana, never in the browser.
 * The only write is the throttled results refresh.
 */
export class FlagsmithClient {
  private nextRefreshAt = new Map<string, number>();

  constructor(
    private readonly baseUrl: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  private async request<T>(method: 'GET' | 'POST', path: string): Promise<T> {
    try {
      const res = await lastValueFrom(
        getBackendSrv().fetch<T>({
          url: `${this.baseUrl}${path}`,
          method,
          headers: { Accept: 'application/json' },
          showErrorAlert: false,
        })
      );
      return res.data;
    } catch (err) {
      throw toApiError(err);
    }
  }

  /** Root route, no auth needed. NOT /api/v1/version/ (that returns the frontend HTML). */
  getVersion(): Promise<VersionInfo> {
    return this.request<VersionInfo>('GET', '/version/');
  }

  async listProjects(): Promise<FlagsmithProject[]> {
    return unwrap(await this.request<Paginated<FlagsmithProject> | FlagsmithProject[]>('GET', '/api/v1/projects/'));
  }

  async listEnvironments(projectId: string | number): Promise<FlagsmithEnvironment[]> {
    const q = encodeURIComponent(String(projectId));
    return unwrap(
      await this.request<Paginated<FlagsmithEnvironment> | FlagsmithEnvironment[]>(
        'GET',
        `/api/v1/environments/?project=${q}`
      )
    );
  }

  async listExperiments(environmentKey: string): Promise<Experiment[]> {
    return unwrap(
      await this.request<Paginated<Experiment> | Experiment[]>('GET', `${experimentsPath(environmentKey)}/`)
    );
  }

  getExperiment(environmentKey: string, experimentId: string | number): Promise<Experiment> {
    return this.request<Experiment>('GET', `${experimentPath(environmentKey, experimentId)}/`);
  }

  getResults(environmentKey: string, experimentId: string | number): Promise<ResultsResponse> {
    return this.request<ResultsResponse>('GET', `${experimentPath(environmentKey, experimentId)}/results/`);
  }

  /** Seconds until a refresh for this experiment is allowed again, 0 if allowed now. */
  secondsUntilRefresh(environmentKey: string, experimentId: string | number): number {
    const next = this.nextRefreshAt.get(throttleKey(environmentKey, experimentId)) ?? 0;
    return Math.max(0, Math.ceil((next - this.now()) / 1000));
  }

  /**
   * POST results/refresh/, at most once per 5 minutes per experiment (in-memory throttle).
   * A 429 from Flagsmith is not an error: its "available in N seconds" hint seeds the throttle.
   * A 403 (Grafana route needs the Admin role, or Flagsmith refused the key) is not an error either:
   * results are still read, only the refresh is skipped.
   */
  async refreshResults(environmentKey: string, experimentId: string | number): Promise<RefreshOutcome> {
    const key = throttleKey(environmentKey, experimentId);
    const wait = this.secondsUntilRefresh(environmentKey, experimentId);
    if (wait > 0) {
      return { requested: false, nextRefreshInSeconds: wait };
    }
    // Claim the slot before the await so concurrent panels cannot double-send.
    this.nextRefreshAt.set(key, this.now() + REFRESH_INTERVAL_MS);
    try {
      await this.request<null>('POST', `${experimentPath(environmentKey, experimentId)}/results/refresh/`);
    } catch (err) {
      if (err instanceof FlagsmithApiError && err.status === 429) {
        const seconds = err.retryAfterSeconds ?? REFRESH_INTERVAL_MS / 1000;
        this.nextRefreshAt.set(key, this.now() + seconds * 1000);
        return { requested: false, nextRefreshInSeconds: seconds };
      }
      if (err instanceof FlagsmithApiError && err.status === 403) {
        // Keep the slot claimed: the role will not change inside this tab, so do not retry every panel run.
        return { requested: false, nextRefreshInSeconds: REFRESH_INTERVAL_MS / 1000, denied: true };
      }
      this.nextRefreshAt.delete(key);
      throw err;
    }
    return { requested: true, nextRefreshInSeconds: REFRESH_INTERVAL_MS / 1000 };
  }
}
