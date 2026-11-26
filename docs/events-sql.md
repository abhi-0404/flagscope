# Flagsmith database warehouse: events table and the two FlagScope queries

Verified on Flagsmith 2.295.2 (self-hosted, Postgres 15.5, "Flagsmith database" warehouse), 2026-11-25.
Both queries below were run in psql against real simulated traffic and returned the expected rows.

## Where the events live

`\dt *.*` shows these experimentation tables in the `public` schema of the `flagsmith` database:

| Table | Purpose |
|---|---|
| `experimentation_sdkexperimentationevent` | **Raw SDK events (exposures AND custom events).** This is the one to chart live. |
| `experimentation_experiment` | Experiment row (status, started_at, environment_id, feature_id, rollout_segment_id). |
| `experimentation_experimentmetric`, `experimentation_metric` | Metric definitions and experiment links. |
| `experimentation_experimentresults` | Cached results, `payload` jsonb (same JSON the REST results endpoint returns). |
| `experimentation_experimentexposures` | Cached exposures time series, `payload` jsonb. |
| `experimentation_warehouseconnection`, `experimentation_warehousedeliverystatus` | Warehouse config and status. |

### `experimentation_sdkexperimentationevent` columns

| Column | Type | Notes |
|---|---|---|
| id | bigint identity | PK |
| environment_key | text | The environment API key (client key), NOT the numeric id. Join to `environments_environment.api_key`. |
| event | text | `$flag_exposure` for exposures; the custom event name otherwise (`checkout_completed`). |
| feature_name | text | Set for exposures (`paypal_button`). NULL for custom events. |
| timestamp | timestamptz | Client (SDK) event time. |
| collected_at | timestamptz | Server receive time (batch flush time). |
| identifier | text | The identity. Joins exposures to conversions. |
| value | text | For exposures: the variant value served (`control`, `variant_a`, `variant_b`). NULL for the simulator's conversions. |
| traits, metadata | text | metadata for exposures is JSON text: `{"experiment_id":1,"sdk_version":"9.5.0"}`. |
| sdk_language, sdk_version | text | `nodejs`, `unknown`. |

Indexes: `(environment_key, event, feature_name, timestamp)` and `(environment_key, event, identifier, timestamp)`. Both queries below use them.

**Exposures are rows in this table**, written by `getExperimentFlag()` (event `$flag_exposure`, `value` = the variant). The control arm is the feature's `initial_value` (`control`). The conversion event carries no variant, so a conversion is attributed by joining on `identifier` to the identity's first exposure. One identity can emit several exposure rows, so always take the first one (`DISTINCT ON (identifier)`).

Sample counts after 1,530 simulated users: 1,530 `$flag_exposure` rows and 196 `checkout_completed` rows.

## Query 1: exposures per minute per variant (live time series)

Grafana treats `$name` as a template variable, so the literal event name `$flag_exposure` is written as `chr(36) || 'flag_exposure'` in every query below (tested in psql, returns the same 1,530 rows).

Grafana PostgreSQL data source, "Time series", format "Time series". Replace the two literals with dashboard variables (`$environment_key`, `$feature`).

```sql
WITH first_exposure AS (
  SELECT DISTINCT ON (identifier)
         identifier, value AS variant, "timestamp" AS exposed_at
  FROM experimentation_sdkexperimentationevent
  WHERE environment_key = '$environment_key'
    AND event = chr(36) || 'flag_exposure'
    AND feature_name = '$feature'
    AND $__timeFilter("timestamp")
  ORDER BY identifier, "timestamp"
)
SELECT date_trunc('minute', exposed_at) AS time,
       variant AS metric,
       count(*) AS exposures
FROM first_exposure
GROUP BY 1, 2
ORDER BY 1, 2;
```

Tested form (no Grafana macros) returned, for example:

