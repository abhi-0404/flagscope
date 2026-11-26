import fs from 'node:fs';
import path from 'node:path';

// The provisioned Experiment Room dashboard lives in stack/grafana/dashboards. These checks catch the mistakes that
// only show up at runtime in Grafana: a wrong data source uid, an unknown query type, a `$flag_exposure` literal that
// Grafana would treat as a template variable, or a lost SRM panel.
const file = path.resolve(__dirname, '../../stack/grafana/dashboards/experiment-room.json');
const dashboard = JSON.parse(fs.readFileSync(file, 'utf8'));

interface Target {
  rawSql?: string;
  queryType?: string;
  environmentKey?: string;
  experimentId?: string;
  datasource?: { uid: string };
}
interface Panel {
  title: string;
  datasource: { uid: string };
  targets: Target[];
}
const panels = dashboard.panels as Panel[];

describe('Experiment Room dashboard JSON', () => {
  it('has the agreed uid and title', () => {
    expect(dashboard.uid).toBe('flagscope-experiment-room');
    expect(dashboard.title).toBe('Experiment Room');
  });

  it('only uses the two fixed data source uids', () => {
    for (const p of panels) {
      expect(['flagscope', 'flagscope-postgres']).toContain(p.datasource.uid);
      for (const t of p.targets) {
        expect(t.datasource?.uid).toBe(p.datasource.uid);
      }
    }
  });

  it('FlagScope queries use known query types and the dashboard variables', () => {
    const fsTargets = panels.filter((p) => p.datasource.uid === 'flagscope').flatMap((p) => p.targets);
    expect(fsTargets.length).toBeGreaterThanOrEqual(3);
    for (const t of fsTargets) {
      expect(['experiments', 'results']).toContain(t.queryType);
      expect(t.environmentKey).toBe('$environment');
      if (t.queryType === 'results') {
        expect(t.experimentId).toBe('$experiment');
      }
    }
  });

  it('SQL never contains the literal $flag_exposure (Grafana would read it as a variable)', () => {
    const sql = panels.flatMap((p) => p.targets.map((t) => t.rawSql ?? '')).filter(Boolean);
    expect(sql.length).toBeGreaterThanOrEqual(4);
    for (const q of sql) {
      expect(q).not.toMatch(/\$flag_exposure/);
      expect(q).toMatch(/\$experiment/);
      // read only: no statement other than SELECT
      expect(q).not.toMatch(/\b(insert|update|delete|drop|alter|create|grant|truncate)\b/i);
    }
  });

  it('only counts exposures of this experiment, inside its start and end time', () => {
    const sql = panels.flatMap((p) => p.targets.map((t) => t.rawSql ?? '')).filter((q) => /first_exposure AS/.test(q));
    expect(sql.length).toBe(5);
    for (const q of sql) {
      const cte = /first_exposure AS \(([\s\S]*?)\n\)/.exec(q)![1];
      expect(cte).toMatch(/s\."timestamp" >= exp\.started_at/);
      expect(cte).toMatch(/exp\.ended_at IS NULL OR s\."timestamp" <= exp\.ended_at/);
      expect(cte).toMatch(/substring\(s\.metadata from '"experiment_id" \*: \*"\?\(\[0-9\]\+\)'\)/);
      expect(cte).toMatch(/= exp\.experiment_id::text/);
    }
  });

  describe('SRM critical value (p < 0.01) in the SQL', () => {
    const srmSql = panels.flatMap((p) => p.targets.map((t) => t.rawSql ?? '')).filter((q) => /CASE df/.test(q));
    // Chi-square 0.99 quantiles (standard tables).
    const exact: Record<number, number> = {
      1: 6.6349,
      2: 9.2103,
      3: 11.3449,
      4: 13.2767,
      5: 15.0863,
      6: 16.8119,
      7: 18.4753,
      8: 20.0902,
      10: 23.2093,
      15: 30.5779,
      20: 37.5662,
      30: 50.8922,
    };

    it('is used by the SRM stat, the exposure split and the observed vs expected table', () => {
      expect(srmSql.length).toBe(3);
    });

    it('counts variants outside the plan instead of dropping them, and only planned arms in df', () => {
      for (const q of srmSql) {
        expect(q).toMatch(/FROM expected x FULL JOIN observed o USING \(variant\)/);
        expect(q).not.toMatch(/LEFT JOIN observed/);
        expect(q).toMatch(/GREATEST\(count\(\*\) FILTER \(WHERE p > 0\) - 1, 0\) AS df/);
        expect(q).toMatch(/SUM\(observed\) FILTER \(WHERE p = 0\), 0\) AS unplanned/);
      }
    });

    it('sums allocations as numeric, so arms adding up to 100 leave control at exactly 0', () => {
      for (const q of srmSql) {
        expect(q).toMatch(/mv\.percentage_allocation::numeric \/ 100 AS p/);
        expect(q).not.toMatch(/percentage_allocation \/ 100\.0/);
      }
    });

    it('treats NULL and empty variant values as the same arm on both sides of the join', () => {
      for (const q of srmSql) {
        expect(q).toMatch(/SELECT COALESCE\(NULLIF\(variant, ''\), '\(empty\)'\) AS variant, p FROM alloc/);
        expect(q).toMatch(/SELECT COALESCE\(NULLIF\(\(SELECT control_value FROM exp\), ''\), '\(empty\)'\), 1 -/);
        expect(q).toMatch(/observed AS \(SELECT COALESCE\(NULLIF\(variant, ''\), '\(empty\)'\) AS variant, count/);
      }
    });

    it('does not mark variants "(not in plan)" when no allocation was found at all', () => {
      const tables = srmSql.filter((q) => /not in plan/.test(q));
      expect(tables.length).toBe(2);
      for (const q of tables) {
        expect(q).toMatch(/CASE WHEN c\.planned_arms > 0 AND j\.p = 0 AND j\.observed > 0 THEN/);
        expect(q).toMatch(/CASE WHEN c\.planned_arms > 0 THEN round\(j\.expected::numeric, 1\) END AS expected/);
      }
    });

    it('turns red on any unplanned exposure, but not when the experiment has no allocation yet', () => {
      const stat = srmSql.filter((q) => /AS srm/.test(q));
      expect(stat.length).toBe(1);
      expect(stat[0]).toMatch(
        /WHEN planned_arms = 0 THEN 0\s+WHEN unplanned > 0 THEN 1\s+WHEN total >= 100 AND chi > lim/
      );
    });

    it('handles df = 0 (one arm, experiment not started) before the Wilson-Hilferty branch divides by df', () => {
      for (const q of srmSql) {
        expect(q).toMatch(/CASE df WHEN 0 THEN NULL WHEN 1 THEN/);
      }
    });

    it('matches the chi-square tables: exact for df 1-6, Wilson-Hilferty within 0.3 percent above', () => {
      for (const q of srmSql) {
        const table = Object.fromEntries(
          Array.from(q.matchAll(/WHEN (\d+) THEN ([\d.]+)/g)).map((m) => [Number(m[1]), Number(m[2])])
        );
        const wh = /ELSE df \* \(1 - 2\.0 \/ \(9 \* df\) \+ ([\d.]+) \* sqrt\(2\.0 \/ \(9 \* df\)\)\) \^ 3 END/.exec(q);
        expect(wh).not.toBeNull();
        const z = Number(wh![1]);
        for (const [dfText, want] of Object.entries(exact)) {
          const df = Number(dfText);
          const got = table[df] ?? df * Math.pow(1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df)), 3);
          const tolerance = table[df] !== undefined ? 0.001 : 0.003;
          expect(Math.abs(got - want) / want).toBeLessThan(tolerance);
        }
      }
    });
  });

  it('keeps the SRM panel, the flag-change annotation and the three variables', () => {
    expect(panels.some((p) => /SRM/.test(p.title))).toBe(true);
    const names = (dashboard.templating.list as Array<{ name: string }>).map((v) => v.name);
    expect(names).toEqual(['project', 'environment', 'experiment']);
    const flagAnnotation = (dashboard.annotations.list as Array<{ target?: { tags?: string[] } }>).find((a) =>
      a.target?.tags?.includes('flagsmith')
    );
    expect(flagAnnotation).toBeDefined();
  });
});
