/**
 * Difflog + AutoPR + Fragile License Validation Worker
 *
 * Routes:
 *   POST /validate          — validate a Difflog license key + GitHub username pair
 *   POST /validate-autopr   — validate an AutoPR license key + repo pair
 *   POST /validate-fragile  — validate a Fragile license key + repo pair
 *   POST /webhook/stripe    — handle Stripe subscription events (all products)
 *   POST /demo              — generate a changelog from a public GitHub repo
 *   GET  /health            — liveness check
 *
 * KV schema (binding: LICENSES):
 *   key:   license_key              (e.g. "difflog_abc123...")        — Difflog license
 *   key:   autopr_license_{key}     (e.g. "autopr_license_abc123")    — AutoPR license
 *   key:   fragile_license_{key}    (e.g. "fragile_license_abc123")   — Fragile license
 *   value: JSON string  { github_username, plan, stripe_customer_id, created_at }
 *
 *   key:   demo_ratelimit_{ip}
 *   value: JSON string  { count, reset_at }
 *
 * Required env vars (set in Cloudflare dashboard):
 *   STRIPE_WEBHOOK_SECRET   — from Stripe Dashboard -> Webhooks -> signing secret
 *   OPENAI_API_KEY          — for the /demo endpoint
 */

// --- Stripe price IDs (live) --------------------------------------------------
const AUTOPR_INDIE_PRICE_ID    = 'price_1TCX6u0p242H3IUdhCRoCtWo';
const AUTOPR_TEAMS_PRICE_ID    = 'price_1TCX6v0p242H3IUdM0pSptgu';
const DIFFLOG_INDIE_PRICE_ID   = 'price_1TCT6H0p242H3IUdyyGsOEpf';
const DIFFLOG_TEAMS_PRICE_ID   = 'price_1TCT6I0p242H3IUd5og0nTlm';
const FRAGILE_INDIE_PRICE_ID   = 'price_1TCoMB0p242H3IUdijRUUjYp';
const FRAGILE_TEAMS_PRICE_ID   = 'price_1TCoMB0p242H3IUdTFsGBz0m';

// --- Helpers ------------------------------------------------------------------