```
 time                   | variant   | exposures
 2026-11-25 14:43:00+00 | control   |       166
 2026-11-25 14:43:00+00 | variant_a |       181
 2026-11-25 14:43:00+00 | variant_b |       185
```

Note: `$__timeFilter` is applied inside the CTE on the event time, which means an identity first seen before the window can re-appear as "new" at the window edge. For a live "last 1h" panel this is acceptable. For exactness, drop the macro from the CTE and filter on `exposed_at` in the outer query.

### Query 1b: conversions per minute per variant

```sql
WITH first_exposure AS (
  SELECT DISTINCT ON (identifier) identifier, value AS variant, "timestamp" AS exposed_at
  FROM experimentation_sdkexperimentationevent
  WHERE environment_key = '$environment_key' AND event = chr(36) || 'flag_exposure' AND feature_name = '$feature'
  ORDER BY identifier, "timestamp"
), conv AS (
  SELECT DISTINCT ON (identifier) identifier, "timestamp" AS converted_at
  FROM experimentation_sdkexperimentationevent
  WHERE environment_key = '$environment_key' AND event = '$metric_event'
  ORDER BY identifier, "timestamp"
)
SELECT date_trunc('minute', c.converted_at) AS time, f.variant AS metric, count(*) AS conversions
FROM conv c JOIN first_exposure f USING (identifier)
WHERE c.converted_at >= f.exposed_at AND $__timeFilter(c.converted_at)
GROUP BY 1, 2 ORDER BY 1, 2;
```

(`$metric_event` = `checkout_completed`.) Tested form returned 13/19/34 (control/a/b) in the first minute, matching the 51/53/92 totals in the REST results.

## Query 2: SRM (sample ratio mismatch) chi-square inputs

Inputs per variant: observed exposures (first exposure per identity), the expected share, and the resulting chi-square statistic.

