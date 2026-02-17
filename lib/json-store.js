const { readJSON, writeJSON } = require('./utils');

// Per-file promise chains to serialize writes
const chains = new Map();

function getChain(filename) {
  if (!chains.has(filename)) chains.set(filename, Promise.resolve());
  return chains.get(filename);
}

function read(filename, defaultVal = []) {
  return readJSON(filename, defaultVal);
}

function update(filename, defaultVal, fn) {
  const prev = getChain(filename);
  const next = prev.then(() => {
    const data = readJSON(filename, defaultVal);
    const result = fn(data);
    writeJSON(filename, result);
    return result;
  });
  chains.set(filename, next.catch(() => {}));
  return next;
}

module.exports = { read, update };
