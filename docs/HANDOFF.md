# FlagScope HANDOFF (end of Phase 2, 2026-11-26)

Read `phase0-facts.md` for every verified fact and surprise, `events-sql.md` for the SQL. The Phase 2 summary is the first section below.

## Phase 2 (gatekeeper, dashboard, simulator, README)

What changed:

- **Gatekeeper** `stack/gatekeeper/gatekeeper.mjs` (+ `gatekeeper.test.mjs`, 19 `node:test` tests, zero dependencies). Compose service
  `gatekeeper` (node:22-alpine, read only, cap_drop ALL, no published port). It holds the master key and forwards only the exact
  allow-list (GET version, projects, environments?project=, experiments list/detail/results/exposures; POST
  results/refresh only; project features and featurestates were removed in the review). Everything else is 403 without reaching Flagsmith. It strips the client Authorization, rebuilds
  the upstream path and query from validated parts, rejects `..`, any `%`, `//`, `;`, backslash, unknown or repeated query keys, and never
  forwards a body. Logs method, path (no query) and status only. Key source: `MASTER_KEY` env or `MASTER_KEY_FILE` (re-read on change).
  The stack uses the file because the key only exists after bootstrap: bootstrap writes `.generated/gatekeeper/master-key`, and only
  that folder is mounted into the gatekeeper. `/healthz` is answered locally.
- **No key in Grafana**: the FlagScope data source points at `http://gatekeeper:8080` with no secureJsonData. On an existing volume
  bootstrap deletes and recreates the data source if it still holds a stored `apiKey` (tested). `plugin.json` routes are unchanged (the
  empty `Authorization: Api-Key` header the route renders is dropped by the gatekeeper). ConfigEditor: the key is optional and the text
  explains the gatekeeper. The bootstrap smoke test now also requires `GET .../identities/` through the proxy to answer 403.
- **Anonymous Viewer enabled** in the demo stack (`GF_AUTH_ANONYMOUS_ENABLED=true`, role Viewer). Refresh stays Admin only (anonymous
  POST results/refresh gets Grafana 403 "plugin proxy route access denied"). The Experiment Room is the Grafana home dashboard.
  Residual: an anonymous Viewer can also run read-only SQL through the PostgreSQL data source on the granted tables (simulated
  identifiers, client environment keys). Acceptable for a local demo, documented in the README.
- **Experiment Room** `stack/grafana/dashboards/experiment-room.json`, uid `flagscope-experiment-room`, provisioned by
  `stack/grafana/provisioning/dashboards/dashboards.yaml`. 8 panels: experiments table, chance to beat control (bar gauge via
  `rowsToFields`), results table, conversions per minute, exposures per minute, SRM stat (red "SRM DETECTED" when p < 0.01 and at least
  100 exposures; the critical value is computed for any number of arms), exposure split, observed vs expected table. Flag changes show as
  annotations (Grafana annotations tagged `flagsmith`). Variables: project, environment, experiment (FlagScope variable queries); the
  Postgres panels only need `$experiment` (environment, feature, metric event and allocation are looked up in SQL). The JSON was
  generated; if you edit it by hand keep `plugin/tests/dashboard.test.ts` green.
  Rendered and checked in headless Edge: `docs/img/experiment-room.png` (healthy) and `docs/img/srm-red.png` (after `--skew 70`).
- **Simulator** `simulator/simulate.mjs`: `--users N --skew P --seed S --lift --base --env --url --state --no-refresh`. Seeded
  (mulberry32), deterministic identities. `--skew 70` forces 70 percent of exposures onto control (it probes the arm with
  `getIdentityFlags`, which records no exposure, then exposes with `getExperimentFlag`). It reads the env key, master key and
  experiment id from `stack/.generated/state.json` (or `--state <file>`, absolute path when run through `pnpm --dir simulator`) and asks
  Flagsmith to refresh results at the end (429 is reported, not fatal). `pnpm --dir simulator simulate ...` works.
