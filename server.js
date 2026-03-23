const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ACCESS_TOKEN  = process.env.ACCESS_TOKEN || 'cardscan-token';
const PORT          = process.env.PORT || 3000;
const RATE_LIMIT    = parseInt(process.env.RATE_LIMIT_PER_HOUR || '100');

if (!ANTHROPIC_KEY) {
  console.error('ANTHROPIC_API_KEY ist nicht gesetzt!');
  process.exit(1);
}

// Rate limiting (per token, per hour)
const rateCounts = new Map();
function checkRate(token) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const calls = (rateCounts.get(token) || []).filter(t => now - t < hour);
  if (calls.length >= RATE_LIMIT) return false;
  calls.push(now);
  rateCounts.set(token, calls);
  return true;
}

// Usage log (in-memory, last 500 calls)
const usageLog = [];
function logUsage(token, model, usage) {
  usageLog.unshift({ ts: Date.now(), token: token.slice(-4), model, ...usage });
  if (usageLog.length > 500) usageLog.pop();
}

// Auth middleware
function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (token !== ACCESS_TOKEN) {
    return res.status(401).json({ error: { message: 'Ungültiger Zugangs-Token' } });
  }
  if (!checkRate(token)) {
    return res.status(429).json({ error: { message: `Rate-Limit erreicht (${RATE_LIMIT}/Stunde)` } });
  }
  req.clientToken = token;
  next();
}

// Health check (no auth)
app.get('/health', (_, res) => res.json({ ok: true, version: '2.0.0', name: 'CardScan Proxy' }));

// Main API proxy — forwards to Anthropic, supports tools (web search)
app.post('/api/analyze', auth, async (req, res) => {
  try {
    const { model, messages, max_tokens, tools } = req.body;
    const body = {
      model:      model || 'claude-sonnet-4-20250514',
      max_tokens: max_tokens || 1200,
      messages,
    };
    if (tools) body.tools = tools;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await upstream.json();
    if (data.usage) {
      logUsage(req.clientToken, body.model, data.usage);
      console.log(`[${new Date().toISOString()}] ${body.model} in:${data.usage.input_tokens} out:${data.usage.output_tokens}`);
    }
    res.status(upstream.status).json(data);

  } catch (err) {
    console.error('Proxy Fehler:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Usage stats
app.get('/admin/usage', auth, (req, res) => {
  const totalIn  = usageLog.reduce((s,u) => s + (u.input_tokens||0), 0);
  const totalOut = usageLog.reduce((s,u) => s + (u.output_tokens||0), 0);
  res.json({ calls: usageLog.length, totalIn, totalOut, log: usageLog.slice(0,50) });
});

app.listen(PORT, () => {
  console.log(`\nCardScan Proxy v2 auf Port ${PORT}`);
  console.log(`Token: ${ACCESS_TOKEN}`);
  console.log(`Rate-Limit: ${RATE_LIMIT}/h\n`);
});
