const fs = require('fs');
const path = require('path');

const KB_PATH = path.join(__dirname, '..', 'data', 'knowledge-base.md');

let _cache = null;
let _mtime = 0;

function getKnowledgeBase() {
  try {
    const stat = fs.statSync(KB_PATH);
    if (!_cache || stat.mtimeMs !== _mtime) {
      _cache = fs.readFileSync(KB_PATH, 'utf-8');
      _mtime = stat.mtimeMs;
    }
    return _cache;
  } catch (err) {
    console.error('[knowledge] Failed to load knowledge base:', err.message);
    return '';
  }
}

module.exports = { getKnowledgeBase };