The expected share comes from the experiment's rollout: Flagsmith stores it as a segment override on the feature (`experimentation_experiment.rollout_segment_id`), with the non-control variants' `percentage_allocation` in `multivariate_multivariatefeaturestatevalue`. Control = 100 minus the sum of the others (control is the feature's `initial_value`).

```sql
WITH exp AS (
  SELECT e.id, e.feature_id, e.environment_id, env.api_key, f.name AS feature_name,
         f.initial_value AS control_value, e.rollout_segment_id, e.started_at, e.ended_at
  FROM experimentation_experiment e
  JOIN environments_environment env ON env.id = e.environment_id
  JOIN features_feature f ON f.id = e.feature_id
  WHERE e.id = $experiment_id
),
alloc AS (
  SELECT mo.string_value AS variant, mv.percentage_allocation::numeric / 100 AS p
  FROM exp e
  JOIN features_featuresegment fsg ON fsg.segment_id = e.rollout_segment_id
       AND fsg.feature_id = e.feature_id AND fsg.environment_id = e.environment_id
  JOIN features_featurestate fs ON fs.feature_segment_id = fsg.id AND fs.deleted_at IS NULL
  JOIN multivariate_multivariatefeaturestatevalue mv ON mv.feature_state_id = fs.id
  JOIN multivariate_multivariatefeatureoption mo ON mo.id = mv.multivariate_feature_option_id
),
expected AS (
  SELECT COALESCE(NULLIF(variant, ''), '(empty)') AS variant, p FROM alloc
  UNION ALL
  SELECT COALESCE(NULLIF((SELECT control_value FROM exp), ''), '(empty)'), 1 - COALESCE(SUM(p), 0) FROM alloc
),
first_exposure AS (
  SELECT DISTINCT ON (s.identifier) s.identifier, s.value AS variant
  FROM experimentation_sdkexperimentationevent s
  JOIN exp e ON s.environment_key = e.api_key AND s.feature_name = e.feature_name
  WHERE s.event = chr(36) || 'flag_exposure'
    AND s."timestamp" >= e.started_at
    AND (e.ended_at IS NULL OR s."timestamp" <= e.ended_at)
    AND COALESCE(substring(s.metadata from '"experiment_id" *: *"?([0-9]+)'), e.id::text) = e.id::text
  ORDER BY s.identifier, s."timestamp"
),
observed AS (SELECT COALESCE(NULLIF(variant, ''), '(empty)') AS variant, count(*)::float AS o FROM first_exposure GROUP BY 1),
joined AS (
  SELECT variant, COALESCE(o.o, 0) AS observed, COALESCE(x.p, 0) AS p,
         SUM(COALESCE(o.o, 0)) OVER () * COALESCE(x.p, 0) AS expected
  FROM expected x FULL JOIN observed o USING (variant)
)
SELECT variant, observed, round(expected::numeric, 1) AS expected,
       sum((observed - expected) ^ 2 / NULLIF(expected, 0)) OVER () AS chi_square,
       count(*) FILTER (WHERE p > 0) OVER () - 1 AS df,
       COALESCE(sum(observed) FILTER (WHERE p = 0) OVER (), 0) AS unplanned,
       exp(-sum((observed - expected) ^ 2 / NULLIF(expected, 0)) OVER () / 2) AS p_value_df2
FROM joined;
```

Tested result (healthy split, experiment 1, three arms so df = 2):

```
 variant   | observed | expected | chi_square | df | unplanned | p_value_df2
 variant_a |      504 |    509.5 |      0.144 |  2 |         0 |       0.930
 variant_b |      516 |    509.5 |      0.144 |  2 |         0 |       0.930
 control   |      510 |    511.0 |      0.144 |  2 |         0 |       0.930
```

Variant values: NULL and the empty string both count as one arm, shown as `(empty)`, on both the plan side and the exposure side, so a feature whose control value is empty still matches its own exposures.

Which exposures count: only exposures of this experiment. The CTE keeps events from `started_at` to `ended_at` (open while running) and, when the event metadata names an `experiment_id`, only that id. So re-running an experiment on the same feature does not mix in the old run's traffic. Events with no `experiment_id` in metadata fall back to the time window alone.

Variants outside the plan: the FULL JOIN keeps exposures whose variant value has no planned share (expected 0). They are left out of the chi-square sum and of `df`, and any `unplanned` count above 0 is a mismatch on its own: the dashboard SRM stat turns red for it, whatever the sample size. Exception: when no allocation is found at all (no rollout segment override, for example after it was removed), the dashboard has no plan to compare with, so the SRM stat stays at "Split OK" and the tables leave `expected` and `chi_square` empty instead of marking every variant "(not in plan)".

Notes for the alert rule:

- `p_value_df2 = exp(-chi_square / 2)` is the exact chi-square survival function only for **df = 2** (control plus two variants), which is the demo. For a two-arm experiment (df = 1) alert on `chi_square > 6.63` (p < 0.01) instead. Even df has the closed form `exp(-x/2) * sum_{i<df/2} (x/2)^i / i!`; odd df needs erfc.
- Suggested rule: fire when `chi_square > 9.21` (df = 2, p < 0.01) and total observed >= 200. Reduce to one row in Grafana with a "Reduce" expression on `chi_square`.
- Flagsmith's own results payload also has a field `srm_p_value`, but it was `null` in 2.295.2 even with 1,530 exposures. Do not depend on it; compute from SQL.
- Allocation percentages are floats (33.3 + 33.3, control 33.4). Expected shares use the stored values, so a "perfect" split still shows a tiny chi-square. They are cast to `numeric` before summing: in float, 60 + 30 + 10 leaves a control share of 1e-16 instead of 0 (and 34 + 56 + 10 a negative one), which would hide control exposures that are not in the plan and can turn the chi-square negative.
- Grafana needs a read-only role on these tables (`experimentation_*`, `features_*`, `multivariate_*`, `environments_environment`). Phase 1 task: `postgres-init/01-readonly.sql`. Postgres runs as `postgres` / `password` in the official compose.
