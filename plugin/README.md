# FlagScope for Flagsmith (Grafana data source plugin)

Shows self-hosted Flagsmith Experimentation results in Grafana: per-variant sample size, conversion rate, lift versus
control, credible interval and chance to beat control. Frontend only (TypeScript and React, no backend), read only.

## Query types

- `experiments`: the experiments of one Flagsmith environment (status, feature, metrics, dates).
- `results`: one row per metric and variant, as computed by Flagsmith. Optional results refresh, at most once per
  5 minutes per experiment, Grafana Admin only; Viewers read the last computed results.

Template variables: `projects`, `environments(<project id>)`, `experiments(<environment key>)`.

## Configure

Set the Flagsmith URL as the Grafana server reaches it. Recommended: point it at the FlagScope gatekeeper
(`stack/gatekeeper` in the repository) and leave the API key empty, so Grafana holds no Flagsmith credential and viewers
can only reach the paths the plugin needs. Without the gatekeeper, enter an organisation master API key (stored
encrypted by Grafana, never sent to the browser); then every Grafana user who can query the data source can read
anything under `/projects/` and `/environments/` with that key.

"Save & test" calls `GET /version/`, checks `experimentation_enabled`, then lists projects.

## Develop

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test:ci && pnpm build     # `pnpm test` is watch mode
```

The plugin id (`abhi0404-flagscope-datasource`) is unsigned: set
`GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=abhi0404-flagscope-datasource` and mount or copy `dist/` into the Grafana
plugins directory. The full stack, the Experiment Room dashboard and the simulator are described in the repository
README.
