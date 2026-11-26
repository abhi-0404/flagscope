// Hand-written types from responses recorded against Flagsmith 2.295.2 (see tests/fixtures).
// Not generated from swagger: the swagger result schemas for experiments are wrong or empty.

export interface VersionInfo {
  image_tag: string;
  experimentation_enabled: boolean;
  is_enterprise?: boolean;
  is_saas?: boolean;
}

export interface Paginated<T> {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results: T[];
}

export interface FlagsmithProject {
  id: number;
  name: string;
  organisation: number;
}

export interface FlagsmithEnvironment {
  id: number;
  name: string;
  api_key: string;
  project: number;
}

export type ExperimentStatus = 'created' | 'running' | 'paused' | 'completed';

export interface MultivariateOption {
  id: number;
  type: string;
  string_value: string | null;
  default_percentage_allocation: number;
  key: string | null;
}

export interface ExperimentFeature {
  id: number;
  name: string;
  type: string;
  initial_value: string | null;
  multivariate_options: MultivariateOption[];
}

export interface ExperimentMetricLink {
  id: number;
  metric: number;
  metric_name: string;
  aggregation: string;
  direction: string;
  expected_direction: string;
}

export interface Experiment {
  id: number;
  feature: ExperimentFeature;
  name: string;
  hypothesis: string | null;
  status: ExperimentStatus;
  metrics: ExperimentMetricLink[];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  rollout_decision: string | null;
  rollout_variant: string | null;
}

export interface VariantStats {
  n: number;
  sum: number;
  sum_squares: number;
}

export interface VariantInference {
  lift: number;
  ci_low: number;
  ci_high: number;
  chance_to_win: number;
}

export interface TimeseriesPoint {
  bucket: string;
  converted_identities?: Record<string, number>;
  new_identities?: Record<string, number>;
}

export interface MetricResult {
  metric_id: number;
  variants: Record<string, VariantStats>;
  /** No entry for the control variant. */
  inference: Record<string, VariantInference>;
  conversions_timeseries?: { granularity: string; points: TimeseriesPoint[] };
}

export interface ExperimentResults {
  as_of: string | null;
  last_error_at: string | null;
  refresh_requested_at: string | null;
  is_final: boolean;
  payload: {
    metrics: MetricResult[];
    /** Always null in 2.295.2, compute SRM from SQL instead. */
    srm_p_value: number | null;
    exposures_timeseries?: { granularity: string; points: TimeseriesPoint[] };
  };
}

/** GET .../results/ returns `{results: null}` before the first refresh. */
export interface ResultsResponse {
  results: ExperimentResults | null;
}