- **README.md** (root) and a short `plugin/README.md` written. Dashboard test added (`plugin/tests/dashboard.test.ts`).

Verified on a fresh separate project (`flagscope-test`, ports 18000/13000/18001, removed with `down -v` afterwards): up in 148 s,
bootstrap run 2 = `0 change(s) (no-op)`, 300 simulated users, dashboard exists and is provisioned (admin and anonymous), all 5 Postgres
panel queries return rows through `/api/ds/query`, results through the FlagScope route have n 105/96/99, disallowed paths answer 403 from
the gatekeeper, `--skew 70` turns the SRM panel red (chi-square about 100), a flag toggle created Grafana annotations. Not run against
the existing Phase 0 volumes (the main stack is stopped and untouched).

Known quirks:
- Grafana does not hot-reload a dashboard file that was added or changed after start on the Docker Desktop (Windows) bind mount:
  `docker restart <grafana container>` after editing the JSON. A fresh `up` provisions it correctly.
- `plugin/dist` must be built before `docker compose up` (the quickstart says so). A release zip or an image build is Phase 3.
- The Feature Health alert RULE (SRM to contact point) is still not provisioned, only the contact point.
- Plugin query types `exposures` and `flag-states` are NOT implemented (the gatekeeper still allow-lists the aggregate exposures GET;
  the project features and featurestates rules were removed in the review because they expose remote config values and owners). The dashboard reads exposures from Postgres.

## Phase 2 review (security and SRM pass)

Fixed:
- Gatekeeper: removed the unused `features` and `feature-states` rules (remote config values, feature owners' names and emails were
  readable by any Viewer); a malformed key (CR/LF) crashed the whole process on the next request, now 503; `MASTER_KEY` is trimmed;
  request bodies over 16 KiB disconnect the client (was drained without limit); the upstream request build is wrapped so a throw
  cannot kill the proxy. Tests added for raw-socket smuggling (CL+TE, duplicate CL, pipelining), lowercase and absolute-form request
  lines, Host / X-Forwarded-* / X-HTTP-Method-Override, case and trailing-dot near misses, CONNECT/TRACE, the body cap, the bad key,
  and an upstream that echoes the key back.
- SRM SQL (3 panels): `df = 0` (no rollout allocation yet, one arm) hit `2.0 / (9 * df)` and failed the panel with "division by
  zero"; now `WHEN 0 THEN NULL` (panel shows Split OK, no limit). `dashboard.test.ts` pins this and checks the critical values against
  chi-square tables (exact for df 1-6, Wilson-Hilferty within 0.3 percent above).
- README: simulator commands now say to run from the repo root (they were shown right after `cd ../stack`, where `--dir simulator`
  fails); gatekeeper table and refusal list match the code; own-gatekeeper `docker run` uses `MASTER_KEY_FILE`; the SRM limit no longer
  claims "exact for any number of arms". `.gitignore` covers `gatekeeper-secrets/`.

Open (not fixed, need the live stack to verify):
- SRM counts every first exposure of the feature in the environment, with no `started_at` or `metadata.experiment_id` filter, so a
  re-run experiment on the same feature mixes old traffic in.
- SRM `joined` starts from the planned arms, so exposures with an unplanned variant value are dropped from the test instead of
  raising it. A FULL JOIN with "unplanned variant seen = SRM" would close it.
- Conversions panel: `conv` takes the first conversion per identity over all time, so an identity that converted before its exposure
  and again after is not counted.
- `$experiment` is interpolated raw into SQL; no escalation today (Viewers can already run read-only SQL on that data source), but
  `${experiment:sqlstring}` would be cleaner.
- Check whether Viewers (and anonymous) can read the Feature Health contact point URL (it embeds the webhook secret) in Grafana 13.

## What exists