/** Generate a new license key: {prefix}_ + 32 random hex chars */
function generateLicenseKey(prefix = 'difflog') {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

/** Verify a Stripe webhook signature using the Web Crypto API */
async function verifyStripeSignature(body, signatureHeader, secret) {
  if (!signatureHeader) return false;

  // Stripe sends: t=timestamp,v1=sig1,v1=sig2,...
  const parts = {};
  for (const part of signatureHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx);
      const v = part.slice(idx + 1);
      parts[k] = v;
    }
  }

  const timestamp = parts['t'];
  const signatures = signatureHeader
    .split(',')
    .filter(p => p.startsWith('v1='))
    .map(p => p.slice(3));

  if (!timestamp || signatures.length === 0) return false;

  // Reject webhooks older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const signedPayload = `${timestamp}.${body}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(signedPayload);

  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, msgData);
  const expectedHex = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return signatures.some(s => s === expectedHex);
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/** Build CORS headers for the /demo endpoint */
function corsHeaders(origin) {
  const allowed = ['https://difflog.io', 'https://patchwork-eng.github.io'];
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

// --- Email helpers ------------------------------------------------------------

/**
 * Send a license key email to the customer.
 * TODO: wire Resend — set RESEND_API_KEY as a Worker env variable.
 * See WORKER_DEPLOY.md for setup instructions.
 *
 * @param {string} email       - Customer email address
 * @param {string} licenseKey  - Generated difflog_... key
 * @param {string} plan        - 'indie' | 'teams'
 * @param {object} env         - Worker environment bindings
 */
async function sendLicenseKeyEmail(email, licenseKey, plan, env, isAutopr = false, isFragile = false) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping license key email');
    return;
  }

  const planLabel = plan === 'teams' ? 'Teams' : 'Indie';
  const productName = isFragile ? 'Fragile' : (isAutopr ? 'AutoPR' : 'Difflog');
  const secretName = isFragile ? 'FRAGILE_LICENSE_KEY' : (isAutopr ? 'AUTOPR_LICENSE_KEY' : 'DIFFLOG_LICENSE_KEY');
  const actionRef = isFragile ? 'patchwork-eng/fragile@v1' : (isAutopr ? 'patchwork-eng/autopr@v1' : 'patchwork-eng/difflog@v1');
  const siteUrl = isFragile ? 'https://usefragile.dev' : (isAutopr ? 'https://autopr.dev' : 'https://difflog.io');
  const fromEmail = isFragile ? 'Fragile <fragile@difflog.io>' : (isAutopr ? 'AutoPR <autopr@difflog.io>' : 'Difflog <hello@difflog.io>');
  const accentColor = isFragile ? '#f0883e' : (isAutopr ? '#388bfd' : '#1a7f37');
  const openaiKeyName = isFragile ? 'OPENAI_KEY' : (isAutopr ? 'OPENAI_KEY' : 'OPENAI_API_KEY');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #24292f;">
      <h2 style="color: ${accentColor};">Your ${productName} license key</h2>
      <p>Thanks for subscribing to ${productName} <strong>${planLabel}</strong>.</p>
      <p>Here's your license key:</p>
      <pre style="background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 16px; font-size: 14px; word-break: break-all;">${licenseKey}</pre>
      <h3>Add it to GitHub Secrets</h3>
      <ol>
        <li>Go to your repo → <strong>Settings → Secrets and variables → Actions</strong></li>
        <li>Click <strong>New repository secret</strong></li>
        <li>Name: <code>${secretName}</code></li>
        <li>Value: paste the key above</li>
      </ol>
      <p>Then add it to your workflow:</p>
      <pre style="background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 16px; font-size: 13px;">- uses: ${actionRef}
  with:
    openai_key: \${{ secrets.${openaiKeyName} }}
    license_key: \${{ secrets.${secretName} }}</pre>
      <p>Questions? Reply to this email or reach us at <a href="mailto:hello@difflog.io">hello@difflog.io</a>.</p>
      <hr style="border: none; border-top: 1px solid #d0d7de; margin: 24px 0;">
      <p style="font-size: 12px; color: #57606a;">${productName} by Patchwork · <a href="${siteUrl}">${siteUrl.replace('https://', '')}</a></p>
    </div>
  `;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: `Your ${productName} ${planLabel} license key`,
        html,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error('Resend error:', res.status, errBody);
    } else {
      console.log(`${productName} license key email sent to ${email}`);
    }
  } catch (err) {
    console.error('Resend fetch error (may have timed out):', err);
  } finally {
    clearTimeout(timer);
  }
}

// --- Route handlers -----------------------------------------------------------

/** POST /validate-autopr */
async function handleValidateAutopr(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ valid: false, message: 'Invalid JSON body.' }, 400);
  }

  const { license_key, repo } = body;

  if (!license_key || !repo) {
    return jsonResponse({
      valid: false,
      message: 'Missing required fields: license_key and repo.',
    }, 400);
  }

  // KV lookup — AutoPR uses "autopr_license_" prefix namespace
  // Strip the "autopr_" prefix if present (users receive keys like "autopr_abc123",
  // but they are stored as "autopr_license_abc123" — not "autopr_license_autopr_abc123").
  const strippedKey = license_key.startsWith('autopr_') ? license_key.slice('autopr_'.length) : license_key;
  const kvKey = `autopr_license_${strippedKey}`;
  let entry;
  try {
    const raw = await env.LICENSES.get(kvKey);
    if (!raw) {
      return jsonResponse({
        valid: false,
        message: 'Invalid license key. Get one at https://autopr.dev',
      });
    }
    entry = JSON.parse(raw);
  } catch (err) {
    console.error('KV lookup error (autopr):', err);
    return jsonResponse({ valid: false, message: 'License validation service error.' }, 500);
  }

  // Log usage to KV
  try {
    const usage = Array.isArray(entry.usage) ? entry.usage : [];
    usage.push({
      timestamp: Date.now(),
      repo,
    });
    if (usage.length > 100) {
      usage.splice(0, usage.length - 100);
    }
    entry.usage = usage;
    await env.LICENSES.put(kvKey, JSON.stringify(entry));
  } catch (err) {
    console.error('AutoPR usage logging error:', err);
  }

  return jsonResponse({
    valid: true,
    plan: entry.plan || 'indie',
    message: 'License valid.',
  });
}

/** POST /validate */
async function handleValidate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ valid: false, plan: null, message: 'Invalid JSON body.' }, 400);
  }

  const { license_key, github_username } = body;

  if (!license_key || !github_username) {
    return jsonResponse({
      valid: false,
      plan: null,
      message: 'Missing required fields: license_key and github_username.',
    }, 400);
  }

  // KV lookup
  let entry;
  try {
    const raw = await env.LICENSES.get(license_key);
    if (!raw) {
      return jsonResponse({
        valid: false,
        plan: null,
        message: 'Invalid license key. Get one at https://difflog.io',
      });
    }
    entry = JSON.parse(raw);
  } catch (err) {
    console.error('KV lookup error:', err);
    return jsonResponse({ valid: false, plan: null, message: 'License validation service error.' }, 500);
  }

  // Username check — only enforced if the license was created with a username
  // (payment link purchases don't capture github_username, so skip the check for those)
  if (entry.github_username && entry.github_username !== github_username) {
    return jsonResponse({
      valid: false,
      plan: null,
      message: 'License key is registered to a different GitHub account.',
    });
  }

  // Log usage to KV
  try {
    const usage = Array.isArray(entry.usage) ? entry.usage : [];
    usage.push({
      timestamp: Date.now(),
      github_username,
      repo_type: 'private',
    });
    // Keep only the last 100 usage entries
    if (usage.length > 100) {
      usage.splice(0, usage.length - 100);
    }
    entry.usage = usage;
    await env.LICENSES.put(license_key, JSON.stringify(entry));
  } catch (err) {
    // Non-fatal: log but don't block the validation response
    console.error('Usage logging error:', err);
  }

  return jsonResponse({
    valid: true,
    plan: entry.plan || 'indie',
    message: 'License valid.',
  });
}

/**
 * Fetch line items for a Stripe checkout session.
 * Returns the first price ID found, or null.
 */
async function fetchSessionPriceId(sessionId, stripeSecretKey) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=5`,
        {
          signal: controller.signal,
          headers: { 'Authorization': `Bearer ${stripeSecretKey}` },
        }
      );
      if (!res.ok) {
        console.error('Stripe line_items fetch error:', res.status);
        return null;
      }
      const data = await res.json();
      return data.data?.[0]?.price?.id ?? null;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error('fetchSessionPriceId error:', err);
    return null;
  }
}

