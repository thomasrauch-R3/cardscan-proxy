/**
 * CardScan Proxy Server v2.1
 * 
 * Express-Server der als Proxy zwischen der CardScan Electron-App und der
 * Anthropic API fungiert. Der API-Key bleibt auf dem Server — Endnutzer
 * brauchen nur einen Zugangs-Token.
 * 
 * Sicherheitsmaßnahmen:
 * - CORS auf Electron-Origins beschränkt
 * - Token-basierte Authentifizierung
 * - Rate-Limiting pro Token und Stunde
 * - Modell-Whitelist verhindert Nutzung teurer Modelle
 * - Max-Token-Limit verhindert übermäßige Kosten
 * - Request-Body-Größe begrenzt (25 MB für Visitenkarten-Bilder)
 * 
 * Deployment: Render.com (Free Tier, schläft bei Inaktivität ein)
 * GitHub: github.com/thomasrauch-R3/cardscan-proxy
 * 
 * @author Thomas Rauch · RAUCH3 GmbH
 * @version 2.1.0
 */

const express = require('express');
const cors    = require('cors');

const app = express();

// ── Konfiguration aus Umgebungsvariablen ─────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ACCESS_TOKEN  = process.env.ACCESS_TOKEN || 'cardscan-token';
const PORT          = process.env.PORT || 3000;
const RATE_LIMIT    = parseInt(process.env.RATE_LIMIT_PER_HOUR || '500');

if (!ANTHROPIC_KEY) {
  console.error('FEHLER: ANTHROPIC_API_KEY ist nicht gesetzt!');
  process.exit(1);
}

// ── Sicherheit: Erlaubte Modelle und Limits ──────────────────────────────────
/** Nur diese Modelle dürfen über den Proxy angesprochen werden */
const ALLOWED_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5',
];

/** Maximale Output-Tokens pro Request (verhindert Kosten-Explosion) */
const MAX_TOKENS_LIMIT = 4096;

/** Maximale Anzahl Messages pro Request */
const MAX_MESSAGES = 20;

// ── CORS: Nur Electron-App und lokale Entwicklung ────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    // Electron sendet origin=null oder file:// oder app://
    // Render.com health checks senden keinen Origin
    if (!origin || origin === 'null' || origin.startsWith('file://') || origin.startsWith('app://')) {
      callback(null, true);
    } else {
      console.warn(`CORS blockiert: ${origin}`);
      callback(new Error('CORS nicht erlaubt'));
    }
  },
}));

app.use(express.json({ limit: '25mb' }));

// ── Rate-Limiting (pro Token, pro Stunde) ────────────────────────────────────
const rateCounts = new Map();

/**
 * Prüft ob ein Token noch Requests senden darf.
 * @param {string} token - Der Zugangs-Token
 * @returns {boolean} true wenn erlaubt, false wenn Limit erreicht
 */
function checkRate(token) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const calls = (rateCounts.get(token) || []).filter(t => now - t < hour);
  if (calls.length >= RATE_LIMIT) return false;
  calls.push(now);
  rateCounts.set(token, calls);
  return true;
}

// ── Usage-Log (In-Memory, letzte 500 Calls) ──────────────────────────────────
const usageLog = [];

/**
 * Protokolliert API-Nutzung für die Admin-Übersicht.
 * @param {string} token - Zugangs-Token (nur letzte 4 Zeichen gespeichert)
 * @param {string} model - Verwendetes Modell
 * @param {object} usage - Token-Verbrauch von der Anthropic API
 */
function logUsage(token, model, usage) {
  usageLog.unshift({ ts: Date.now(), token: token.slice(-4), model, ...usage });
  if (usageLog.length > 500) usageLog.pop();
}

// ── Auth-Middleware ───────────────────────────────────────────────────────────
/**
 * Prüft den Bearer-Token im Authorization-Header.
 * Gibt 401 bei ungültigem Token, 429 bei Rate-Limit-Überschreitung.
 */
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

// ── Health-Check (ohne Auth, für Render.com Monitoring) ──────────────────────
app.get('/health', (_, res) => res.json({
  ok: true,
  version: '2.1.0',
  name: 'CardScan Proxy',
}));

