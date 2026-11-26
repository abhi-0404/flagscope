import React, { useEffect, useState } from 'react';
import { Combobox, ComboboxOption, InlineField, InlineSwitch, RadioButtonGroup, Stack } from '@grafana/ui';
import { QueryEditorProps, SelectableValue } from '@grafana/data';
import { getTemplateSrv } from '@grafana/runtime';
import { DataSource } from '../datasource';
import { FlagscopeDataSourceOptions, FlagscopeQuery, QueryType } from '../types';

type Props = QueryEditorProps<DataSource, FlagscopeQuery, FlagscopeDataSourceOptions>;

const QUERY_TYPES: Array<SelectableValue<QueryType>> = [
  {
    label: 'Results',
    value: 'results',
    description: 'Per variant: sample size, rate, lift, interval, chance to beat control',
  },
  { label: 'Experiments', value: 'experiments', description: 'List with status and dates' },
];

function variableOptions(): Array<ComboboxOption<string>> {
  return getTemplateSrv()
    .getVariables()
    .map((v) => ({ label: `$${v.name}`, value: `$${v.name}`, description: 'Dashboard variable' }));
}

function useOptions<T>(
  load: () => Promise<T[]> | undefined,
  map: (item: T) => ComboboxOption<string>,
  deps: unknown[]
) {
  const [options, setOptions] = useState<Array<ComboboxOption<string>>>([]);
  useEffect(() => {
    let cancelled = false;
    load()
      ?.then((items) => !cancelled && setOptions(items.map(map)))
      .catch(() => !cancelled && setOptions([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return options;
}

export function QueryEditor({ query, onChange, onRunQuery, datasource }: Props) {
  const queryType = query.queryType ?? 'results';

  const projects = useOptions(
    () => datasource.client.listProjects(),
    (p) => ({ label: p.name, value: String(p.id) }),
    [datasource]
  );
  const environments = useOptions(
    () => (query.projectId ? datasource.client.listEnvironments(query.projectId) : undefined),
    (e) => ({ label: e.name, value: e.api_key, description: e.api_key }),
    [datasource, query.projectId]
  );
  const experiments = useOptions(
    () =>
      query.environmentKey && !query.environmentKey.startsWith('$')
        ? datasource.client.listExperiments(query.environmentKey)
        : undefined,
    (e) => ({ label: `${e.name} (${e.status})`, value: String(e.id), description: e.feature?.name }),
    [datasource, query.environmentKey]
  );

  const update = (patch: Partial<FlagscopeQuery>) => {
    onChange({ ...query, ...patch });
    onRunQuery();
  };

  const withVariables = (opts: Array<ComboboxOption<string>>) => [...variableOptions(), ...opts];

  return (
    <Stack direction="column" gap={1}>
      <Stack gap={1} wrap="wrap">
        <InlineField label="Query" labelWidth={14}>
          <RadioButtonGroup options={QUERY_TYPES} value={queryType} onChange={(v) => update({ queryType: v })} />
        </InlineField>
        <InlineField label="Project" labelWidth={14}>
          <Combobox
            id="flagscope-project"
            width={28}
            options={projects}
            value={query.projectId ?? null}
            placeholder="Pick a project"
            onChange={(v) => update({ projectId: v.value, environmentKey: undefined, experimentId: undefined })}
          />
        </InlineField>
        <InlineField label="Environment" labelWidth={14}>
          <Combobox
            id="flagscope-environment"
            width={28}
            options={withVariables(environments)}
            value={query.environmentKey ?? null}
            createCustomValue
            placeholder="Environment key or $variable"
            onChange={(v) => update({ environmentKey: v.value, experimentId: undefined })}
          />
        </InlineField>
      </Stack>
      {queryType === 'results' && (
        <Stack gap={1} wrap="wrap">
          <InlineField label="Experiment" labelWidth={14}>
            <Combobox
              id="flagscope-experiment"
              width={40}
              options={withVariables(experiments)}
              value={query.experimentId ?? null}
              createCustomValue
              placeholder="Experiment or $variable"
              onChange={(v) => update({ experimentId: v.value })}
            />
          </InlineField>
          <InlineField
            label="Refresh"
            labelWidth={14}
            tooltip="Ask Flagsmith to recompute results. Sent at most once per 5 minutes per experiment."
          >
            <InlineSwitch
              value={query.refresh !== false}
              onChange={(e) => update({ refresh: e.currentTarget.checked })}
            />
          </InlineField>
        </Stack>
      )}
    </Stack>
  );
}
