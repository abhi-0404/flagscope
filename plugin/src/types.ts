import { DataSourceJsonData } from '@grafana/data';
import { DataQuery } from '@grafana/schema';

export type QueryType = 'experiments' | 'results';

export interface FlagscopeQuery extends DataQuery {
  queryType: QueryType;
  /** Only used by the editor to narrow the environment list. */
  projectId?: string;
  /** Flagsmith environment API key (client key). May be a Grafana variable such as $environment. */
  environmentKey?: string;
  /** Experiment id. May be a Grafana variable such as $experiment. */
  experimentId?: string;
  /** results only: request a results refresh from Flagsmith (throttled to once per 5 minutes). */
  refresh?: boolean;
}

export const DEFAULT_QUERY: Partial<FlagscopeQuery> = {
  queryType: 'results',
  refresh: true,
};

/** Options configured for each data source instance. */
export interface FlagscopeDataSourceOptions extends DataSourceJsonData {
  /** Base URL of Flagsmith as seen by the Grafana server, for example http://flagsmith:8000 */
  flagsmithUrl?: string;
}

/** Stored encrypted by Grafana and only used by the data proxy, never sent to the browser. */
export interface FlagscopeSecureJsonData {
  /** Flagsmith organisation (master) API key. */
  apiKey?: string;
}
