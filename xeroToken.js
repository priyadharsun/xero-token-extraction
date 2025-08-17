// xeroToken.js
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DEBUG = String(process.env.DEBUG || 'false').toLowerCase() === 'true';
const DEBUG_SHOTS = String(process.env.DEBUG_SHOTS || 'false').toLowerCase() === 'true';
const SHOT_DIR = path.resolve(process.cwd(), 'debug-shots');

function now() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
function log(...args) {
  if (DEBUG) console.log(`[${now()}]`, ...args);
}
function maskEmail(e) {
  if (!e) return e;
  const [u, d] = e.split('@');
  if (!d) return '***';
  return (u.slice(0,2) + '***@' + d);
}
function maskToken(t) {
  if (!t) return t;
  return `${t.slice(0,12)}…(${t.length})`;
}
async function snap(page, name) {
  if (!DEBUG_SHOTS) return;
  try {
    if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log('SNAPSHOT =>', file);
  } catch (e) {
    log('SNAPSHOT error:', e.message);
  }
}

function isGoXero(url) {
  try { return /^https:\/\/go\.xero\.com\//i.test(url); } catch { return false; }
}
function is404(url) {
  try { return /https:\/\/go\.xero\.com\/(?:General\/404|app\/errors\/404)/i.test(url); } catch { return false; }
}

/* ---------- multi-scope helpers (page + iframes) ---------- */
function allScopes(page) { return [page, ...page.frames()]; }

async function findFirstVisible(scopes, selector) {
  for (const s of scopes) {
    const loc = s.locator(selector).first();
    try {
      if (await loc.count() && await loc.isVisible()) return { scope: s, loc, selector };
    } catch {}
  }
  return null;
}

async function waitVisibleInAnyScope(page, selectors, timeoutMs = 15000, label = '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scopes = allScopes(page);
    for (const sel of selectors) {
      const hit = await findFirstVisible(scopes, sel);
      if (hit) {
        log(`FOUND ${label || 'element'}:`, sel, 'in scope URL:', hit.scope.url());
        return hit;
      }
    }
    await sleep(200);
  }
  log(`TIMEOUT waiting for ${label || 'element'} in any scope`, selectors);
  return null;
}

async function clickFirstIfPresent(page, selectors, timeoutMs = 4000, label = '') {
  const hit = await waitVisibleInAnyScope(page, selectors, timeoutMs, label || 'clickable');
  if (hit) {
    try { await hit.loc.click(); log('CLICKED', label || hit.selector); } catch (e) { log('CLICK FAIL', e.message); }
    return true;
  }
  return false;
}

async function dumpScopesSummary(page, tag) {
  const frs = page.frames();
  log(`[${tag}] Frames count:`, frs.length, 'Top URL:', page.url());
  const checks = [
    'input[type="email"]','input[name="email"]','#xl-form-email','input[autocomplete="username"]','[data-automationid="email"]',
    'input[type="password"]','#xl-form-password','[data-automationid="password"]',
    'button:has-text("Continue")','button:has-text("Next")',
    'button:has-text("Log in")','button:has-text("Sign in")','button[type="submit"]',
    'input[autocomplete="one-time-code"]','input[name="code"]','input[id*="code"]','input[type="tel"]'
  ];
  for (const f of [page, ...frs]) {
    const url = f.url();
    const present = [];
    for (const sel of checks) {
      try {
        const lc = await f.locator(sel).count();
        if (lc) present.push(`${sel}(${lc})`);
      } catch {}
    }
    log(`  [scope] ${url} =>`, present.join(' | ') || '(no interesting selectors)');
  }
}

/* ---------- org chooser ---------- */
async function chooseFirstOrganisationIfShown(page) {
  const candidates = [
    '[data-automationid="organisation-card"]',
    '[data-automationid="org-card"]',
    'button:has-text("Open organisation")',
    'a:has-text("Open organisation")',
    'a[href*="/app/"]'
  ].join(', ');
  const card = page.locator(candidates).first();
  const cnt = await card.count().catch(() => 0);
  log('ORG chooser candidates count:', cnt);
  if (cnt) {
    try { await card.click({ timeout: 5000 }); log('ORG chosen (first card)'); } catch (e) { log('ORG choose click error:', e.message); }
    try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}
  }
}

