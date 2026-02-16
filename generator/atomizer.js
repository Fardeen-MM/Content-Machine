const { callClaude, parseJsonResponse, HAIKU } = require('../lib/claude');

const SYSTEM = `You are a content strategist for a legal marketing agency called Mortar Metrics.
Your job is to break down long-form content into reusable "atoms" — small pieces that can be
recombined into social posts, emails, ads, and other formats.

Focus on the legal marketing industry. Extract ONLY what actually exists in the text.
Do NOT invent stats, quotes, or claims. If a category has nothing, return an empty array.

Return raw JSON with no markdown fences. Use this exact structure:
{
  "hooks": [],
  "stats": [{ "number": "", "context": "" }],
  "frameworks": [{ "name": "", "steps": [] }],
  "quotes": [],
  "stories": [{ "setup": "", "payoff": "" }],
  "contrarian_takes": [],
  "data_points": [{ "claim": "", "source": "" }],
  "pain_points": [],
  "ctas": []
}`;

const EMPTY_ATOMS = {
  hooks: [],
  stats: [],
  frameworks: [],
  quotes: [],
  stories: [],
  contrarian_takes: [],
  data_points: [],
  pain_points: [],
  ctas: []
};

/**
 * Break long-form content into reusable content atoms using Haiku.
 * @param {string} text — raw text (blog, article, transcript, etc.)
 * @param {string} source — label for where the text came from
 * @returns {Promise<object>} structured atoms object
 */
async function atomizeContent(text, source = 'unknown') {
  if (!text || text.trim().length < 100) {
    return { ...EMPTY_ATOMS, _source: source, _error: 'Text too short to atomize' };
  }

  // Truncate to ~12K chars to stay within Haiku context comfortably
  const trimmed = text.slice(0, 12000);

  const prompt = `Source: ${source}

--- BEGIN CONTENT ---
${trimmed}
--- END CONTENT ---

Extract every reusable content atom from the text above. Return raw JSON only.
For hooks: attention-grabbing opening lines or surprising statements.
For stats: exact numbers with context from the text.
For frameworks: named step-by-step processes or systems.
For quotes: memorable direct quotes or quotable lines.
For stories: mini-narratives with a setup and payoff.
For contrarian_takes: opinions that go against conventional wisdom.
For data_points: specific claims backed by data, with their source.
For pain_points: problems or frustrations the audience faces.
For ctas: calls to action or next steps mentioned.`;

  try {
    const raw = await callClaude({ model: HAIKU, system: SYSTEM, prompt, maxTokens: 2000 });
    const atoms = parseJsonResponse(raw);

    if (!atoms || typeof atoms !== 'object') {
      return { ...EMPTY_ATOMS, _source: source, _error: 'Failed to parse atom response' };
    }

    // Ensure every key exists even if Haiku omitted it
    for (const key of Object.keys(EMPTY_ATOMS)) {
      if (!Array.isArray(atoms[key])) atoms[key] = [];
    }

    atoms._source = source;
    return atoms;
  } catch (err) {
    console.error(`[atomizer] Error atomizing content from ${source}:`, err.message);
    return { ...EMPTY_ATOMS, _source: source, _error: err.message };
  }
}

/**
 * Fetch a URL, strip HTML, and atomize the text content.
 * @param {string} url — page URL to fetch and atomize
 * @returns {Promise<object>} structured atoms object
 */
async function atomizeUrl(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MortarMetrics-ContentMachine/1.0' }
    });

    if (!res.ok) {
      return { ...EMPTY_ATOMS, _source: url, _error: `Fetch failed: ${res.status}` };
    }

    let html = await res.text();

    // Strip scripts, styles, then all tags
    html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    html = html.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    html = html.replace(/<[^>]+>/g, ' ');

    // Collapse whitespace
    const text = html.replace(/\s+/g, ' ').trim();

    return atomizeContent(text, url);
  } catch (err) {
    console.error(`[atomizer] Error fetching ${url}:`, err.message);
    return { ...EMPTY_ATOMS, _source: url, _error: err.message };
  }
}

module.exports = { atomizeContent, atomizeUrl };
