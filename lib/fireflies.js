const API_URL = 'https://api.fireflies.ai/graphql';

function getApiKey() {
  const key = process.env.FIREFLIES_API_KEY;
  if (!key) throw new Error('FIREFLIES_API_KEY not set');
  return key;
}

async function graphql(query, variables = {}, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getApiKey()}`
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000)
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '10');
        if (attempt < retries) {
          const delay = Math.min(retryAfter * 1000, 30000);
          console.log(`[fireflies] Rate limited, waiting ${delay / 1000}s (attempt ${attempt}/${retries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(`Fireflies rate limited after ${retries} attempts`);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status >= 500 && attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`[fireflies] Server error ${res.status}, retrying in ${delay / 1000}s (attempt ${attempt}/${retries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(`Fireflies API ${res.status}: ${text}`);
      }

      const data = await res.json();

      if (data.errors && data.errors.length > 0) {
        throw new Error(`Fireflies GraphQL error: ${data.errors[0].message}`);
      }

      return data.data;
    } catch (err) {
      lastError = err;
      if (err.name === 'TimeoutError' && attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`[fireflies] Timeout, retrying in ${delay / 1000}s (attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (attempt >= retries) throw err;
    }
  }
  throw lastError;
}

async function fetchTranscripts({ limit = 50, skip = 0, fromDate } = {}) {
  const query = `
    query Transcripts($limit: Int, $skip: Int, $fromDate: DateTime) {
      transcripts(limit: $limit, skip: $skip, fromDate: $fromDate) {
        id
        title
        dateString
        duration
        organizer_email
        participants
        speakers { id name }
        meeting_info { fred_joined silent_meeting summary_status }
      }
    }
  `;
  const data = await graphql(query, { limit, skip, fromDate });
  return (data.transcripts || []).filter(t => {
    if (t.meeting_info?.silent_meeting) return false;
    if (t.meeting_info?.summary_status && t.meeting_info.summary_status !== 'processed') return false;
    return true;
  });
}

async function fetchTranscript(id) {
  const query = `
    query Transcript($id: String!) {
      transcript(id: $id) {
        id
        title
        dateString
        duration
        organizer_email
        participants
        speakers { id name }
        sentences {
          speaker_name
          text
          start_time
          end_time
        }
        summary {
          overview
          action_items
          keywords
        }
        meeting_attendees {
          displayName
          email
          name
        }
      }
    }
  `;
  const data = await graphql(query, { id });
  return data.transcript;
}

async function listTranscripts({ limit = 50 } = {}) {
  const query = `
    query ListTranscripts($limit: Int) {
      transcripts(limit: $limit) {
        id
        title
        dateString
        duration
        meeting_info { silent_meeting summary_status }
      }
    }
  `;
  const data = await graphql(query, { limit });
  return (data.transcripts || []).filter(t => {
    if (t.meeting_info?.silent_meeting) return false;
    return true;
  });
}

function sentencesToTranscript(sentences) {
  if (!sentences || sentences.length === 0) return '';
  return sentences.map(s => `${s.speaker_name || 'Unknown'}: ${s.text}`).join('\n');
}

module.exports = {
  fetchTranscripts,
  fetchTranscript,
  listTranscripts,
  sentencesToTranscript
};