/* ---------- MFA ---------- */
async function fillMfaIfPresent(scope, totpSecret) {
  const codeSel = [
    'input[autocomplete="one-time-code"]',
    'input[name="code"]',
    'input[id*="code"]',
    'input[type="tel"]',
    'input[placeholder*="123456"]'
  ].join(', ');

  const has = await scope.locator(codeSel).first().isVisible().catch(() => false);
  log('MFA visible?', has, 'in scope URL:', scope.url ? scope.url() : 'n/a');
  if (!has) return;

  const trust = scope.locator('input[type="checkbox"]').filter({
    has: scope.locator('xpath=following::*[contains(.,"Trust this device")]'),
  }).first();
  if (await trust.count().catch(() => 0)) { try { await trust.check(); log('MFA: checked "Trust this device"'); } catch {} }

  for (let i = 0; i < 2; i++) {
    const code = authenticator.generate(totpSecret);
    log('MFA: filling TOTP code (attempt', i+1, ')');
    try { await scope.locator(codeSel).first().fill(code); } catch (e) { log('MFA fill error:', e.message); }
    const confirm = scope.getByRole('button', { name: /confirm|continue|verify/i }).first();
    if (await confirm.count().catch(() => 0)) { try { await confirm.click(); log('MFA: clicked confirm/continue'); } catch {} }
    try { await scope.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
    const still = await scope.locator(codeSel).first().isVisible().catch(() => false);
    log('MFA still asking?', still);
    if (!still) break;
    await sleep(1000);
  }
}
async function solveMfaIfAny(page, totpSecret) {
  await fillMfaIfPresent(page, totpSecret);
  for (const f of page.frames()) { await fillMfaIfPresent(f, totpSecret); }
}

/* ---------- login (iframe-aware, two-step) ---------- */
async function performLogin(page, { email, password, totpSecret }) {
  log('LOGIN: start. Email:', maskEmail(email));

  // Cookie banners (best-effort)
  for (const sel of [
    'button:has-text("Accept all cookies")',
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept")',
    '[data-automationid="accept-cookies-button"]'
  ]) {
    const b = page.locator(sel).first();
    if (await b.count().catch(() => 0)) { try { await b.click(); log('LOGIN: accepted cookies'); } catch {} break; }
  }

  await dumpScopesSummary(page, 'before-email');

  // STEP 1: Email
  const emailHit = await waitVisibleInAnyScope(page, [
    'input[type="email"]',
    'input[name="email"]',
    '#xl-form-email',
    'input[autocomplete="username"]',
    '[data-automationid="email"]'
  ], 20000, 'email');
  if (emailHit) {
    try { await emailHit.loc.fill(email, { timeout: 7000 }); log('LOGIN: email filled'); } catch (e) { log('LOGIN: email fill error:', e.message); }
    // Continue/Next if present (two-step)
    const continued = await clickFirstIfPresent(page, [
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button[aria-label*="Continue"]'
    ], 8000, 'Continue/Next');
    if (continued) { try { await emailHit.scope.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch {} }
  } else {
    log('LOGIN: email field NOT found.');
  }

  await dumpScopesSummary(page, 'before-password');

  // STEP 2: Password
  const pwdHit = await waitVisibleInAnyScope(page, [
    'input[type="password"]',
    '#xl-form-password',
    '[data-automationid="password"]'
  ], 20000, 'password');
  if (pwdHit) {
    try { await pwdHit.loc.fill(password, { timeout: 7000 }); log('LOGIN: password filled'); } catch (e) { log('LOGIN: password fill error:', e.message); }
  } else {
    log('LOGIN: password field NOT found (might be waiting for continue/next).');
  }

  // Submit
  const loginHit = await waitVisibleInAnyScope(page, [
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button[type="submit"]'
  ], 10000, 'login-button');
  if (loginHit) { try { await loginHit.loc.click(); log('LOGIN: clicked submit'); } catch (e) { log('LOGIN: submit click error:', e.message); } }
  else if (pwdHit) { try { await pwdHit.loc.press('Enter'); log('LOGIN: pressed Enter on password'); } catch {} }

  // MFA (if shown anywhere)
  await solveMfaIfAny(page, totpSecret);
  await snap(page, 'after-login-or-mfa');
}

/* ---------- land on dashboard cleanly ---------- */
async function landOnDashboard(page, { email, password, totpSecret }) {
  log('LAND: goto dashboard first');
  try { await page.goto('https://go.xero.com/app', { waitUntil: 'domcontentloaded' }); } catch (e) { log('NAV error /app:', e.message); }
  log('LAND: URL after /app =>', page.url(), '404?', is404(page.url()));
  if (isGoXero(page.url()) && !is404(page.url())) return;

  log('LAND: goto login page');
  try { await page.goto('https://login.xero.com/identity/user/login', { waitUntil: 'domcontentloaded' }); } catch (e) { log('NAV error /login:', e.message); }
  log('LAND: URL at login =>', page.url());
  await snap(page, 'at-login');
  await performLogin(page, { email, password, totpSecret });

  log('LAND: single hop to /app after login');
  try { await page.goto('https://go.xero.com/app', { waitUntil: 'domcontentloaded' }); } catch (e) { log('NAV error /app after login:', e.message); }
  log('LAND: URL after hop =>', page.url(), '404?', is404(page.url()));
  await chooseFirstOrganisationIfShown(page);

  if (is404(page.url())) {
    log('LAND: 404 bounce detected; going root once');
    try { await page.goto('https://go.xero.com/', { waitUntil: 'domcontentloaded' }); } catch (e) { log('NAV error / root:', e.message); }
    log('LAND: URL after root =>', page.url(), '404?', is404(page.url()));
    await chooseFirstOrganisationIfShown(page);
  }

  try {
    await page.waitForURL(u => isGoXero(String(u)) && !is404(String(u)), { timeout: 45000 });
    log('LAND: stabilized at go.xero.com URL:', page.url());
  } catch {
    log('LAND: did not stabilize at go.xero.com in time. Current URL:', page.url());
    await snap(page, 'failed-stabilize');
  }
}

/* ---------- token matcher ---------- */
function tokenPredicate() {
  return async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return false;
      const j = await resp.json();
      return !!(j && j.access_token && /bearer/i.test(j.token_type || ''));
    } catch { return false; }
  };
}

