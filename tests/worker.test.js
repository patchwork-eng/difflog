/**
 * Difflog License Worker — Comprehensive Tests
 * Tests for worker/src/index.js
 * Run with: npm test
 */

// The worker uses ES module exports. Babel transforms it to CJS for Jest.
// We also need to provide globals that exist in Cloudflare Workers but not Node.
// Node 22 has fetch, Response, Request, crypto natively — we're good.

// Import the worker default export
const workerModule = require('../worker/src/index');
const worker = workerModule.default || workerModule;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a Stripe webhook signature header.
 * Note: We mock verifyStripeSignature in tests, so this just needs to look real.
 */
function makeStripeSignature(timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=fakesig_abcdef1234567890`;
}

/**
 * Create a mock KV namespace.
 */
function makeKV(store = {}) {
  const _store = { ...store };
  const _keys = Object.keys(_store);
  return {
    get: jest.fn(async (key) => _store[key] ?? null),
    put: jest.fn(async (key, value) => { _store[key] = value; }),
    delete: jest.fn(async (key) => { delete _store[key]; }),
    list: jest.fn(async ({ cursor, limit } = {}) => ({
      keys: _keys.map(k => ({ name: k })),
      list_complete: true,
      cursor: undefined,
    })),
    _store,
  };
}

/**
 * Build a fake Request object for the worker.
 */
function makeRequest(method, path, { body = null, headers = {} } = {}) {
  const url = `https://difflog-license.workers.dev${path}`;
  const init = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== null) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request(url, init);
}

/**
 * Build a mock env with KV and Stripe secret.
 */
function makeEnv({ kv = null, stripeSecret = 'whsec_test', resendKey = null } = {}) {
  return {
    LICENSES: kv || makeKV(),
    STRIPE_WEBHOOK_SECRET: stripeSecret,
    ...(resendKey ? { RESEND_API_KEY: resendKey } : {}),
  };
}

// ── Mock crypto.subtle for Stripe signature verification ──────────────────────
// We need to control when verifyStripeSignature passes/fails.
// The worker calls crypto.subtle.importKey and crypto.subtle.sign internally.
// Easiest approach: test with real signatures by computing them, or use jest.spyOn.

// For most tests, we don't want to compute real Stripe HMAC sigs.
// We'll spy on the global crypto.subtle methods for tests needing sig mocks.

// ── /health endpoint ─────────────────────────────────────────────────────────

describe('/health endpoint', () => {
  test('GET /health returns 200 with status ok', async () => {
    const req = makeRequest('GET', '/health');
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.service).toBe('difflog-license');
    expect(data.timestamp).toBeDefined();
  });

  test('POST /health returns 404', async () => {
    const req = makeRequest('POST', '/health', { body: {} });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
  });

  test('PUT /health returns 404', async () => {
    const req = makeRequest('PUT', '/health');
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
  });
});

// ── Unknown routes ────────────────────────────────────────────────────────────

describe('Unknown routes', () => {
  test('GET / returns 404', async () => {
    const req = makeRequest('GET', '/');
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Not found.');
  });

  test('POST /admin returns 404', async () => {
    const req = makeRequest('POST', '/admin', { body: {} });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
  });

  test('DELETE /validate returns 404', async () => {
    const req = makeRequest('DELETE', '/validate');
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
  });

  test('GET /validate returns 404 (only POST allowed)', async () => {
    const req = makeRequest('GET', '/validate');
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
  });

  test('GET /webhook/stripe returns 404', async () => {
    const req = makeRequest('GET', '/webhook/stripe');
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
  });
});

// ── CORS preflight ────────────────────────────────────────────────────────────

describe('CORS preflight (OPTIONS)', () => {
  test('OPTIONS request returns 204 with CORS headers', async () => {
    const req = makeRequest('OPTIONS', '/validate');
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
  });

  test('OPTIONS to any path returns 204', async () => {
    const req = makeRequest('OPTIONS', '/health');
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
  });
});

// ── /validate endpoint ────────────────────────────────────────────────────────