```
flagscope/
  .gitignore                     ignores .env, .generated/, .generated-*/, gatekeeper-secrets/, node_modules/, dist/
  stack/
    docker-compose.yml           Flagsmith 2.295.2 (pinned) + postgres 15.5 + task processor + Grafana 13.2.7 + gatekeeper + db-roles + bootstrap
    gatekeeper/                  gatekeeper.mjs (allow-list proxy) + gatekeeper.test.mjs (node --test stack/gatekeeper/gatekeeper.test.mjs)
    grafana/                     provisioning/dashboards/dashboards.yaml + dashboards/experiment-room.json
    docker-compose.orig.yml      the official compose, unchanged, for diffing
    bootstrap.mjs                zero-dependency, idempotent, REST only (runs in node:22-alpine as the `bootstrap` service)
    postgres-init/01-readonly.sql  read-only role grafana_ro (run by the one-shot `db-roles` service, idempotent)
    .env / .env.example          GRAFANA_ADMIN_PASSWORD (.env is gitignored); optional ports, GRAFANA_RO_PASSWORD, GENERATED_DIR
    .generated/                  GITIGNORED: credentials.txt, state.json (Phase 0 data; bootstrap rewrites them only if content differs)
    phase0/                      throw-away Phase 0 scripts (superseded by bootstrap.mjs, delete later)
  simulator/simulate.mjs         real @flagsmith/nodejs 9.5.0: --users N --skew P --seed S (see Phase 2)
  plugin/
    src/api/{client,types}.ts    typed read-only Flagsmith calls through the Grafana data proxy route, refresh throttle
    src/query/transform.ts       API JSON to DataFrames (experiments, results) and variable values (pure functions)
    src/datasource.ts            query(), testDatasource(), metricFindQuery(), template variable interpolation
    src/components/{ConfigEditor,QueryEditor}.tsx
    src/plugin.json              route `flagsmith` -> {{ .JsonData.flagsmithUrl }} with `Authorization: Api-Key {{ .SecureJsonData.apiKey }}`
    tests/                       6 suites, 56 tests (adds dashboard.test.ts); tests/fixtures/ holds the 42 recorded responses plus projects-list.json (moved from plugin-fixtures/)
  docs/                          this file, phase0-facts.md, events-sql.md, img/ (two dashboard screenshots)
  README.md                      root readme (problem, quickstart, own-Grafana install, gatekeeper note, how Flagsmith is used)
```

## Start, stop, reset

```powershell
cd "D:\personal\hackathons\Flagsmith Hackathon\flagscope\stack"
$env:Path += ";C:\Users\kumar\AppData\Local\Programs\DockerDesktop\resources\bin"   # docker is not on PATH
docker compose up -d --wait     # fresh volume: about 3 min on this PC (postgres first start is slow), warm: about 30 s
docker compose stop             # stop, KEEP data
docker compose down             # remove containers, keep volumes
docker compose down -v          # WIPES data; the next `up -d --wait` rebuilds everything through bootstrap
docker compose run --rm bootstrap node /app/bootstrap.mjs    # re-run bootstrap (prints "0 change(s) (no-op)" when nothing to do)
```

`up -d --wait` returns only when bootstrap finished OK: the bootstrap container idles after success (`tail -f`) and its
healthcheck waits for `.generated/.bootstrap-ok`. A failed bootstrap exits non-zero and fails the `up`.
From Git Bash prefix `MSYS_NO_PATHCONV=1` before `docker compose run ... /app/bootstrap.mjs` (path mangling); PowerShell is fine.

Credentials: `stack\.generated\credentials.txt`. Never commit it. Grafana login is `admin` plus the password in `stack\.env`.
UI: Flagsmith http://localhost:8000, Grafana http://localhost:3000.

**Existing Phase 0 volumes** (`flagscope_pgdata`, `flagscope_grafana-data`): `up -d` will recreate the postgres container
(the fixed `container_name: flagsmith_postgres` was removed so a second project can run), create `grafana_ro`, and bootstrap will
add the two Grafana data sources next to the existing data. Nothing is deleted. Not yet run against the Phase 0 volume.