/* ---------- public API ---------- */
async function getXeroAccessToken({
  email,
  password,
  totpSecret,
  userDataDir = './xero-profile',
  headful = false,
  timeoutMs = 60000,
  keepBrowserOpen = false,
  existingContext = null,
} = {}) {
  if (!email || !password || !totpSecret) {
    throw new Error('Missing required params: email, password, totpSecret');
  }

  const weLaunched = !existingContext;
  const context = existingContext ?? await chromium.launchPersistentContext(path.resolve(userDataDir), {
    headless: !headful,
    viewport: null,
    slowMo: headful ? 150 : 0,
  });

  // Add some event logs
  context.on('page', p => {
    p.on('framenavigated', fr => { if (fr === p.mainFrame()) log('NAV main:', fr.url()); });
    p.on('console', msg => log('PAGE console:', msg.type(), msg.text()));
  });

  const page = await context.newPage();

  // Capture listener BEFORE any navigation
  let liveToken = null;
  page.on('response', async (r) => {
    try {
      const url = r.url();
      const ct = (r.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        try {
          const j = await r.json();
          if (j && j.access_token && /bearer/i.test(j.token_type || '')) {
            liveToken = j;
            log('TOKEN: captured via response listener. access_token:', maskToken(j.access_token), 'expires_in:', j.expires_in);
          }
        } catch {}
      }
      // Lightly log some interesting endpoints
      if (/xero|identity/i.test(url) && (url.includes('/authorize') || url.includes('/callback'))) {
        log('HTTP response:', r.status(), url);
      }
    } catch {}
  });

  try {
    await landOnDashboard(page, { email, password, totpSecret });

    // Wait for token or listener capture
    const waiter = page.waitForResponse(tokenPredicate(), { timeout: timeoutMs }).then(async r => {
      const j = await r.json();
      log('TOKEN: captured via waitForResponse. access_token:', maskToken(j.access_token), 'expires_in:', j.expires_in);
      return j;
    });
    const tokenJson = await Promise.race([
      waiter,
      (async () => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (liveToken) return liveToken;
          await sleep(200);
        }
        throw new Error('Timed out waiting for token');
      })()
    ]);

    const out = {
      access_token: tokenJson.access_token,
      token_type: tokenJson.token_type || 'Bearer',
      expires_in: tokenJson.expires_in,
      scope: tokenJson.scope,
      raw: tokenJson,
    };

    if (!keepBrowserOpen && weLaunched) { await context.close().catch(() => {}); }
    return out;
  } catch (err) {
    log('ERROR in getXeroAccessToken:', err && err.message ? err.message : String(err));
    await snap(page, 'on-error');
    if (!keepBrowserOpen && weLaunched) { await context.close().catch(() => {}); }
    throw err;
  }
}

module.exports = { getXeroAccessToken };