/** POST /webhook/stripe */
async function handleStripeWebhook(request, env, ctx) {
  const signature = request.headers.get('stripe-signature');
  const body = await request.text();

  // Verify signature
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return jsonResponse({ error: 'Webhook secret not configured.' }, 500);
  }

  const valid = await verifyStripeSignature(body, signature, webhookSecret);
  if (!valid) {
    return jsonResponse({ error: 'Invalid webhook signature.' }, 401);
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch (_) {
    return jsonResponse({ error: 'Invalid JSON.' }, 400);
  }

  const eventType = event.type;
  console.log(`Stripe event: ${eventType}`);

  try {
    if (eventType === 'checkout.session.completed') {
      const session = event.data.object;
      const stripeCustomerId = session.customer;
      const customerEmail = session.customer_details && session.customer_details.email;

      // --- Determine product from actual price ID (not metadata) ---
      // Stripe payment links don't populate session.metadata.price_id automatically.
      // Fetch line items from the Stripe API to get the real price ID.
      let priceId = null;
      if (env.STRIPE_SECRET_KEY) {
        priceId = await fetchSessionPriceId(session.id, env.STRIPE_SECRET_KEY);
      }
      // Fallback: check metadata if line item fetch failed
      if (!priceId) {
        priceId = session.metadata && session.metadata.price_id;
      }
      console.log(`checkout.session.completed: session=${session.id} priceId=${priceId}`);

      // --- Determine plan label from price ID ---
      const isAutoprIndie   = priceId === AUTOPR_INDIE_PRICE_ID;
      const isAutoprTeams   = priceId === AUTOPR_TEAMS_PRICE_ID;
      const isDifflogIndie  = priceId === DIFFLOG_INDIE_PRICE_ID;
      const isDifflogTeams  = priceId === DIFFLOG_TEAMS_PRICE_ID;
      const isFragileIndie  = priceId === FRAGILE_INDIE_PRICE_ID;
      const isFragileTeams  = priceId === FRAGILE_TEAMS_PRICE_ID;
      const isAutopr  = isAutoprIndie  || isAutoprTeams  || (session.metadata && session.metadata.product_type === 'autopr');
      const isFragile = isFragileIndie || isFragileTeams || (session.metadata && session.metadata.product_type === 'fragile');
      const plan = (isAutoprTeams || isDifflogTeams || isFragileTeams) ? 'teams' : 'indie';

      // --- Generate license key and store in KV ---
      let licenseKey, kvKey, product;

      if (isFragile) {
        const rawKey = generateLicenseKey('fragile');
        kvKey = `fragile_license_${rawKey.replace('fragile_', '')}`;
        licenseKey = rawKey;
        product = 'fragile';
        const entry = {
          plan,
          stripe_customer_id: stripeCustomerId,
          created_at: new Date().toISOString(),
          email: customerEmail || null,
        };
        await env.LICENSES.put(kvKey, JSON.stringify(entry));
        console.log(`Fragile license created: ${licenseKey} (kv: ${kvKey})`);
      } else if (isAutopr) {
        const rawKey = generateLicenseKey('autopr');
        kvKey = `autopr_license_${rawKey.replace('autopr_', '')}`;
        licenseKey = rawKey;
        product = 'autopr';
        const entry = {
          plan,
          stripe_customer_id: stripeCustomerId,
          created_at: new Date().toISOString(),
          email: customerEmail || null,
        };
        await env.LICENSES.put(kvKey, JSON.stringify(entry));
        console.log(`AutoPR license created: ${licenseKey} (kv: ${kvKey})`);
      } else {
        // Difflog purchase (default for all Difflog price IDs + unknown price IDs)
        licenseKey = generateLicenseKey('difflog');
        kvKey = licenseKey;
        product = 'difflog';
        const githubUsername = session.metadata && session.metadata.github_username;
        const entry = {
          plan,
          stripe_customer_id: stripeCustomerId,
          created_at: new Date().toISOString(),
          email: customerEmail || null,
        };
        if (githubUsername) entry.github_username = githubUsername;
        await env.LICENSES.put(kvKey, JSON.stringify(entry));
        console.log(`Difflog license created: ${licenseKey}`);
      }

      // --- Respond to Stripe immediately, then send email in background ---
      if (customerEmail) {
        const emailPromise = sendLicenseKeyEmail(customerEmail, licenseKey, plan, env, isAutopr, isFragile);
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(emailPromise); // non-blocking in production
        } else {
          emailPromise.catch(err => console.error('Email send error:', err)); // test fallback
        }
      } else {
        console.warn(`checkout.session.completed (${product}): no customer email, skipping email`);
      }

      return jsonResponse({ success: true, license_key: licenseKey, product });

    } else if (eventType === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const stripeCustomerId = subscription.customer;

      // Scan KV to find license(s) for this customer and delete them.
      // Note: KV doesn't support reverse lookups natively — full scan required.
      // In a high-volume system, maintain a secondary index: customer_id -> license_key
      let deleted = 0;
      let cursor = undefined;

      do {
        const listResult = await env.LICENSES.list({ cursor, limit: 1000 });
        for (const key of listResult.keys) {
          const raw = await env.LICENSES.get(key.name);
          if (!raw) continue;
          let entry;
          try { entry = JSON.parse(raw); } catch (_) { continue; }

          if (entry.stripe_customer_id === stripeCustomerId) {
            await env.LICENSES.delete(key.name);
            deleted++;
            console.log(`License revoked for customer ${stripeCustomerId}: ${key.name}`);
          }
        }
        cursor = listResult.list_complete ? undefined : listResult.cursor;
      } while (cursor);

      if (deleted === 0) {
        console.warn(`No license found for Stripe customer ${stripeCustomerId}`);
      }

      return jsonResponse({ success: true, revoked: deleted });

    } else {
      // Ignore unhandled event types — Stripe expects 200 for all received events
      return jsonResponse({ received: true, handled: false });
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return jsonResponse({ error: 'Internal error processing webhook.' }, 500);
  }
}