Isolated second copy (how Phase 1 was tested, own volumes, leaves Phase 0 data alone):

```powershell
$env:FLAGSMITH_PORT=18000; $env:GRAFANA_PORT=13000; $env:TASK_PROCESSOR_PORT=18001; $env:GENERATED_DIR="./.generated-test"
New-Item -ItemType Directory -Force .generated-test
docker compose -p flagscope-test up -d --wait
docker compose -p flagscope-test down -v ; Remove-Item -Recurse .generated-test
```

Plugin:

```powershell
cd plugin
pnpm install
pnpm build            # writes plugin\dist, mounted read only into Grafana (reload the Grafana page after a rebuild)
pnpm typecheck; pnpm lint; pnpm test:ci     # never `pnpm test` (watch mode)
```

## Phase 1 exit criteria

| Criterion | Result |
|---|---|
| Fresh `docker compose up -d --wait` gives Grafana with FlagScope + PostgreSQL data sources | Done, verified on a fresh volume (separate project `flagscope-test`) |
| Bootstrap twice, second run is a no-op | Done: first run `21 change(s)`, second `0 change(s) (no-op)` |
| Data source test OK via Grafana API | Done through the data proxy (the plugin has no backend, so `/health` does not apply): `/version/` 200 with experimentation_enabled, `/api/v1/projects/` 200 with the injected key; PostgreSQL `/health` OK |
| Read-only role | Done: SELECT on events works, `users_ffadminuser` denied, `CREATE TABLE` refused |
| Results through the data source | Done with 300 simulated users: refresh 202, results via proxy had n 108/90/102 per variant |
| Plugin build, typecheck, lint, test:ci | All green (41 tests). Not checked in a real browser (query editor and config editor UI never rendered) |

## Decisions and deviations

- Bootstrap lives at `stack/bootstrap.mjs` (task brief) and the read-only role runs from a one-shot `db-roles` service instead of
  `docker-entrypoint-initdb.d` (init scripts run only on an empty volume and before the tables exist). Grants cover only
  `experimentation_*` (except `experimentation_warehouse*`), `features_*`, `multivariate_*`, `environments_environment`.
- Variable queries are a small text DSL: `projects`, `environments(<project id>)`, `experiments(<environment key>)`, arguments may be
  variables. No custom variable editor yet.
- Results query: `refresh` (default on) sends `results/refresh/` at most once per 5 min per experiment (in-memory per browser tab,
  429 seeds the throttle from "available in N seconds"), then reads results; the first read after a refresh can still be the old
  data. A frame notice shows "Next refresh in mm:ss".
- `GET /api/v1/projects/` with a master key returns a bare array (recorded in `projects-list.json`); the client accepts both shapes.
- Data proxy routes are locked down (reviewer pass, verified on grafana/grafana:13.2.7 with an echo upstream, project
  `flagscope-routecheck`, removed after): `GET flagsmith/version/` (no key), `GET flagsmith/api/v1/projects/`,
  `GET flagsmith/api/v1/environments/` (key), `POST flagsmith/api/v1/environments/` with `reqRole: Admin` (key). PUT, PATCH,
  DELETE and any path outside those prefixes match no route and are not forwarded (Grafana 502). A Viewer or Editor refresh
  gets 403, the client treats it as read only (results still shown, notice "Results refresh needs the Grafana Admin role").
  Grafana routes match by prefix only (no wildcards), so: (a) the Admin POST route can POST anything under environments/
  (acceptable: an org Admin can already repoint flagsmithUrl and capture the key); (b) Viewers can GET anything under
  projects/ and environments/ with the master key, including identities (PII), server-side environment keys, webhooks and
  the Feature Health webhook URL (its secret). `tests/routes.test.ts` pins this table.
- Grafana anonymous viewer was DISABLED in Phase 1 because of (b). Phase 2 solved it with the gatekeeper (exact path allow-list in front
  of Flagsmith, no key in Grafana) and enabled anonymous Viewer in the demo stack.
