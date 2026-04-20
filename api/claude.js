const https = require('https');

function callGemini(body, apiKey) {
  return new Promise((resolve, reject) => {
    const path = `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Anthropic content → Gemini parts
function toParts(content) {
  if (typeof content === 'string') {
    return [{ text: content }];
  }
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type === 'text') return { text: part.text };
      if (part.type === 'image') {
        return {
          inlineData: {                      // ← camelCase (Gemini REST 格式)
            mimeType: part.source.media_type, // ← camelCase
            data: part.source.data
          }
        };
      }
      return null;
    }).filter(Boolean);
  }
  return [];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not configured' }); return; }

  try {
    const { messages, max_tokens } = req.body;

    const contents = (messages || []).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: toParts(msg.content)
    }));

    const geminiBody = JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: max_tokens || 1000 }
    });

    // Log request type for debugging
    const hasImage = contents.some(c => c.parts.some(p => p.inlineData));
    console.log('Request type:', hasImage ? 'image' : 'text', '| Body size:', geminiBody.length, 'bytes');

    // 429 時等 2 秒重試一次
    let response = await callGemini(geminiBody, apiKey);
    if (response.status === 429) {
      await sleep(2000);
      response = await callGemini(geminiBody, apiKey);
    }

    const geminiData = JSON.parse(response.data);

    if (response.status !== 200) {
      console.error('Gemini error', response.status, response.data);
      res.status(response.status).json({
        error: geminiData.error?.message || `Gemini error ${response.status}`
      });
      return;
    }

    const text = (geminiData.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '').join('');

    res.status(200).json({ content: [{ type: 'text', text }] });

  } catch (err) {
    console.error('Proxy error', err);
    res.status(500).json({ error: err.message });
  }
};
