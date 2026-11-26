# Phase 0 facts (2026-11-25)

Everything below was observed on a real local run, not read from docs. Tags: RESOLVED / UNRESOLVED / CORRECTION (differs from 02-verification-and-plan.md or 06-api-feasibility.md).

## Versions pinned

| Component | Image / version | Notes |
|---|---|---|
| Flagsmith API + frontend + task processor | `docker.flagsmith.com/flagsmith/flagsmith:2.295.2` (sha256:48905c66...15ea35) | `GET /version/` reports `image_tag 2.295.2`, `experimentation_enabled: true`, `is_enterprise: false`. |
| Postgres | `postgres:15.5-alpine` | user `postgres`, password `password`, db `flagsmith` (official compose default, local only). |
| Grafana | `grafana/grafana:13.2.7` (OSS) | `grafana/grafana-oss` has no 13.2.x tag; `grafana/grafana` is the same OSS edition. The scaffold requires Grafana >= 13.2.0 (`grafanaDependency`), so 13.0.x is too old. |
| node (for scaffold, later bootstrap) | `node:22-alpine` | host Node is 22.23.5. |
| `@grafana/create-plugin` | 9.0.4 | refuses to run on Windows, see below. |
| `@flagsmith/nodejs` | 9.5.0 | already in the pnpm store, `getExperimentFlag` + `trackEvent` work. |
| Plugin deps | `@grafana/*` 13.2.4, react 19, jest 30, webpack 5.113, typescript 5.9.2, rxjs 7.8.2 | rxjs added explicitly (approved in B.5) because pnpm's strict layout hides it from `tsc`. |

Official compose source: `https://raw.githubusercontent.com/Flagsmith/flagsmith/main/docker-compose.yml`, saved unchanged as `stack/docker-compose.orig.yml`. Our `stack/docker-compose.yml` differs by: image tag pinned to 2.295.2, `name: flagscope`, `SSRF_ALLOWED_HOSTS`, a `grafana` service (with network alias `grafana.flagscope.local`) and a `grafana-data` volume.

## Credentials

All in `flagscope/stack/.generated/credentials.txt` (gitignored; also `state.json` there) and `flagscope/stack/.env` (Grafana admin password, gitignored). Contains: Flagsmith admin email + password, org master API key, Development environment key, Grafana admin password, Grafana service-account token. Nothing secret is in `plugin-fixtures/` (scanned; the API key, login token, master key id, Grafana token and webhook secret are redacted).

IDs: org 1, project 1 ("FlagScope Demo"), environments Development (key in credentials file, id 1) and Production, feature `paypal_button` id 1, metric `checkout_completed` id 1, experiment 1 (running).

## Measured RAM (`docker stats --no-stream`, idle, after ~1,500 simulated users)

| Container | RAM |
|---|---|
| flagscope-flagsmith-1 (API + UI) | 533 MiB |
| flagscope-flagsmith-task-processor-1 | 250 MiB |
| flagscope-grafana-1 | 254 MiB |
| flagsmith_postgres | 91 MiB |
| **FlagScope stack total** | **about 1.13 GB** (plan estimated 2.5-3 GB) |

Docker Desktop VM cap is 6 GB (`.wslconfig`). Two containers named `docker-db-1` and `docker-redis-1` (about 70 MiB) belong to another project on this PC and were not touched. Fixed container name `flagsmith_postgres` (from the official compose) will collide if another stack uses it.

## API paths: found or unresolved

| Item | Status | Path and body |
|---|---|---|
| Flagsmith Grafana integration (annotations) | **RESOLVED** | `POST /api/v1/projects/{project_pk}/integrations/grafana/` body `{"base_url":"http://grafana.flagscope.local:3000","api_key":"<grafana service account token, role Editor>"}`. The environment-level path (`/environments/{key}/integrations/grafana/`) returns **403** for both the user token and the master key; org-level also exists. Verified end to end: toggling a flag created a Grafana annotation "Flag state updated for feature: paypal_button" with tags `flagsmith, project:..., environment:Development, feature:paypal_button, flag:enabled` (fixture `grafana-annotations-after-flag-change.json`). |
| Feature Health provider create | **RESOLVED** | `POST /api/v1/projects/{project_pk}/feature-health/providers/` body `{"name":"Grafana"}` (enum `Webhook` or `Grafana`). Response has `webhook_url` of the form `http://localhost:8000/api/v1/feature-health/<id>/<secret>`. List: `GET` same path. Events: `GET /api/v1/projects/{project_pk}/feature-health/events/` (returns the latest event per feature). |
| Feature Health webhook payload | **RESOLVED** | Grafana webhook contact point JSON. Required per alert: `status` (`firing` or `resolved`), `labels.flagsmith_feature`, `fingerprint`, `startsAt`, `endsAt`, `generatorURL`, `annotations` (object). `labels.flagsmith_environment` is matched by environment **name** (`Development`), not by key. `firing` makes the flag UNHEALTHY, `resolved` makes it HEALTHY (verified with a hand-built payload; Flagsmith returns 400 if `generatorURL` or `endsAt` are missing). Real Grafana-originated delivery is NOT yet tested (see open items). |
| Grafana contact point create | **RESOLVED** (Grafana side) | `POST /api/v1/provisioning/contact-points` with `{"name":"flagsmith-feature-health","type":"webhook","settings":{"url":"http://flagsmith:8000/api/v1/feature-health/<id>/<secret>","httpMethod":"POST"}}` returned 202. Inside the compose network use host `flagsmith:8000`, not the `localhost:8000` that `webhook_url` contains. |
| Grafana test-notification endpoint | **UNRESOLVED** | The old `/api/alertmanager/grafana/config/api/v1/receivers/test` returns 410 in Grafana 13; the replacement `/apis/notifications.alerting.grafana.app/v1beta1/namespaces/default/receivers/{uid}/test` answered 400 "unknown integration type" with my body. Verify real delivery in Phase 3 by firing an actual alert rule. |
| Swagger / OpenAPI | RESOLVED | `GET /api/v1/swagger.json` with `Accept: application/json` (299 paths, OpenAPI 3.1). `/api/v1/docs/` returns 406/HTML. The swagger result schemas for experiment results are wrong or empty, use the fixtures instead. |

