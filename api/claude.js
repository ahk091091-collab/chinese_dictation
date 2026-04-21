const https = require('https');

function callGemini(body, apiKey, model) {
  return new Promise((resolve, reject) => {
    const path = `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
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

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') return JSON.parse(body);
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'));
  return body;
}

function getGeminiModel(requestedModel) {
  if (typeof requestedModel === 'string' && /^gemini-/.test(requestedModel)) {
    return requestedModel;
  }
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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
    const body = parseBody(req.body);
    const { messages, max_tokens } = body;
    const model = getGeminiModel(body.model);

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Request must include a non-empty messages array' });
      return;
    }

    const contents = (messages || []).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: toParts(msg.content)
    })).filter(msg => msg.parts.length > 0);

    if (contents.length === 0) {
      res.status(400).json({ error: 'Request messages did not contain any supported text or image parts' });
      return;
    }

    const geminiBody = JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: max_tokens || 1000 }
    });

    // Log request type for debugging
    const hasImage = contents.some(c => c.parts.some(p => p.inlineData));
    console.log('Request type:', hasImage ? 'image' : 'text', '| Model:', model, '| Body size:', geminiBody.length, 'bytes');

    // 429 時做有限次退避重試，避免前端立刻重送把配額打滿
    let response = await callGemini(geminiBody, apiKey, model);
    for (let attempt = 0; attempt < 2 && response.status === 429; attempt++) {
      await sleep(2000 * (attempt + 1));
      response = await callGemini(geminiBody, apiKey, model);
    }

    let geminiData = {};
    try {
      geminiData = JSON.parse(response.data);
    } catch (parseErr) {
      console.error('Gemini returned non-JSON response', response.status, response.data);
      res.status(502).json({ error: 'Gemini returned an unreadable response' });
      return;
    }

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
