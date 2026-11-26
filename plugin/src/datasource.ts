import { getTemplateSrv } from '@grafana/runtime';
import {
  CoreApp,
  DataQueryError,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  MetricFindValue,
  TestDataSourceResponse,
} from '@grafana/data';

import { FlagsmithApiError, FlagsmithClient } from './api/client';
import {
  environmentsToVariable,
  experimentsToFrame,
  experimentsToVariable,
  projectsToVariable,
  resultsToFrame,
} from './query/transform';
import { DEFAULT_QUERY, FlagscopeDataSourceOptions, FlagscopeQuery } from './types';

/** Name of the route in plugin.json. The route injects the Api-Key header server side. */
export const ROUTE = 'flagsmith';

export class DataSource extends DataSourceApi<FlagscopeQuery, FlagscopeDataSourceOptions> {
  readonly client: FlagsmithClient;

  constructor(instanceSettings: DataSourceInstanceSettings<FlagscopeDataSourceOptions>, client?: FlagsmithClient) {
    super(instanceSettings);
    this.client = client ?? new FlagsmithClient(`${instanceSettings.url ?? ''}/${ROUTE}`);
  }

  getDefaultQuery(_: CoreApp): Partial<FlagscopeQuery> {
    return DEFAULT_QUERY;
  }

  filterQuery(query: FlagscopeQuery): boolean {
    if (!query.environmentKey) {
      return false;
    }
    return query.queryType === 'experiments' || !!query.experimentId;
  }

  async query(request: DataQueryRequest<FlagscopeQuery>): Promise<DataQueryResponse> {
    const data = [];
    const errors: DataQueryError[] = [];

    // Sequential: keeps the refresh throttle deterministic when two panels share one experiment.
    for (const target of request.targets) {
      if (target.hide || !this.filterQuery(target)) {
        continue;
      }
      try {
        const query = this.applyTemplateVariables(target, request.scopedVars);
        data.push(await this.runQuery(query));
      } catch (err) {
        errors.push({
          refId: target.refId,
          message: errorMessage(err),
          status: err instanceof FlagsmithApiError ? err.status : undefined,
        });
      }
    }

    return errors.length ? { data, errors } : { data };
  }

  applyTemplateVariables(query: FlagscopeQuery, scopedVars: DataQueryRequest['scopedVars']): FlagscopeQuery {
    const srv = getTemplateSrv();
    return {
      ...query,
      environmentKey: query.environmentKey ? srv.replace(query.environmentKey, scopedVars) : query.environmentKey,
      experimentId: query.experimentId ? srv.replace(query.experimentId, scopedVars) : query.experimentId,
    };
  }

  private async runQuery(query: FlagscopeQuery) {
    const env = query.environmentKey!;
    if (query.queryType === 'experiments') {
      return experimentsToFrame(query.refId, await this.client.listExperiments(env));
    }

    const id = query.experimentId!;
    let nextRefreshInSeconds: number | undefined;
    let refreshDenied = false;
    if (query.refresh !== false) {
      const outcome = await this.client.refreshResults(env, id);
      nextRefreshInSeconds = outcome.nextRefreshInSeconds;
      refreshDenied = outcome.denied === true;
    }
    const [experiment, res] = await Promise.all([this.client.getExperiment(env, id), this.client.getResults(env, id)]);
    return resultsToFrame(query.refId, experiment, res.results, { nextRefreshInSeconds, refreshDenied });
  }

  /**
   * Template variable queries, one per line of text:
   *   projects
   *   environments(<project id>)
   *   experiments(<environment key>)
   * Arguments may use other variables, for example experiments($environment).
   */
  async metricFindQuery(query: string | { query?: string }): Promise<MetricFindValue[]> {
    const raw = typeof query === 'string' ? query : (query?.query ?? '');
    const text = getTemplateSrv().replace(raw.trim());
    const match = /^(projects|environments|experiments)\s*(?:\(\s*([^)]*?)\s*\))?$/.exec(text);
    if (!match) {
      throw new Error(
        `Unsupported variable query "${text}". Use projects, environments(<project id>) or experiments(<environment key>).`
      );
    }
    const [, kind, arg] = match;
    if (kind === 'projects') {
      return projectsToVariable(await this.client.listProjects());
    }
    if (!arg) {
      throw new Error(`${kind}() needs an argument`);
    }
    return kind === 'environments'
      ? environmentsToVariable(await this.client.listEnvironments(arg))
      : experimentsToVariable(await this.client.listExperiments(arg));
  }

  /** Save and test: GET /version/ (no auth), require experimentation, then prove the key works. */
  async testDatasource(): Promise<TestDataSourceResponse> {
    let version;
    try {
      version = await this.client.getVersion();
    } catch (err) {
      return { status: 'error', message: `Cannot reach Flagsmith: ${errorMessage(err)}` };
    }
    if (!version || typeof version.image_tag !== 'string') {
      return {
        status: 'error',
        message: 'The URL answered but it does not look like Flagsmith (no /version/ JSON). Check the Flagsmith URL.',
      };
    }
    if (!version.experimentation_enabled) {
      return {
        status: 'error',
        message: `Flagsmith ${version.image_tag} is reachable but Experimentation is disabled. Set EXPERIMENTATION_ENABLED=true on the Flagsmith API.`,
      };
    }
    try {
      const projects = await this.client.listProjects();
      return {
        status: 'success',
        message: `Connected to Flagsmith ${version.image_tag}, Experimentation enabled, ${projects.length} project(s) visible to the API key.`,
      };
    } catch (err) {
      const rejected = err instanceof FlagsmithApiError && (err.status === 401 || err.status === 403);
      return {
        status: 'error',
        message: rejected
          ? `Flagsmith ${version.image_tag} is reachable but rejected the API key (HTTP ${err.status}). Use an organisation master API key.`
          : `Flagsmith ${version.image_tag} is reachable but listing projects failed: ${errorMessage(err)}`,
      };
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof FlagsmithApiError) {
    return err.status ? `HTTP ${err.status}: ${err.message}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
