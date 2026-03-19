/**
 * Difflog License Validation Worker
 *
 * Routes:
 *   POST /validate          — validate a license key + GitHub username pair
 *   POST /webhook/stripe    — handle Stripe subscription events
 *   GET  /health            — liveness check
 *
 * KV schema (binding: LICENSES):
 *   key:   license_key  (e.g. "difflog_abc123...")
 *   value: JSON string  { github_username, plan, stripe_customer_id, created_at }
 *
 * Required env vars (set in Cloudflare dashboard):
 *   STRIPE_WEBHOOK_SECRET   — from Stripe Dashboard -> Webhooks -> signing secret
 */

// --- Helpers ------------------------------------------------------------------

/** Generate a new license key: difflog_ + 32 random hex chars */
function generateLicenseKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `difflog_${hex}`;
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
async function sendLicenseKeyEmail(email, licenseKey, plan, env) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping license key email');
    return;
  }

  const planLabel = plan === 'teams' ? 'Teams' : 'Indie';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #24292f;">
      <h2 style="color: #1a7f37;">Your Difflog license key</h2>
      <p>Thanks for subscribing to Difflog <strong>${planLabel}</strong>.</p>
      <p>Here's your license key:</p>
      <pre style="background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 16px; font-size: 14px; word-break: break-all;">${licenseKey}</pre>
      <h3>Add it to GitHub Secrets</h3>
      <ol>
        <li>Go to your repo → <strong>Settings → Secrets and variables → Actions</strong></li>
        <li>Click <strong>New repository secret</strong></li>
        <li>Name: <code>DIFFLOG_LICENSE_KEY</code></li>
        <li>Value: paste the key above</li>
      </ol>
      <p>Then add it to your workflow:</p>
      <pre style="background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 16px; font-size: 13px;">- uses: patchwork-eng/difflog@v1
  with:
    openai_key: \${{ secrets.OPENAI_API_KEY }}
    license_key: \${{ secrets.DIFFLOG_LICENSE_KEY }}</pre>
      <p>Questions? Reply to this email or reach us at <a href="mailto:hello@difflog.io">hello@difflog.io</a>.</p>
      <hr style="border: none; border-top: 1px solid #d0d7de; margin: 24px 0;">
      <p style="font-size: 12px; color: #57606a;">Difflog · <a href="https://difflog.io">difflog.io</a></p>
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Difflog <hello@difflog.io>',
      to: [email],
      subject: `Your Difflog ${planLabel} license key`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Resend error:', res.status, body);
  } else {
    console.log(`License key email sent to ${email}`);
  }
}

// --- Route handlers -----------------------------------------------------------

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

  // Username check
  if (entry.github_username !== github_username) {
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

/** POST /webhook/stripe */
async function handleStripeWebhook(request, env) {
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

      // Expects metadata: { github_username, plan } set during checkout session creation
      const githubUsername = session.metadata && session.metadata.github_username;
      const plan = (session.metadata && session.metadata.plan) || 'indie';
      const stripeCustomerId = session.customer;

      if (!githubUsername) {
        console.error('checkout.session.completed: missing github_username in metadata');
        return jsonResponse({ error: 'Missing github_username in session metadata.' }, 400);
      }

      const licenseKey = generateLicenseKey();
      const entry = {
        github_username: githubUsername,
        plan,
        stripe_customer_id: stripeCustomerId,
        created_at: new Date().toISOString(),
      };

      await env.LICENSES.put(licenseKey, JSON.stringify(entry));

      console.log(`License created for ${githubUsername}: ${licenseKey}`);

      // Email the license key to the customer via Resend
      const customerEmail = session.customer_details && session.customer_details.email;
      if (customerEmail) {
        await sendLicenseKeyEmail(customerEmail, licenseKey, plan, env);
      } else {
        console.warn('checkout.session.completed: no customer email found, skipping license key email');
      }

      return jsonResponse({ success: true, license_key: licenseKey });

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

/** GET /health */
function handleHealth() {
  return jsonResponse({
    status: 'ok',
    service: 'difflog-license',
    timestamp: new Date().toISOString(),
  });
}

// --- Main fetch handler -------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (method === 'OPTIONS') {
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

    if (pathname === '/webhook/stripe' && method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    return jsonResponse({ error: 'Not found.' }, 404);
  },
};
