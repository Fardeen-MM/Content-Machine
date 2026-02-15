const { loadEnv } = require('./utils');

loadEnv();

const API_URL = 'https://api.ideogram.ai/generate';

async function generateImage(promptText) {
  const apiKey = process.env.IDEOGRAM_API_KEY;
  if (!apiKey) {
    console.log('[ideogram] IDEOGRAM_API_KEY not set, skipping image generation');
    return null;
  }

  const fullPrompt = `Clean modern professional graphic, navy blue (#1e3a5f) and white color scheme, minimal corporate design. ${promptText}`;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        image_request: {
          prompt: fullPrompt,
          model: 'V_2A_TURBO',
          aspect_ratio: 'ASPECT_1_1',
          magic_prompt_option: 'ON'
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[ideogram] API error ${res.status}: ${errText}`);
      return null;
    }

    const data = await res.json();
    const imageUrl = data?.data?.[0]?.url;
    if (!imageUrl) {
      console.error('[ideogram] No image URL in response');
      return null;
    }

    return imageUrl;
  } catch (err) {
    console.error('[ideogram] Error:', err.message);
    return null;
  }
}

module.exports = { generateImage };