## Corrections and surprises (read before writing the plugin)

1. **Version endpoint is `/version/`, not `/api/v1/version/`.** `GET /api/v1/version/` returns the frontend HTML. The plugin's "Save & test" route must call `/version/` (root, no auth needed). Without an `Accept: application/json` header the frontend HTML is returned for unknown routes, so always send it (Grafana's data proxy does for JSON requests, set it explicitly anyway).
2. **Multivariate option `key` cannot be set at feature creation** (the nested `multivariate_options[].key` is silently ignored, key stays null) and **`PATCH .../mv-options/{id}/` returns 500** (server bug: missing `default_percentage_allocation` in partial update). Use `PUT` with the full body: `{"type":"unicode","string_value":"variant_a","default_percentage_allocation":0,"key":"variant_a","feature":<id>}`.
3. Control is not an MV option. It is the feature's `initial_value` (`control`) and appears as a variant named `control` in exposures and results.
4. Experiment create body: `metrics[].metric` is the metric id as a **string**, `experiment_rollout.feature_state_value` = `{"type":"string","value":"control"}`, the two variant allocations were 33.3 each (control gets the rest), `audience` = `{"match":"any","segment_ids":[]}`. The POST response is slim (no metrics or rollout); the detail GET has them. Start returns the full object and sets `started_at`.
5. **`results/refresh` and `exposures/refresh` return 202 with a `null` body**, data appears within a second or two via GET (`{"results": {...}}` / `{"exposures": {...}}`, both `null` before the first refresh). A second `results/refresh` inside 5 minutes returns **429** with `{"detail":"A refresh was requested recently. Try again later. Expected available in 289 seconds."}` (fixture `experiments-results-refresh-throttled.json`). So the plugin can read the remaining seconds from the 429 body.
6. Results payload shape: `results.payload.metrics[].variants.{control,variant_a,variant_b}.{n,sum,sum_squares}`, `metrics[].inference.<variant>.{lift,ci_low,ci_high,chance_to_win}` (control has no inference entry), `metrics[].conversions_timeseries` and `payload.exposures_timeseries` (`granularity: "hour"`, `points[].bucket`, `converted_identities` / `new_identities` per variant), `payload.srm_p_value` (**null**, even with 1,530 exposures), `is_final`, `as_of`.
7. Event value for exposures is the variant's `string_value` (here equal to its key). Events are in `experimentation_sdkexperimentationevent`, see `events-sql.md`.
8. **Flagsmith's SSRF guard rejects private-network URLs** for the Grafana integration (`URLs must not target internal or private network addresses`) and a hostname without a dot (`grafana`) fails Django's URL validation. Fix used: env `SSRF_ALLOWED_HOSTS=grafana.flagscope.local` on the Flagsmith containers plus a compose network alias with that dotted name on the Grafana service.
9. `GET /api/v1/audit/?project=1` returned **500** with the master key (not investigated, not needed).
10. A running experiment does not block `PATCH /environments/{key}/featurestates/{id}/` with the master API key (toggled twice and restored, the experiment stayed `running`).
11. Startup: `/health/liveness/` answered 200 within roughly 10 s of `docker compose up -d` returning (images already pulled, empty database, migrations included).

## Scaffold and plugin facts

- `@grafana/create-plugin@9.0.4` prints "does not support Windows. Please use WSL" and exits. Workaround used (no WSL setup needed): `docker run --rm -v "<dir>:/work" -w /work node:22-alpine sh -c 'corepack enable && corepack prepare pnpm@10 --activate; pnpm dlx @grafana/create-plugin@latest --plugin-type datasource --no-backend --plugin-name flagscope --org-name abhi0404 --no-agent'`, then move the generated folder to `plugin/`. The generated plugin id is `abhi0404-flagscope-datasource`. **The org slug `abhi0404` is a placeholder**; change `src/plugin.json` id, the compose mount path and `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` together if the real grafana.com org differs.
- Despite `--no-agent` the scaffold wrote AI-agent files (`.claude/`, `.codex/`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) and Playwright e2e files. All removed (plus `@grafana/plugin-e2e`, `@playwright/test` and the `e2e` script). The scaffold's `.github/workflows/*` are still in `plugin/.github/` and must move to the repo root in Phase 3.
- `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint` all pass under pnpm's default isolated layout. **`node-linker=hoisted` is NOT needed** (tried, did not change anything, reverted). Added only `rxjs@7.8.2`.
- **Jest quirk:** any test that imports `@grafana/runtime` or `@grafana/ui` passes but jest then never exits (open handle), so `pnpm test:ci` hangs forever. Fixed with `forceExit: true` in `plugin/jest.config.js` (the root file the scaffold says may be extended). `pnpm test:ci` now ends in about 8 s. Do not run `pnpm test` (it is `--watch`).
- `package.json` `engines.node >=24.5` triggers a harmless warning on Node 22.
- Grafana loads the plugin: `GET /api/plugins?type=datasource` lists `abhi0404-flagscope-datasource` v1.0.0, `signature: unsigned`, `enabled: true`; the Grafana log shows "Permitting unsigned plugin" and "Plugin registered".
- Removed scaffold folder plugin/.config/AGENTS (AI agent instructions, contained long dashes).
