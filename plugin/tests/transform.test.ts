import { FieldType } from '@grafana/data';
import {
  environmentsToVariable,
  experimentsToFrame,
  experimentsToVariable,
  formatCountdown,
  projectsToVariable,
  resultsToFrame,
} from '../src/query/transform';
import experimentsList from './fixtures/experiments-list.json';
import experimentDetail from './fixtures/experiments-detail-running-with-data.json';
import resultsFixture from './fixtures/experiments-results.json';
import resultsNull from './fixtures/experiments-results-null.json';
import environments from './fixtures/environments-list.json';
import projects from './fixtures/projects-list.json';
import type { Experiment, ExperimentResults } from '../src/api/types';

const experiment = experimentDetail as unknown as Experiment;
const results = resultsFixture.results as unknown as ExperimentResults;

const col = (frame: { fields: Array<{ name: string; values: unknown[] }> }, name: string) =>
  Array.from(frame.fields.find((f) => f.name === name)!.values);

describe('experimentsToFrame', () => {
  const frame = experimentsToFrame('A', experimentsList.results as unknown as Experiment[]);

  it('maps every column of the recorded list', () => {
    expect(frame.refId).toBe('A');
    expect(frame.length).toBe(1);
    expect(col(frame, 'id')).toEqual([1]);
    expect(col(frame, 'name')).toEqual(['PayPal button experiment']);
    expect(col(frame, 'feature')).toEqual(['paypal_button']);
    expect(col(frame, 'status')).toEqual(['running']);
    expect(col(frame, 'metrics')).toEqual(['checkout_completed']);
    expect(col(frame, 'hypothesis')[0]).toMatch(/PayPal/);
  });

  it('turns ISO dates into epoch ms time fields and null for a missing end date', () => {
    expect(frame.fields.find((f) => f.name === 'created')!.type).toBe(FieldType.time);
    expect(col(frame, 'created')).toEqual([Date.parse('2026-11-25T14:42:40.836807Z')]);
    expect(col(frame, 'started')).toEqual([Date.parse('2026-11-25T14:42:45.715538Z')]);
    expect(col(frame, 'ended')).toEqual([null]);
  });

  it('handles an empty list', () => {
    const empty = experimentsToFrame('A', []);
    expect(empty.length).toBe(0);
    expect(empty.fields.length).toBe(9);
  });
});

describe('resultsToFrame', () => {
  const frame = resultsToFrame('B', experiment, results);

  it('has one row per variant with control first', () => {
    expect(frame.length).toBe(3);
    expect(col(frame, 'variant')).toEqual(['control', 'variant_a', 'variant_b']);
    expect(col(frame, 'metric')).toEqual(Array(3).fill('checkout_completed'));
  });

  it('maps sample size, conversions and conversion rate from n and sum', () => {
    expect(col(frame, 'sample_size')).toEqual([510, 504, 516]);
    expect(col(frame, 'conversions')).toEqual([51, 53, 92]);
    const mean = col(frame, 'mean') as number[];
    expect(mean[0]).toBeCloseTo(0.1, 6);
    expect(mean[2]).toBeCloseTo(92 / 516, 6);
  });

  it('maps inference and leaves control null', () => {
    expect(col(frame, 'lift')).toEqual([null, 0.05158730158730154, 0.7829457364341086]);
    expect(col(frame, 'ci_low')[0]).toBeNull();
    expect(col(frame, 'ci_low')[2]).toBeCloseTo(0.21268, 4);
    expect(col(frame, 'ci_high')[1]).toBeCloseTo(0.43496, 4);
    expect(col(frame, 'chance_to_win')).toEqual([null, 0.6040073191960886, 0.996437358271238]);
    expect(frame.fields.find((f) => f.name === 'chance_to_win')!.config.unit).toBe('percentunit');
  });

  it('puts as_of, is_final and the refresh countdown in meta', () => {
    const withCountdown = resultsToFrame('B', experiment, results, { nextRefreshInSeconds: 289 });
    expect(withCountdown.meta?.custom).toMatchObject({
      asOf: '2026-11-25T14:44:30.402674Z',
      isFinal: false,
      nextRefreshInSeconds: 289,
    });
    expect(withCountdown.meta?.notices?.[0].text).toBe('Next refresh in 04:49');
  });

  it('returns an empty frame with a notice before the first refresh (results null)', () => {
    const empty = resultsToFrame('B', experiment, resultsNull.results as unknown as ExperimentResults | null);
    expect(empty.length).toBe(0);
    expect(empty.meta?.notices?.[0].text).toMatch(/No results yet/);
  });

  it('falls back to a metric id label when the experiment is unknown', () => {
    const f = resultsToFrame('B', undefined, results);
    expect(col(f, 'metric')[0]).toBe('metric 1');
  });

  it('warns when Flagsmith reports a results error', () => {
    const f = resultsToFrame('B', experiment, { ...results, last_error_at: '2026-11-25T15:00:00Z' });
    expect(f.meta?.notices?.some((n) => n.severity === 'warning')).toBe(true);
  });
});

describe('variables and helpers', () => {
  it('maps projects, environments (value is the key) and experiments', () => {
    expect(projectsToVariable(projects as never)).toEqual([{ text: 'FlagScope Demo', value: '1' }]);
    expect(environmentsToVariable(environments.results as never)).toEqual([
      { text: 'Development', value: 'iVKfD7DrG4H9U6iaNdWfgc' },
      { text: 'Production', value: 'm4SmaLEfA7jwa6mDnYFiht' },
    ]);
    expect(experimentsToVariable(experimentsList.results as never)).toEqual([
      { text: 'PayPal button experiment', value: '1' },
    ]);
  });

  it('formats a countdown as mm:ss', () => {
    expect(formatCountdown(289)).toBe('04:49');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5)).toBe('00:00');
    expect(formatCountdown(600)).toBe('10:00');
  });
});
