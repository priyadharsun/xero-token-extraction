// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const { getXeroAccessToken } = require('./xeroToken');

const app = express();
app.use(cors());            // adjust origin if you want to restrict
app.use(express.json());
app.use(morgan('tiny'));    // avoid logging tokens yourself

// --- simple in-memory cache & concurrency guard ---
let cached = null;          // {access_token, token_type, expires_in, raw}
let expiresAt = 0;          // ms epoch
let inFlight = null;        // Promise currently fetching token

function isValid() {
  return cached && Date.now() < expiresAt;
}

// Optional API key protection (recommended if you expose beyond localhost)
function requireApiKey(req, res, next) {
  const needKey = !!process.env.API_KEY;
  if (!needKey) return next();
  const got = req.header('x-api-key');
  if (got && got === process.env.API_KEY) return next();
  return res.status(401).json({ status: 'error', message: 'Unauthorized' });
}

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Main endpoint: GET /token?force=true to skip cache
app.get('/token', requireApiKey, async (req, res) => {
  try {
    const force = String(req.query.force || '').toLowerCase() === 'true';

    if (!force && isValid()) {
      const ttl = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      return res.json({ access_token: cached.access_token, token_type: cached.token_type, expires_in: ttl });
    }

    // Collapse concurrent callers into one Playwright run
    if (!inFlight) {
      inFlight = (async () => {
        const token = await getXeroAccessToken({
          email: process.env.XERO_EMAIL,
          password: process.env.XERO_PASSWORD,
          totpSecret: process.env.XERO_TOTP_SECRET,
          userDataDir: process.env.USER_DATA_DIR || './xero-profile',
          headful: true,
          timeoutMs: 60000
        });

        // Cache: Xero often returns ~720s; keep a safety buffer
        const bufferSec = Number(process.env.EXPIRY_BUFFER_SEC || 30);
        cached = token;
        expiresAt = Date.now() + Math.max(0, (token.expires_in - bufferSec)) * 1000;

        return token;
      })().finally(() => { inFlight = null; });
    }

    const token = await inFlight;
    const ttl = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    res.json({ access_token: token.access_token, token_type: token.token_type || 'Bearer', expires_in: ttl });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err?.message || String(err) });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Xero token server listening on http://localhost:${port}`);
});
