import { plugin } from './module';

describe('module', () => {
  it('exports a DataSourcePlugin with a config editor and a query editor', () => {
    expect(plugin).toBeDefined();
    expect(plugin.components.ConfigEditor).toBeDefined();
    expect(plugin.components.QueryEditor).toBeDefined();
  });
});
