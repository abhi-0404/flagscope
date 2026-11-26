import React, { ChangeEvent } from 'react';
import { Alert, InlineField, Input, SecretInput } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { FlagscopeDataSourceOptions, FlagscopeSecureJsonData } from '../types';

interface Props extends DataSourcePluginOptionsEditorProps<FlagscopeDataSourceOptions, FlagscopeSecureJsonData> {}

export function ConfigEditor(props: Props) {
  const { onOptionsChange, options } = props;
  const { jsonData, secureJsonFields, secureJsonData } = options;

  const onUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: { ...jsonData, flagsmithUrl: event.target.value.trim().replace(/\/+$/, '') },
    });
  };

  // Secure field: stored encrypted by Grafana, only the data proxy sees it.
  const onApiKeyChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      secureJsonData: { apiKey: event.target.value },
    });
  };

  const onResetApiKey = () => {
    onOptionsChange({
      ...options,
      secureJsonFields: { ...options.secureJsonFields, apiKey: false },
      secureJsonData: { ...options.secureJsonData, apiKey: '' },
    });
  };

  return (
    <>
      <InlineField
        label="Flagsmith URL"
        labelWidth={20}
        interactive
        tooltip="Base URL of the Flagsmith API as the Grafana server reaches it, without a trailing slash."
      >
        <Input
          id="config-editor-flagsmith-url"
          onChange={onUrlChange}
          value={jsonData.flagsmithUrl ?? ''}
          placeholder="http://flagsmith:8000"
          width={40}
        />
      </InlineField>
      <InlineField
        label="Organisation API key"
        labelWidth={20}
        interactive
        tooltip="Leave empty when the Flagsmith URL is a FlagScope gatekeeper (it holds the key, recommended). Otherwise a Flagsmith organisation (master) API key, sent as 'Authorization: Api-Key ...' by the Grafana server, never by the browser."
      >
        <SecretInput
          id="config-editor-api-key"
          isConfigured={Boolean(secureJsonFields?.apiKey)}
          value={secureJsonData?.apiKey ?? ''}
          placeholder="Flagsmith master API key"
          width={40}
          onReset={onResetApiKey}
          onChange={onApiKeyChange}
        />
      </InlineField>
      <Alert severity="info" title="Read only" topSpacing={1}>
        FlagScope only reads experiments and results. The single write it can do is the experiment results refresh, at
        most once per 5 minutes per experiment. Point the URL at the FlagScope gatekeeper (stack/gatekeeper) and leave
        the key empty: Grafana then holds no Flagsmith credential, and viewers can only reach the exact paths the
        plugin uses. With a master key stored here, every Grafana viewer can read anything under /projects/ and
        /environments/.
      </Alert>
    </>
  );
}