/** POST /validate-fragile */
async function handleValidateFragile(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ valid: false, message: 'Invalid JSON body.' }, 400);
  }

  const { license_key, repo } = body;

  if (!license_key || !repo) {
    return jsonResponse({
      valid: false,
      message: 'Missing required fields: license_key and repo.',
    }, 400);
  }

  // Strip "fragile_" prefix if present — keys stored as "fragile_license_{rest}"
  const strippedKey = license_key.startsWith('fragile_') ? license_key.slice('fragile_'.length) : license_key;
  const kvKey = `fragile_license_${strippedKey}`;
  let entry;
  try {
    const raw = await env.LICENSES.get(kvKey);
    if (!raw) {
      return jsonResponse({
        valid: false,
        message: 'Invalid license key. Get one at https://usefragile.dev',
      });
    }
    entry = JSON.parse(raw);
  } catch (err) {
    console.error('KV lookup error (fragile):', err);
    return jsonResponse({ valid: false, message: 'License validation service error.' }, 500);
  }

  // Log usage
  try {
    const usage = Array.isArray(entry.usage) ? entry.usage : [];
    usage.push({ timestamp: Date.now(), repo });
    if (usage.length > 100) usage.splice(0, usage.length - 100);
    entry.usage = usage;
    await env.LICENSES.put(kvKey, JSON.stringify(entry));
  } catch (err) {
    console.error('Fragile usage logging error:', err);
  }

  return jsonResponse({
    valid: true,
    plan: entry.plan || 'indie',
    message: 'License valid.',
  });
}

