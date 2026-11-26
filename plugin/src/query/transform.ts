import { DataFrame, FieldType, MetricFindValue, createDataFrame } from '@grafana/data';
import { Experiment, ExperimentResults, FlagsmithEnvironment, FlagsmithProject } from '../api/types';

const CONTROL = 'control';

function toMs(iso: string | null | undefined): number | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function experimentsToFrame(refId: string, experiments: Experiment[]): DataFrame {
  return createDataFrame({
    refId,
    name: 'experiments',
    fields: [
      { name: 'id', type: FieldType.number, values: experiments.map((e) => e.id) },
      { name: 'name', type: FieldType.string, values: experiments.map((e) => e.name) },
      { name: 'feature', type: FieldType.string, values: experiments.map((e) => e.feature?.name ?? '') },
      { name: 'status', type: FieldType.string, values: experiments.map((e) => e.status) },
      {
        name: 'metrics',
        type: FieldType.string,
        values: experiments.map((e) => (e.metrics ?? []).map((m) => m.metric_name).join(', ')),
      },
      { name: 'hypothesis', type: FieldType.string, values: experiments.map((e) => e.hypothesis ?? '') },
      { name: 'created', type: FieldType.time, values: experiments.map((e) => toMs(e.created_at)) },
      { name: 'started', type: FieldType.time, values: experiments.map((e) => toMs(e.started_at)) },
      { name: 'ended', type: FieldType.time, values: experiments.map((e) => toMs(e.ended_at)) },
    ],
  });
}

export interface ResultsFrameOptions {
  /** Seconds until the next results refresh is allowed; omitted when no refresh is involved. */
  nextRefreshInSeconds?: number;
  /** The refresh was refused (403): this Grafana role can only read results. */
  refreshDenied?: boolean;
}

/**
 * One row per metric and variant: sample size, conversions (sum), conversion rate / mean, and the
 * inference Flagsmith computed (lift vs control, credible interval, chance to beat control).
 * Control has no inference entry, so its lift, interval and chance to win are null.
 */
export function resultsToFrame(
  refId: string,
  experiment: Experiment | undefined,
  results: ExperimentResults | null,
  opts: ResultsFrameOptions = {}
): DataFrame {
  const rows = {
    metric: [] as string[],
    variant: [] as string[],
    sample_size: [] as number[],
    conversions: [] as number[],
    mean: [] as number[],
    lift: [] as Array<number | null>,
    ci_low: [] as Array<number | null>,
    ci_high: [] as Array<number | null>,
    chance_to_win: [] as Array<number | null>,
  };

  for (const metric of results?.payload?.metrics ?? []) {
    const link = experiment?.metrics?.find((m) => m.metric === metric.metric_id);
    const metricName = link?.metric_name ?? `metric ${metric.metric_id}`;
    const variants = Object.keys(metric.variants ?? {}).sort((a, b) =>
      a === CONTROL ? -1 : b === CONTROL ? 1 : a.localeCompare(b)
    );
    for (const variant of variants) {
      const stats = metric.variants[variant];
      const inf = metric.inference?.[variant];
      rows.metric.push(metricName);
      rows.variant.push(variant);
      rows.sample_size.push(stats.n);
      rows.conversions.push(stats.sum);
      rows.mean.push(stats.n > 0 ? stats.sum / stats.n : 0);
      rows.lift.push(inf ? inf.lift : null);
      rows.ci_low.push(inf ? inf.ci_low : null);
      rows.ci_high.push(inf ? inf.ci_high : null);
      rows.chance_to_win.push(inf ? inf.chance_to_win : null);
    }
  }

  const notices: Array<{ severity: 'info' | 'warning'; text: string }> = [];
  if (!results) {
    notices.push({
      severity: 'info',
      text: opts.refreshDenied
        ? 'No results yet. A Grafana Admin has to open this panel once to request the first refresh.'
        : 'No results yet. A refresh is requested on the next run.',
    });
  }
  if (results?.last_error_at) {
    notices.push({ severity: 'warning', text: `Flagsmith reported a results error at ${results.last_error_at}` });
  }
  if (opts.refreshDenied) {
    notices.push({
      severity: 'info',
      text: 'Results refresh needs the Grafana Admin role; showing the last computed results (read only).',
    });
  } else if (opts.nextRefreshInSeconds !== undefined) {
    notices.push({
      severity: 'info',
      text:
        opts.nextRefreshInSeconds > 0
          ? `Next refresh in ${formatCountdown(opts.nextRefreshInSeconds)}`
          : 'Refresh allowed now',
    });
  }

  return createDataFrame({
    refId,
    name: 'results',
    meta: {
      notices,
      custom: {
        experimentId: experiment?.id,
        asOf: results?.as_of ?? null,
        isFinal: results?.is_final ?? false,
        nextRefreshInSeconds: opts.nextRefreshInSeconds,
      },
    },
    fields: [
      { name: 'metric', type: FieldType.string, values: rows.metric },
      { name: 'variant', type: FieldType.string, values: rows.variant },
      { name: 'sample_size', type: FieldType.number, values: rows.sample_size, config: { displayName: 'Sample size' } },
      { name: 'conversions', type: FieldType.number, values: rows.conversions, config: { displayName: 'Conversions' } },
      {
        name: 'mean',
        type: FieldType.number,
        values: rows.mean,
        config: { displayName: 'Conversion rate / mean', unit: 'percentunit' },
      },
      {
        name: 'lift',
        type: FieldType.number,
        values: rows.lift,
        config: { displayName: 'Lift vs control', unit: 'percentunit' },
      },
      {
        name: 'ci_low',
        type: FieldType.number,
        values: rows.ci_low,
        config: { displayName: 'Interval low', unit: 'percentunit' },
      },
      {
        name: 'ci_high',
        type: FieldType.number,
        values: rows.ci_high,
        config: { displayName: 'Interval high', unit: 'percentunit' },
      },
      {
        name: 'chance_to_win',
        type: FieldType.number,
        values: rows.chance_to_win,
        config: { displayName: 'Chance to beat control', unit: 'percentunit' },
      },
    ],
  });
}

export function projectsToVariable(projects: FlagsmithProject[]): MetricFindValue[] {
  return projects.map((p) => ({ text: p.name, value: String(p.id) }));
}

export function environmentsToVariable(envs: FlagsmithEnvironment[]): MetricFindValue[] {
  return envs.map((e) => ({ text: e.name, value: e.api_key }));
}

export function experimentsToVariable(experiments: Experiment[]): MetricFindValue[] {
  return experiments.map((e) => ({ text: e.name, value: String(e.id) }));
}