describe('/validate — valid and invalid license keys', () => {
  test('valid key + matching username → valid:true', async () => {
    const entry = { github_username: 'alice', plan: 'indie', stripe_customer_id: 'cus_123' };
    const kv = makeKV({ 'difflog_abc123': JSON.stringify(entry) });
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_abc123', github_username: 'alice' },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(true);
    expect(data.plan).toBe('indie');
  });

  test('valid key + wrong username → valid:false', async () => {
    const entry = { github_username: 'alice', plan: 'indie', stripe_customer_id: 'cus_123' };
    const kv = makeKV({ 'difflog_abc123': JSON.stringify(entry) });
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_abc123', github_username: 'mallory' },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.message).toContain('different GitHub account');
  });

  test('invalid key → valid:false with message', async () => {
    const kv = makeKV({});
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_nonexistent', github_username: 'alice' },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.message).toContain('Invalid license key');
  });

  test('empty body → 400 Invalid JSON', async () => {
    const req = new Request('https://difflog-license.workers.dev/validate', {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.valid).toBe(false);
  });

  test('missing license_key field → 400', async () => {
    const req = makeRequest('POST', '/validate', {
      body: { github_username: 'alice' },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toContain('license_key');
  });

  test('missing github_username field → 400', async () => {
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_abc123' },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toContain('github_username');
  });

  test('extra fields are ignored', async () => {
    const entry = { github_username: 'alice', plan: 'teams', stripe_customer_id: 'cus_456' };
    const kv = makeKV({ 'difflog_key1': JSON.stringify(entry) });
    const req = makeRequest('POST', '/validate', {
      body: {
        license_key: 'difflog_key1',
        github_username: 'alice',
        extra_field: 'ignored',
        another: 123,
      },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(true);
    expect(data.plan).toBe('teams');
  });

  test('very long license key → invalid (not in KV)', async () => {
    const longKey = 'difflog_' + 'a'.repeat(1000);
    const kv = makeKV({});
    const req = makeRequest('POST', '/validate', {
      body: { license_key: longKey, github_username: 'alice' },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(false);
  });

  test('license key with special chars → invalid (not in KV)', async () => {
    const kv = makeKV({});
    const req = makeRequest('POST', '/validate', {
      body: { license_key: "difflog_'; DROP TABLE licenses; --", github_username: 'alice' },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(false);
  });

  test('SQL injection attempt in license_key — handled safely', async () => {
    const kv = makeKV({});
    const req = makeRequest('POST', '/validate', {
      body: { license_key: "' OR '1'='1", github_username: 'alice' },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    // Should not crash, just return invalid
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(false);
  });

  test('XSS payload in github_username — handled safely', async () => {
    const kv = makeKV({});
    const req = makeRequest('POST', '/validate', {
      body: {
        license_key: 'difflog_key',
        github_username: '<script>alert("xss")</script>',
      },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    expect(res.status).toBe(200);
    // valid will be false since key doesn't exist, but response is JSON, not HTML
    const data = await res.json();
    expect(data.valid).toBe(false);
    // Verify no XSS in response body
    const text = JSON.stringify(data);
    expect(text).not.toContain('<script>');
  });

  test('malformed JSON body → 400', async () => {
    const req = new Request('https://difflog-license.workers.dev/validate', {
      method: 'POST',
      body: '{"license_key": invalid json}',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });
});

// ── /validate — KV error handling ────────────────────────────────────────────

describe('/validate — KV edge cases', () => {
  test('KV read failure → 500', async () => {
    const kv = makeKV();
    kv.get.mockRejectedValue(new Error('KV read timeout'));
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_key', github_username: 'alice' },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.message).toContain('service error');
  });

  test('KV returns malformed JSON → 500', async () => {
    const kv = makeKV();
    kv.get.mockResolvedValue('not valid json {{{');
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_key', github_username: 'alice' },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    expect(res.status).toBe(500);
  });

  test('KV write failure during usage logging is non-fatal', async () => {
    const entry = { github_username: 'alice', plan: 'indie', stripe_customer_id: 'cus_1' };
    const kv = makeKV({ 'difflog_key': JSON.stringify(entry) });
    kv.put.mockRejectedValue(new Error('KV write error'));

    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_key', github_username: 'alice' },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    // Should still return valid — write failure is non-fatal
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(true);
  });
});

// ── /validate — usage tracking edge cases ────────────────────────────────────

describe('/validate — usage tracking', () => {
  test('first usage — usage array created with 1 entry', async () => {
    const entry = { github_username: 'alice', plan: 'indie', stripe_customer_id: 'cus_1' };
    const kv = makeKV({ 'difflog_key': JSON.stringify(entry) });
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_key', github_username: 'alice' },
    });
    await worker.fetch(req, makeEnv({ kv }));

    const storedRaw = kv._store['difflog_key'];
    const stored = JSON.parse(storedRaw);
    expect(stored.usage).toHaveLength(1);
    expect(stored.usage[0].github_username).toBe('alice');
    expect(stored.usage[0].timestamp).toBeDefined();
  });

  test('99th usage — usage array has 99 entries, no trim', async () => {
    const existingUsage = Array.from({ length: 98 }, (_, i) => ({
      timestamp: Date.now() - i * 1000,
      github_username: 'alice',
      repo_type: 'private',
    }));
    const entry = {
      github_username: 'alice',
      plan: 'indie',
      stripe_customer_id: 'cus_1',
      usage: existingUsage,
    };
    const kv = makeKV({ 'difflog_key': JSON.stringify(entry) });
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_key', github_username: 'alice' },
    });
    await worker.fetch(req, makeEnv({ kv }));

    const stored = JSON.parse(kv._store['difflog_key']);
    expect(stored.usage).toHaveLength(99); // 98 + 1, no trim
  });

  test('100th usage — usage array has exactly 100 entries, no trim', async () => {
    const existingUsage = Array.from({ length: 99 }, (_, i) => ({
      timestamp: Date.now() - i * 1000,
      github_username: 'alice',
      repo_type: 'private',
    }));
    const entry = {
      github_username: 'alice',
      plan: 'indie',
      stripe_customer_id: 'cus_1',
      usage: existingUsage,
    };
    const kv = makeKV({ 'difflog_key': JSON.stringify(entry) });
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_key', github_username: 'alice' },
    });
    await worker.fetch(req, makeEnv({ kv }));

    const stored = JSON.parse(kv._store['difflog_key']);
    expect(stored.usage).toHaveLength(100); // exactly 100, no trim
  });

  test('101st usage — usage trimmed to last 100', async () => {
    const existingUsage = Array.from({ length: 100 }, (_, i) => ({
      timestamp: i, // timestamps 0..99
      github_username: 'alice',
      repo_type: 'private',
    }));
    const entry = {
      github_username: 'alice',
      plan: 'indie',
      stripe_customer_id: 'cus_1',
      usage: existingUsage,
    };
    const kv = makeKV({ 'difflog_key': JSON.stringify(entry) });
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_key', github_username: 'alice' },
    });
    await worker.fetch(req, makeEnv({ kv }));

    const stored = JSON.parse(kv._store['difflog_key']);
    // 100 existing + 1 new = 101, trimmed to 100
    expect(stored.usage).toHaveLength(100);
    // The oldest (timestamp=0) should be removed
    expect(stored.usage[0].timestamp).not.toBe(0);
  });

  test('usage array already > 100 — trimmed to 100 after push', async () => {
    const existingUsage = Array.from({ length: 200 }, (_, i) => ({
      timestamp: i,
      github_username: 'alice',
      repo_type: 'private',
    }));
    const entry = {
      github_username: 'alice',
      plan: 'indie',
      stripe_customer_id: 'cus_1',
      usage: existingUsage,
    };
    const kv = makeKV({ 'difflog_key': JSON.stringify(entry) });
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_key', github_username: 'alice' },
    });
    await worker.fetch(req, makeEnv({ kv }));

    const stored = JSON.parse(kv._store['difflog_key']);
    expect(stored.usage).toHaveLength(100);
  });

  test('entry.usage is not an array — treated as empty, creates fresh array', async () => {
    const entry = {
      github_username: 'alice',
      plan: 'indie',
      stripe_customer_id: 'cus_1',
      usage: 'corrupted',
    };
    const kv = makeKV({ 'difflog_key': JSON.stringify(entry) });
    const req = makeRequest('POST', '/validate', {
      body: { license_key: 'difflog_key', github_username: 'alice' },
    });
    const res = await worker.fetch(req, makeEnv({ kv }));
    expect(res.status).toBe(200);
    const stored = JSON.parse(kv._store['difflog_key']);
    expect(Array.isArray(stored.usage)).toBe(true);
    expect(stored.usage).toHaveLength(1);
  });
});

// ── /webhook/stripe — signature verification ──────────────────────────────────

describe('/webhook/stripe — signature verification', () => {
  // We'll compute a real HMAC sig for the "valid" tests
  async function computeStripeSig(body, secret, timestamp) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const msgData = encoder.encode(`${timestamp}.${body}`);
    const key = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, msgData);
    const hex = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `t=${timestamp},v1=${hex}`;
  }

  test('missing stripe-signature header → 401', async () => {
    const body = JSON.stringify({ type: 'checkout.session.completed' });
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });

  test('invalid stripe-signature → 401', async () => {
    const body = JSON.stringify({ type: 'checkout.session.completed' });
    const req = makeRequest('POST', '/webhook/stripe', { body });
    req.headers.set = undefined; // Can't modify after creation — use constructor
    const req2 = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 't=123,v1=badsignature',
      },
      body,
    });
    const res = await worker.fetch(req2, makeEnv());
    expect(res.status).toBe(401);
  });

  test('expired timestamp (>5 min) → 401', async () => {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 6.6 min old
    const sig = await computeStripeSig(body, 'whsec_test', oldTimestamp);
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(401);
  });

  test('malformed JSON body with valid sig → 400', async () => {
    const body = '{not valid json';
    const ts = Math.floor(Date.now() / 1000);
    const sig = await computeStripeSig(body, 'whsec_test', ts);
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(400);
  });

  test('STRIPE_WEBHOOK_SECRET not configured → 500', async () => {
    const body = JSON.stringify({ type: 'ping' });
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 't=123,v1=sig',
      },
      body,
    });
    const env = makeEnv({ stripeSecret: null });
    delete env.STRIPE_WEBHOOK_SECRET;
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('Webhook secret not configured');
  });

  test('valid signature + checkout.session.completed → license created', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const session = {
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { github_username: 'alice', plan: 'indie' },
          customer: 'cus_stripe123',
          customer_details: { email: null },
        },
      },
    };
    const body = JSON.stringify(session);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    const kv = makeKV();
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ kv, stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.license_key).toMatch(/^difflog_[0-9a-f]{32}$/);

    // Verify it's stored in KV
    expect(kv.put).toHaveBeenCalled();
    const storedKey = kv.put.mock.calls[0][0];
    const storedEntry = JSON.parse(kv.put.mock.calls[0][1]);
    expect(storedEntry.github_username).toBe('alice');
    expect(storedEntry.plan).toBe('indie');
    expect(storedEntry.stripe_customer_id).toBe('cus_stripe123');
  });

  test('checkout.session.completed with customer email — sends license email', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const session = {
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { github_username: 'bob', plan: 'teams' },
          customer: 'cus_789',
          customer_details: { email: 'bob@example.com' },
        },
      },
    };
    const body = JSON.stringify(session);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    // Mock fetch for Resend email
    const origFetch = global.fetch;
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => 'ok',
    });
    global.fetch = mockFetch;

    const kv = makeKV();
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({
      kv,
      stripeSecret: 'whsec_test',
      resendKey: 'resend_test_key',
    }));

    global.fetch = origFetch;

    expect(res.status).toBe(200);
    // Resend email should have been called
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' })
    );
    // Verify email was sent to bob@example.com
    const emailBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(emailBody.to).toContain('bob@example.com');
  });

  test('checkout.session.completed missing github_username → 400', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const session = {
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { plan: 'indie' }, // missing github_username
          customer: 'cus_999',
          customer_details: { email: null },
        },
      },
    };
    const body = JSON.stringify(session);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('github_username');
  });

  test('checkout.session.completed no customer email — skips email, still creates license', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const session = {
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { github_username: 'charlie', plan: 'indie' },
          customer: 'cus_charlie',
          customer_details: null, // no customer details
        },
      },
    };
    const body = JSON.stringify(session);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    const kv = makeKV();
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ kv, stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.license_key).toBeDefined();
  });

  test('duplicate checkout event — creates second license key (idempotency limitation)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const session = {
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { github_username: 'alice', plan: 'indie' },
          customer: 'cus_dup',
          customer_details: null,
        },
      },
    };
    const body = JSON.stringify(session);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    const kv = makeKV();
    const env = makeEnv({ kv, stripeSecret: 'whsec_test' });

    const makeReq = () => new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
      body,
    });

    const res1 = await worker.fetch(makeReq(), env);
    const res2 = await worker.fetch(makeReq(), env);

    const data1 = await res1.json();
    const data2 = await res2.json();

    // Both succeed — two license keys created (current behavior, not necessarily desired)
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(data1.license_key).toBeDefined();
    expect(data2.license_key).toBeDefined();
    // Keys should be different (random)
    expect(data1.license_key).not.toBe(data2.license_key);
  });

  test('subscription.deleted with 0 matching licenses → revoked:0', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const event = {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          customer: 'cus_nobody',
        },
      },
    };
    const body = JSON.stringify(event);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    const kv = makeKV({ 'difflog_other': JSON.stringify({ github_username: 'alice', stripe_customer_id: 'cus_other' }) });
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ kv, stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.revoked).toBe(0);
  });

  test('subscription.deleted with 1 matching license → revoked:1, key deleted', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const event = {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          customer: 'cus_alice',
        },
      },
    };
    const body = JSON.stringify(event);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    const kv = makeKV({
      'difflog_alice_key': JSON.stringify({
        github_username: 'alice',
        stripe_customer_id: 'cus_alice',
        plan: 'indie',
      }),
    });
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ kv, stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.revoked).toBe(1);
    expect(kv.delete).toHaveBeenCalledWith('difflog_alice_key');
  });

  test('subscription.deleted with multiple matching licenses → all revoked', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const event = {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          customer: 'cus_multi',
        },
      },
    };
    const body = JSON.stringify(event);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    const kv = makeKV({
      'difflog_key1': JSON.stringify({ github_username: 'alice', stripe_customer_id: 'cus_multi' }),
      'difflog_key2': JSON.stringify({ github_username: 'alice', stripe_customer_id: 'cus_multi' }),
      'difflog_other': JSON.stringify({ github_username: 'bob', stripe_customer_id: 'cus_other' }),
    });
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ kv, stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.revoked).toBe(2);
  });

  test('unhandled event type → 200 with received:true handled:false', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const event = {
      type: 'payment_intent.created',
      data: { object: {} },
    };
    const body = JSON.stringify(event);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.received).toBe(true);
    expect(data.handled).toBe(false);
  });

  test('KV write failure during license creation → 500', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const session = {
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { github_username: 'alice', plan: 'indie' },
          customer: 'cus_1',
          customer_details: null,
        },
      },
    };
    const body = JSON.stringify(session);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    const kv = makeKV();
    kv.put.mockRejectedValue(new Error('KV write failed'));

    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ kv, stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('Internal error');
  });

  test('subscription.deleted — KV list entry with malformed JSON is skipped', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const event = {
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_alice' } },
    };
    const body = JSON.stringify(event);
    const sig = await computeStripeSig(body, 'whsec_test', ts);

    const kv = makeKV({
      'difflog_bad': 'not json at all',
      'difflog_good': JSON.stringify({ github_username: 'alice', stripe_customer_id: 'cus_alice' }),
    });

    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': sig,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ kv, stripeSecret: 'whsec_test' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    // Only the valid one matched
    expect(data.revoked).toBe(1);
  });
});

