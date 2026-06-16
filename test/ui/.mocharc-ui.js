// Mocha config for the ExTester UI run. UI steps drive a real VS Code window
// over WebDriver, so timeouts are generous.
module.exports = {
  reporter: 'spec',
  timeout: 180000,
  slow: 30000,
  bail: false,
};
