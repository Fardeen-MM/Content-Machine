const { generateImage } = require('../lib/ideogram');

async function generateContentImage(content) {
  if (!content.image_prompt) {
    console.log('[image] No image prompt, skipping');
    return content;
  }

  console.log(`[image] Generating image for content ${content.id}`);

  try {
    const imageUrl = await generateImage(content.image_prompt);
    if (imageUrl) {
      content.image_url = imageUrl;
      console.log(`[image] Generated: ${imageUrl}`);
    }
  } catch (err) {
    console.error(`[image] Failed: ${err.message}`);
  }

  return content;
}

module.exports = { generateContentImage };