// ── generateLicenseKey format ─────────────────────────────────────────────────

describe('License key format', () => {
  test('generated license key format: difflog_ + 32 hex chars', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const session = {
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { github_username: 'test', plan: 'indie' },
          customer: 'cus_test',
          customer_details: null,
        },
      },
    };
    const body = JSON.stringify(session);
    const sig = await (async () => {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw', encoder.encode('whsec_test'),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const s = await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}.${body}`));
      return `t=${ts},v1=${Array.from(new Uint8Array(s)).map(b => b.toString(16).padStart(2,'0')).join('')}`;
    })();

    const kv = makeKV();
    const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
      body,
    });
    const res = await worker.fetch(req, makeEnv({ kv, stripeSecret: 'whsec_test' }));
    const data = await res.json();
    expect(data.license_key).toMatch(/^difflog_[0-9a-f]{32}$/);
  });

  test('two generated license keys are different (unique)', async () => {
    const keys = new Set();
    for (let i = 0; i < 10; i++) {
      const ts = Math.floor(Date.now() / 1000);
      const session = {
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { github_username: `user${i}`, plan: 'indie' },
            customer: `cus_${i}`,
            customer_details: null,
          },
        },
      };
      const body = JSON.stringify(session);
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw', encoder.encode('whsec_test'),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const s = await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}.${body}`));
      const sigHeader = `t=${ts},v1=${Array.from(new Uint8Array(s)).map(b => b.toString(16).padStart(2,'0')).join('')}`;

      const kv = makeKV();
      const req = new Request('https://difflog-license.workers.dev/webhook/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': sigHeader },
        body,
      });
      const res = await worker.fetch(req, makeEnv({ kv, stripeSecret: 'whsec_test' }));
      const data = await res.json();
      keys.add(data.license_key);
    }
    expect(keys.size).toBe(10); // all unique
  });
});

// ── Response Content-Type ─────────────────────────────────────────────────────

describe('Response headers', () => {
  test('all JSON responses have Content-Type: application/json', async () => {
    const req = makeRequest('GET', '/health');
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  test('404 response has Content-Type: application/json', async () => {
    const req = makeRequest('GET', '/nonexistent');
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  test('validate 400 response has Content-Type: application/json', async () => {
    const req = makeRequest('POST', '/validate', { body: { github_username: 'alice' } });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });
});
