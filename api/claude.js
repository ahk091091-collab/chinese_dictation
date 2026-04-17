const https = require('https');

// 接收前端的 Anthropic 格式，內部轉換成 Gemini 格式，再轉回來
// 前端完全不需要改動

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

    const proxyReq = https.request(options, proxyRes => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => resolve({ status: proxyRes.statusCode, data }));
    });

    proxyReq.on('error', reject);
    proxyReq.write(body);
    proxyReq.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
    return;
  }

  try {
    const { messages, max_tokens } = req.body;

    // Anthropic messages → Gemini contents
    const contents = messages.map(msg => {
      const parts = [];
      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        msg.content.forEach(part => {
          if (part.type === 'text') {
            parts.push({ text: part.text });
          } else if (part.type === 'image') {
            parts.push({
              inline_data: {
                mime_type: part.source.media_type,
                data: part.source.data
              }
            });
          }
        });
      }
      return {
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts
      };
    });

    const geminiBody = JSON.stringify({
      contents,
      generationConfig: {
        maxOutputTokens: max_tokens || 1000
      }
    });

    // 自動重試：429 時等 2 秒再試一次
    let response = await callGemini(geminiBody, apiKey);
    if (response.status === 429) {
      await sleep(2000);
      response = await callGemini(geminiBody, apiKey);
    }

    const geminiData = JSON.parse(response.data);

    if (response.status !== 200) {
      res.status(response.status).json({
        error: geminiData.error?.message || `Gemini API error (${response.status})`
      });
      return;
    }

    // Gemini response → Anthropic format（前端看到的格式不變）
    const text = geminiData.candidates?.[0]?.content?.parts
      ?.map(p => p.text || '')
      .join('') || '';

    res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
