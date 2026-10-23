'use strict';
const path = require('node:path');
// Use the lockfile's browser runtime, never a developer's agent cache or Edge.
const playwright = require('playwright');
function outputDirectory(name) {
  const root = process.env.AGENTOFFICE_VALIDATION_OUTPUT || path.resolve(__dirname, '../output/playwright');
  return path.join(root, name);
}
module.exports = { playwright, outputDirectory };
