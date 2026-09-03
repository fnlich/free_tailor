const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tailor-${name}-`));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

module.exports = {
  loadFresh,
  makeTempDataDir,
  readJson,
};
