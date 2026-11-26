// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const base = require('./.config/jest.config');

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...base,
  testMatch: [...base.testMatch, '<rootDir>/tests/**/*.test.{ts,tsx}'],
  // Phase 0: importing @grafana/runtime or @grafana/ui leaves an open handle, so jest never exits on its own.
  forceExit: true,
};