- Plugin lint uses `Combobox` (the `Select` component is deprecated in Grafana 13).

## Open items for Phase 2 and later

1. **Plugin id org slug** `abhi0404` is a placeholder. Confirm the grafana.com org before the release zip.
2. Real Grafana alert delivery into Feature Health is still unproven; Grafana's test-notification path changed in v13 (see facts).
3. `srm_p_value` in Flagsmith results is null: compute SRM in SQL (events-sql.md Query 2), alert rule in Phase 3.
4. (done in Phase 2) simulator `--skew` and `--lift`.
5. Move `plugin/.github/workflows` to the repo root (and run `node --test stack/gatekeeper/gatekeeper.test.mjs` in CI); add pnpm-workspace.yaml, root package.json, LICENSE (MIT per plan; scaffold wrote Apache-2.0 into `plugin/LICENSE`, reconcile; the README says so).
6. Plugin query types `exposures`, `flag-states` and plugin-side annotations are not built (cut list); the dashboard JSON is provisioned (data source uids `flagscope`, `flagscope-postgres`).
7. If the Grafana service account token is rotated, bootstrap tries `PUT` on the Flagsmith Grafana integration (path unverified) and only warns if it fails.
8. `stack/phase0/` can be deleted once nobody needs the recipes. Nothing is committed or pushed; no git repo exists yet.
9. Dependencies: none added in Phase 1 (rxjs was the only addition in Phase 0). Combobox and everything used come from existing `@grafana/*` packages.

## SRM fixes after the Phase 2 review (Nov 26)
- Review findings 6 and 7 fixed in all five SQL panels of `experiment-room.json` and in `docs/events-sql.md` Query 2.
- Finding 6: `first_exposure` now keeps only exposures from `started_at` to `ended_at`, and only those whose metadata `experiment_id` matches (events with no id fall back to the time window). The conversions CTE uses the same window.
- Finding 7: `expected FULL JOIN observed`, so a variant value outside the plan shows as "(not in plan)" with expected 0, and any such exposure sets `srm = 1`. `df` counts planned arms only. With no allocation rows the check stays 0.
- Verified in psql against the stack data, inside a rolled-back transaction: baseline unchanged (chi 0.14); 1,000 pre-start and other-experiment exposures ignored; an untagged exposure counted; one `variant_z` exposure turns SRM red.
- Plugin tests 59 to 62. Finding 8 (first conversion ever) and 9 (`$experiment` unescaped) are still open.
- Reviewer pass on the SRM fixes (same day), all in panels 6-8, Query 2, README Limits and `tests/dashboard.test.ts` (plugin tests 62 to 65):
  - Allocation shares are summed as `numeric`. In float, splits like 60/30/10 left control at 1e-16 (and 34/56/10 at -2e-16), so control exposures that are not in the plan were not flagged and chi-square could go negative.
  - NULL and empty variant values map to `(empty)` on both join sides. Before, a feature with a NULL control value showed control twice and SRM went red on healthy traffic.
  - With no allocation found at all, the tables leave `expected` and `chi_square` empty instead of marking every variant "(not in plan)".
  - The metadata regex also accepts spaces before the colon (`"experiment_id" : 7`).
  - Checked against the stack data in rolled-back transactions, including as a temporary read-only role with the `01-readonly.sql` grants; the planner still uses `sdk_exp_event_feature_idx` with the `timestamp >= started_at` range.

## Session of Nov 26 (evening)
- `plugin/tests/dashboard.test.ts` updated for the shared SRM `verdict` CTE (stat, bar gauge and table panels; states: no exposures,
  plan unavailable = 2, SRM = 1, OK = 0) and a new test that the stat panel maps all four states. Plugin 66/66 pass, typecheck clean,
  gatekeeper 24/24 pass.
- Still uncommitted (not pushed): bootstrap.mjs, docker-compose.yml, gatekeeper, dashboard JSON, provisioning/alerting/, this test.