// ── Update-Check: Aktuelle App-Version + Download-URL ────────────────────────
/**
 * GET /update
 * Gibt die aktuelle App-Version und Download-URL zurück.
 * Konfigurierbar über Umgebungsvariablen auf Render.com:
 *   APP_VERSION=2.2.0
 *   APP_DOWNLOAD_MAC=https://github.com/thomasrauch-R3/cardscan-app/releases/download/v2.2.0/CardScan-2.2.0.dmg
 *   APP_DOWNLOAD_WIN=https://github.com/thomasrauch-R3/cardscan-app/releases/download/v2.2.0/cardscan-app.zip
 *   APP_CHANGELOG=Dark Mode, Re-Scan, Statistik-Dashboard
 */
app.get('/update', (_, res) => res.json({
  version:   process.env.APP_VERSION || '2.1.0',
  downloadMac: process.env.APP_DOWNLOAD_MAC || '',
  downloadWin: process.env.APP_DOWNLOAD_WIN || '',
  changelog: process.env.APP_CHANGELOG || '',
}));

// ── Haupt-API-Endpunkt ──────────────────────────────────────────────────────
/**
 * POST /api/analyze
 * 
 * Nimmt einen Anthropic Messages-API-Request entgegen, validiert ihn,
 * und leitet ihn an die Anthropic API weiter. Unterstützt:
 * - Prompt Caching (system + cache_control)
 * - Web Search (tools)
 * - Alle erlaubten Modelle
 */
app.post('/api/analyze', auth, async (req, res) => {
  try {
    const { model, messages, max_tokens, tools, system, cache_control } = req.body;

    // ── Eingabevalidierung ──
    const requestedModel = model || 'claude-sonnet-4-20250514';
    if (!ALLOWED_MODELS.includes(requestedModel)) {
      return res.status(400).json({
        error: { message: `Modell nicht erlaubt: ${requestedModel}. Erlaubt: ${ALLOWED_MODELS.join(', ')}` }
      });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'Keine Nachrichten im Request' } });
    }

    if (messages.length > MAX_MESSAGES) {
      return res.status(400).json({
        error: { message: `Zu viele Nachrichten (${messages.length}). Maximum: ${MAX_MESSAGES}` }
      });
    }

    // Token-Limit deckeln
    const cappedTokens = Math.min(max_tokens || 1200, MAX_TOKENS_LIMIT);

    // ── Request an Anthropic aufbauen ──
    const body = {
      model:      requestedModel,
      max_tokens: cappedTokens,
      messages,
    };
    if (tools) body.tools = tools;
    if (system) body.system = system;
    if (cache_control) body.cache_control = cache_control;

    const headers = {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    };
    // Web Search erfordert Beta-Header
    if (tools) headers['anthropic-beta'] = 'web-search-2025-03-05';

    // ── Request absenden ──
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers,
      body: JSON.stringify(body),
    });

    const data = await upstream.json();

    // ── Nutzung protokollieren ──
    if (data.usage) {
      logUsage(req.clientToken, requestedModel, data.usage);
      const u = data.usage;
      const cacheInfo = u.cache_read_input_tokens || u.cache_creation_input_tokens
        ? ` cache_read:${u.cache_read_input_tokens||0} cache_write:${u.cache_creation_input_tokens||0}`
        : '';
      console.log(`[${new Date().toISOString()}] ${requestedModel} in:${u.input_tokens} out:${u.output_tokens}${cacheInfo}`);
    }

    res.status(upstream.status).json(data);

  } catch (err) {
    console.error('Proxy Fehler:', err.message);
    // Keine internen Fehlerdetails nach außen geben
    res.status(500).json({ error: { message: 'Interner Proxy-Fehler' } });
  }
});

// ── Admin-Endpunkt: Nutzungsstatistiken ──────────────────────────────────────
/**
 * GET /admin/usage
 * Gibt die letzten 50 API-Calls mit Token-Verbrauch zurück.
 * Authentifizierung erforderlich.
 */
app.get('/admin/usage', auth, (req, res) => {
  const totalIn  = usageLog.reduce((s, u) => s + (u.input_tokens || 0), 0);
  const totalOut = usageLog.reduce((s, u) => s + (u.output_tokens || 0), 0);
  res.json({ calls: usageLog.length, totalIn, totalOut, log: usageLog.slice(0, 50) });
});

// ── Server starten ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nCardScan Proxy v2.1 auf Port ${PORT}`);
  console.log(`Token: ${ACCESS_TOKEN.slice(0, 4)}****`);
  console.log(`Rate-Limit: ${RATE_LIMIT}/h`);
  console.log(`Erlaubte Modelle: ${ALLOWED_MODELS.join(', ')}\n`);
});
