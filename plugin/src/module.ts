import { DataSourcePlugin } from '@grafana/data';
import { DataSource } from './datasource';
import { ConfigEditor } from './components/ConfigEditor';
import { QueryEditor } from './components/QueryEditor';
import { FlagscopeQuery, FlagscopeDataSourceOptions } from './types';

export const plugin = new DataSourcePlugin<DataSource, FlagscopeQuery, FlagscopeDataSourceOptions>(DataSource)
  .setConfigEditor(ConfigEditor)
  .setQueryEditor(QueryEditor);