/** GET /health */
function handleHealth() {
  return jsonResponse({
    status: 'ok',
    service: 'difflog-license',
    timestamp: new Date().toISOString(),
  });
}

/** POST /demo */
async function handleDemo(request, env) {
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin);

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ success: false, error: 'Invalid JSON body.' }, 400, cors);
  }

  const { owner, repo } = body;
  if (!owner || !repo) {
    return jsonResponse({ success: false, error: 'Missing owner or repo.' }, 400, cors);
  }

  // Sanitize
  const safeOwner = String(owner).replace(/[^a-zA-Z0-9\-_.]/g, '').slice(0, 100);
  const safeRepo  = String(repo).replace(/[^a-zA-Z0-9\-_.]/g, '').slice(0, 100);

  // --- IP-based rate limiting (max 5/hour) ---
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const rlKey = `demo_ratelimit_${ip}`;
  const LIMIT = 20;
  const WINDOW_MS = 60 * 60 * 1000; // 1 hour

  try {
    const rlRaw = await env.LICENSES.get(rlKey);
    const now = Date.now();
    let rl = rlRaw ? JSON.parse(rlRaw) : { count: 0, reset_at: now + WINDOW_MS };

    if (now > rl.reset_at) {
      rl = { count: 0, reset_at: now + WINDOW_MS };
    }

    if (rl.count >= LIMIT) {
      return jsonResponse({
        success: false,
        error: 'Rate limit: 20 demos per hour. Come back later or install Difflog in your repo.',
      }, 429, cors);
    }

    rl.count++;
    // Store with TTL slightly beyond the window
    const ttlSeconds = Math.ceil((rl.reset_at - now) / 1000) + 10;
    await env.LICENSES.put(rlKey, JSON.stringify(rl), { expirationTtl: ttlSeconds });
  } catch (err) {
    // Non-fatal: if KV fails, allow the request through
    console.error('Rate limit KV error:', err);
  }

  // --- Fetch commits from GitHub ---
  let commits;
  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${safeOwner}/${safeRepo}/commits?per_page=20`,
      { headers: { 'User-Agent': 'difflog-demo/1.0', ...(env.GITHUB_TOKEN ? { 'Authorization': `token ${env.GITHUB_TOKEN}` } : {}) } }
    );

    if (ghRes.status === 404) {
      return jsonResponse({ success: false, error: 'Repository not found or is private.' }, 200, cors);
    }
    if (ghRes.status === 403 || ghRes.status === 429) {
      return jsonResponse({ success: false, error: 'GitHub API rate limit hit. Try again in a minute.' }, 200, cors);
    }
    if (!ghRes.ok) {
      return jsonResponse({ success: false, error: 'Repository not found or is private.' }, 200, cors);
    }

    commits = await ghRes.json();
  } catch (err) {
    console.error('GitHub fetch error:', err);
    return jsonResponse({ success: false, error: 'Could not reach GitHub. Try again.' }, 200, cors);
  }

  if (!Array.isArray(commits) || commits.length === 0) {
    return jsonResponse({ success: false, error: 'No commits found in this repository.' }, 200, cors);
  }

  // --- Filter merge and bot commits ---
  const botPatterns = /\[bot\]|dependabot|renovate|greenkeeper|snyk-bot/i;
  const mergePattern = /^Merge (pull request|branch|remote-tracking|tag)/i;

  const filtered = commits.filter(c => {
    const msg = c.commit?.message || '';
    const author = c.commit?.author?.name || '';
    const login = c.author?.login || '';

    if (mergePattern.test(msg)) return false;
    if (botPatterns.test(author) || botPatterns.test(login)) return false;
    return true;
  });

  if (filtered.length === 0) {
    return jsonResponse({ success: false, error: 'No commits found in this repository.' }, 200, cors);
  }

  // --- Build OpenAI prompt ---
  const commitList = filtered.map(c => {
    const sha = (c.sha || '').slice(0, 7);
    const msg = (c.commit?.message || '').split('\n')[0].trim();
    const author = c.commit?.author?.name || 'unknown';
    return `${sha} ${msg} (${author})`;
  }).join('\n');

  // --- Call OpenAI ---
  if (!env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not configured');
    return jsonResponse({ success: false, error: 'Could not generate changelog. Try again.' }, 200, cors);
  }

  let changelog;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content: 'You are a technical writer. Given these git commits, write a clean, human-readable changelog section. Group into Features, Bug Fixes, and Maintenance. Use ## vNext as the heading. Write in clear prose — not raw commit messages.',
          },
          {
            role: 'user',
            content: `Here are the recent commits for ${safeOwner}/${safeRepo}:\n\n${commitList}`,
          },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error('OpenAI error:', aiRes.status, errBody);
      return jsonResponse({ success: false, error: 'Could not generate changelog. Try again.' }, 200, cors);
    }

    const aiData = await aiRes.json();
    changelog = aiData.choices?.[0]?.message?.content?.trim();

    if (!changelog) {
      return jsonResponse({ success: false, error: 'Could not generate changelog. Try again.' }, 200, cors);
    }
  } catch (err) {
    console.error('OpenAI fetch error:', err);
    return jsonResponse({ success: false, error: 'Could not generate changelog. Try again.' }, 200, cors);
  }

  return jsonResponse({
    success: true,
    changelog,
    repo: `${safeOwner}/${safeRepo}`,
    commit_count: filtered.length,
  }, 200, cors);
}

// --- Main fetch handler -------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (method === 'OPTIONS') {
      if (pathname === '/demo') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin),
        });
      }
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (pathname === '/health' && method === 'GET') {
      return handleHealth();
    }

    if (pathname === '/validate' && method === 'POST') {
      return handleValidate(request, env);
    }

    if (pathname === '/validate-autopr' && method === 'POST') {
      return handleValidateAutopr(request, env);
    }

    if (pathname === '/validate-fragile' && method === 'POST') {
      return handleValidateFragile(request, env);
    }

    if (pathname === '/webhook/stripe' && method === 'POST') {
      return handleStripeWebhook(request, env, ctx);
    }

    if (pathname === '/demo' && method === 'POST') {
      return handleDemo(request, env);
    }

    return jsonResponse({ error: 'Not found.' }, 404);
  },
};
