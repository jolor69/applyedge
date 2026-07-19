// ApplyEdge Worker — Full stack
// Endpoints: /signup /login /verify-email /forgot-password /reset-password /me
//            /fetch-jd  / (AI completions)

const MONTHLY_LIMIT_FREE = 3;
const MONTHLY_LIMIT_SEEKER = 10;
const MONTHLY_LIMIT_CAMPAIGNER = 200;
const MONTHLY_LIMIT_CAMPAIGNER_JOBMATCH = 40;
const FROM_EMAIL = 'no-reply@applydge.work';
const APP_URL = 'https://applydge.work';
const ADMIN_EMAILS = ['joe.lord.ai@gmail.com', 'neuralstocks.dev@gmail.com'];
const PAYPAL_API = 'https://api-m.paypal.com';
const PAYPAL_CLIENT_ID = 'AXaVg36-SXOe1Y1JxjskLkP-pd5bz6VJWNlDuE6Oif5san9-CyEID5RZMPHtHbybjlHFFPVqWeENMBV1';
const PLAN_SEEKER = 'P-0B417572P35980515NIV2RSY';
const PLAN_CAMPAIGNER = 'P-48V48243DM4053416NIV2MPI';
const ACARTE_PRICES = { scan: '4.00', cover: '3.00', bundle: '6.00' };
const ACARTE_CREDITS = {
  scan:   { scans: 5,  covers: 0,  signals: 0 },
  cover:  { scans: 0,  covers: 5,  signals: 0 },
  bundle: { scans: 10, covers: 10, signals: 1 }
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Signal-Call, X-Tool-Type',
};

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function verifyPassword(password, hash) {
  return await hashPassword(password) === hash;
}

function generateToken(length = 32) {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function generateId() {
  return generateToken(16);
}

async function signJWT(payload, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${unsigned}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const unsigned = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sig = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(unsigned));
    if (!valid) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function sendEmail(to, subject, html, resendKey) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `ApplyEdge <${FROM_EMAIL}>`,
      to: [to],
      subject,
      html,
    }),
  });
  return res.ok;
}

function verifyEmailTemplate(link) {
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
      <h2 style="color:#2b5438">Verify your ApplyEdge account</h2>
      <p style="color:#6e6659;line-height:1.6">Click the button below to verify your email address and activate your account.</p>
      <a href="${link}" style="display:inline-block;margin:24px 0;background:#2b5438;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Verify email</a>
      <p style="color:#a09890;font-size:13px">Link expires in 24 hours. If you didn't sign up, ignore this email.</p>
      <hr style="border:none;border-top:1px solid #ddd8ce;margin:24px 0">
      <p style="color:#a09890;font-size:12px">applydge.work</p>
    </div>`;
}

function resetPasswordTemplate(link) {
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
      <h2 style="color:#2b5438">Reset your password</h2>
      <p style="color:#6e6659;line-height:1.6">Click the button below to set a new password for your ApplyEdge account.</p>
      <a href="${link}" style="display:inline-block;margin:24px 0;background:#bf7d20;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Reset password</a>
      <p style="color:#a09890;font-size:13px">Link expires in 1 hour. If you didn't request this, ignore this email.</p>
      <hr style="border:none;border-top:1px solid #ddd8ce;margin:24px 0">
      <p style="color:#a09890;font-size:12px">applydge.work</p>
    </div>`;
}

async function getUserFromRequest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.sub).first();
  return user || null;
}

function getPlanLimit(plan) {
  if (plan === 'campaigner') return MONTHLY_LIMIT_CAMPAIGNER;
  if (plan === 'seeker') return MONTHLY_LIMIT_SEEKER;
  return MONTHLY_LIMIT_FREE;
}

function isNewPeriod(user) {
  const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
  return user.scans_reset_date < firstOfMonth;
}

function isNewJobMatchPeriod(user) {
  const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
  return (user.jobmatch_reset_date || '') < firstOfMonth;
}

async function getPayPalToken(env) {
  const creds = btoa(PAYPAL_CLIENT_ID + ':' + env.PAYPAL_SECRET);
  const res = await fetch(PAYPAL_API + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + creds,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const d = await res.json();
  return d.access_token;
}

async function getSubscription(subscriptionId, token) {
  const res = await fetch(PAYPAL_API + '/v1/billing/subscriptions/' + subscriptionId, {
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  return await res.json();
}

function planIdToPlan(planId) {
  if (planId === PLAN_CAMPAIGNER) return 'campaigner';
  if (planId === PLAN_SEEKER) return 'seeker';
  return 'free';
}

async function createPayPalOrder(type, token) {
  const price = ACARTE_PRICES[type];
  const res = await fetch(PAYPAL_API + '/v2/checkout/orders', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': 'applyedge-' + type + '-' + Date.now()
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: price },
        description: 'ApplyEdge a la carte: ' + type
      }]
    })
  });
  return await res.json();
}

async function capturePayPalOrder(orderId, token) {
  const res = await fetch(PAYPAL_API + '/v2/checkout/orders/' + orderId + '/capture', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  return await res.json();
}

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/signup' && request.method === 'POST') {
      const { email, password } = await request.json();
      if (!email || !password) return jsonRes({ error: 'Email and password required' }, 400);
      if (password.length < 8) return jsonRes({ error: 'Password must be at least 8 characters' }, 400);

      const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
      if (existing) return jsonRes({ error: 'An account with this email already exists' }, 409);

      const id = generateId();
      const hash = await hashPassword(password);
      await env.DB.prepare(
        'INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)'
      ).bind(id, email.toLowerCase(), hash).run();

      const token = generateToken();
      const expires = new Date(Date.now() + 86400000).toISOString();
      await env.DB.prepare(
        'INSERT INTO tokens (token, user_id, type, expires_at) VALUES (?, ?, ?, ?)'
      ).bind(token, id, 'verify', expires).run();

      const link = `${APP_URL}/?verify=${token}`;
      await sendEmail(email, 'Verify your ApplyEdge account', verifyEmailTemplate(link), env.RESEND_API_KEY);

      return jsonRes({ message: 'Account created. Check your email to verify.' });
    }

    if (url.pathname === '/verify-email' && request.method === 'POST') {
      const { token } = await request.json();
      const row = await env.DB.prepare(
        'SELECT * FROM tokens WHERE token = ? AND type = ? AND used = 0'
      ).bind(token, 'verify').first();

      if (!row) return jsonRes({ error: 'Invalid or expired verification link' }, 400);
      if (new Date(row.expires_at) < new Date()) return jsonRes({ error: 'Verification link has expired' }, 400);

      await env.DB.prepare('UPDATE users SET verified = 1 WHERE id = ?').bind(row.user_id).run();
      await env.DB.prepare('UPDATE tokens SET used = 1 WHERE token = ?').bind(token).run();

      return jsonRes({ message: 'Email verified. You can now log in.' });
    }

    if (url.pathname === '/login' && request.method === 'POST') {
      const { email, password } = await request.json();
      if (!email || !password) return jsonRes({ error: 'Email and password required' }, 400);

      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first();
      if (!user) return jsonRes({ error: 'Incorrect email or password' }, 401);

      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) return jsonRes({ error: 'Incorrect email or password' }, 401);

      if (!user.verified) return jsonRes({ error: 'Please verify your email before logging in. Check your inbox.' }, 403);

      const jwt = await signJWT(
        { sub: user.id, email: user.email, plan: user.plan, exp: Math.floor(Date.now() / 1000) + 604800 },
        env.JWT_SECRET
      );

      await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?")
        .bind(new Date().toISOString(), user.id).run();

      return jsonRes({
        token: jwt,
        user: { id: user.id, email: user.email, plan: user.plan, scans_used: user.scans_used, is_admin: ADMIN_EMAILS.includes(user.email) }
      });
    }

    if (url.pathname === '/me' && request.method === 'GET') {
      const user = await getUserFromRequest(request, env);
      if (!user) return jsonRes({ error: 'Not authenticated' }, 401);
      return jsonRes({ id: user.id, email: user.email, plan: user.plan, scans_used: user.scans_used, is_admin: ADMIN_EMAILS.includes(user.email), credits_scans: user.credits_scans || 0, credits_covers: user.credits_covers || 0, credits_signals: user.credits_signals || 0, source: user.source || 'organic' });
    }

    if (url.pathname === '/forgot-password' && request.method === 'POST') {
      const { email } = await request.json();
      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first();

      if (!user) return jsonRes({ message: 'If that email exists, a reset link has been sent.' });

      const token = generateToken();
      const expires = new Date(Date.now() + 3600000).toISOString();
      await env.DB.prepare(
        'INSERT INTO tokens (token, user_id, type, expires_at) VALUES (?, ?, ?, ?)'
      ).bind(token, user.id, 'reset', expires).run();

      const link = `${APP_URL}/?reset=${token}`;
      await sendEmail(email, 'Reset your ApplyEdge password', resetPasswordTemplate(link), env.RESEND_API_KEY);

      return jsonRes({ message: 'If that email exists, a reset link has been sent.' });
    }

    if (url.pathname === '/reset-password' && request.method === 'POST') {
      const { token, password } = await request.json();
      if (!password || password.length < 8) return jsonRes({ error: 'Password must be at least 8 characters' }, 400);

      const row = await env.DB.prepare(
        'SELECT * FROM tokens WHERE token = ? AND type = ? AND used = 0'
      ).bind(token, 'reset').first();

      if (!row) return jsonRes({ error: 'Invalid or expired reset link' }, 400);
      if (new Date(row.expires_at) < new Date()) return jsonRes({ error: 'Reset link has expired. Request a new one.' }, 400);

      const hash = await hashPassword(password);
      await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, row.user_id).run();
      await env.DB.prepare('UPDATE tokens SET used = 1 WHERE token = ?').bind(token).run();

      return jsonRes({ message: 'Password reset successfully. You can now log in.' });
    }

    if (url.pathname === '/paypal/config' && request.method === 'GET') {
      return jsonRes({
        clientId: PAYPAL_CLIENT_ID,
        plans: { seeker: PLAN_SEEKER, campaigner: PLAN_CAMPAIGNER }
      });
    }

    if (url.pathname === '/paypal/webhook' && request.method === 'POST') {
      const body = await request.json();
      const eventType = body.event_type || '';
      const resource = body.resource || {};
      const subscriptionId = resource.id || resource.billing_agreement_id || '';
      const payerEmail = (resource.subscriber && resource.subscriber.email_address) ? resource.subscriber.email_address.toLowerCase() : '';
      if (!subscriptionId) return jsonRes({ received: true });
      try {
        const ppToken = await getPayPalToken(env);
        const sub = await getSubscription(subscriptionId, ppToken);
        const confirmedPlanId = sub.plan_id || '';
        const confirmedEmail = payerEmail || (sub.subscriber && sub.subscriber.email_address ? sub.subscriber.email_address.toLowerCase() : '');
        const newPlan = planIdToPlan(confirmedPlanId);
        if (confirmedEmail) {
          if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED' || eventType === 'BILLING.SUBSCRIPTION.UPDATED' || eventType === 'PAYMENT.SALE.COMPLETED') {
            await env.DB.prepare("UPDATE users SET plan = ?, paypal_subscription_id = ?, source = 'paypal' WHERE email = ?").bind(newPlan, subscriptionId, confirmedEmail).run();
          } else if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.EXPIRED' || eventType === 'BILLING.SUBSCRIPTION.SUSPENDED') {
            await env.DB.prepare("UPDATE users SET plan = 'free', paypal_subscription_id = '' WHERE email = ?").bind(confirmedEmail).run();
          }
        }
      } catch(e) { console.error('Webhook error:', e.message); }
      return jsonRes({ received: true });
    }

    if (url.pathname === '/paypal/verify' && request.method === 'POST') {
      const user = await getUserFromRequest(request, env);
      if (!user) return jsonRes({ error: 'Not authenticated' }, 401);
      const { subscriptionId } = await request.json();
      if (!subscriptionId) return jsonRes({ error: 'Subscription ID required' }, 400);
      try {
        const ppToken = await getPayPalToken(env);
        const sub = await getSubscription(subscriptionId, ppToken);
        if (sub.status !== 'ACTIVE') return jsonRes({ error: 'Subscription not active' }, 400);
        const newPlan = planIdToPlan(sub.plan_id);
        await env.DB.prepare("UPDATE users SET plan = ?, paypal_subscription_id = ?, source = 'paypal' WHERE id = ?").bind(newPlan, subscriptionId, user.id).run();
        return jsonRes({ success: true, plan: newPlan });
      } catch(e) { return jsonRes({ error: 'Could not verify: ' + e.message }, 500); }
    }

    if (url.pathname === '/save/email' && request.method === 'POST') {
      const user = await getUserFromRequest(request, env);
      if (!user) return jsonRes({ error: 'Not authenticated' }, 401);
      if (user.plan === 'free' && !ADMIN_EMAILS.includes(user.email)) {
        return jsonRes({ error: 'Email to self is available on Seeker and Campaigner plans.' }, 403);
      }
      const { subject, body } = await request.json();
      if (!subject || !body) return jsonRes({ error: 'Subject and body required' }, 400);
      const html = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px">'
        + '<h2 style="color:#2b5438;margin-bottom:1rem">' + subject + '</h2>'
        + '<div style="background:#f4f0e8;border-radius:8px;padding:24px;white-space:pre-line;font-size:15px;line-height:1.7;color:#18140f">' + body.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>'
        + '<hr style="border:none;border-top:1px solid #ddd8ce;margin:24px 0">'
        + '<p style="color:#a09890;font-size:12px">Sent from ApplyEdge &mdash; applydge.work</p></div>';
      const sent = await sendEmail(user.email, subject + ' (ApplyEdge)', html, env.RESEND_API_KEY);
      if (!sent) return jsonRes({ error: 'Failed to send email. Please try again.' }, 500);
      return jsonRes({ message: 'Sent to ' + user.email });
    }

    if (url.pathname === '/acarte/create-order' && request.method === 'POST') {
      const user = await getUserFromRequest(request, env);
      if (!user) return jsonRes({ error: 'Please sign in to purchase credits.' }, 401);
      const { type } = await request.json();
      if (!ACARTE_PRICES[type]) return jsonRes({ error: 'Invalid product type.' }, 400);
      try {
        const ppToken = await getPayPalToken(env);
        const order = await createPayPalOrder(type, ppToken);
        return jsonRes({ orderId: order.id, status: order.status });
      } catch(e) { return jsonRes({ error: 'Could not create order: ' + e.message }, 500); }
    }

    if (url.pathname === '/acarte/capture-order' && request.method === 'POST') {
      const user = await getUserFromRequest(request, env);
      if (!user) return jsonRes({ error: 'Not authenticated' }, 401);
      const { orderId, type } = await request.json();
      if (!orderId || !ACARTE_CREDITS[type]) return jsonRes({ error: 'Invalid request.' }, 400);
      try {
        const ppToken = await getPayPalToken(env);
        const capture = await capturePayPalOrder(orderId, ppToken);
        if (capture.status !== 'COMPLETED') return jsonRes({ error: 'Payment not completed.' }, 400);
        const credits = ACARTE_CREDITS[type];
        await env.DB.prepare(
          "UPDATE users SET credits_scans = credits_scans + ?, credits_covers = credits_covers + ?, credits_signals = credits_signals + ? WHERE id = ?"
        ).bind(credits.scans, credits.covers, credits.signals, user.id).run();
        return jsonRes({ success: true, credits_added: credits });
      } catch(e) { return jsonRes({ error: 'Could not capture payment: ' + e.message }, 500); }
    }

    if (url.pathname === '/history' && request.method === 'GET') {
      const user = await getUserFromRequest(request, env);
      if (!user) return jsonRes({ error: 'Not authenticated' }, 401);
      if (user.plan === 'free' && !ADMIN_EMAILS.includes(user.email)) return jsonRes({ error: 'History is available on Seeker and Campaigner plans.' }, 403);
      const rows = await env.DB.prepare(
        'SELECT id, tool_type, title, output, created_at FROM scan_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
      ).bind(user.id).all();
      return jsonRes({ history: rows.results });
    }

    if (url.pathname === '/job-match' && request.method === 'POST') {
      const user = await getUserFromRequest(request, env);
      if (!user) return jsonRes({ error: 'Not authenticated' }, 401);

      const isPaid = user.plan === 'seeker' || user.plan === 'campaigner' || ADMIN_EMAILS.includes(user.email);

      if (!ADMIN_EMAILS.includes(user.email)) {
        if (user.plan === 'campaigner') {
          if (isNewJobMatchPeriod(user)) {
            const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
            await env.DB.prepare('UPDATE users SET jobmatch_used = 0, jobmatch_reset_date = ? WHERE id = ?').bind(firstOfMonth, user.id).run();
            user.jobmatch_used = 0;
          }
          if ((user.jobmatch_used || 0) >= MONTHLY_LIMIT_CAMPAIGNER_JOBMATCH) {
            return jsonRes({ error: { message: 'Monthly Job Match limit reached (40 searches). Resets on the 1st of next month.', type: 'rate_limit' } }, 429);
          }
          await env.DB.prepare('UPDATE users SET jobmatch_used = jobmatch_used + 1 WHERE id = ?').bind(user.id).run();
        } else {
        const limit = getPlanLimit(user.plan);
        if (isNewPeriod(user)) {
          const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
          await env.DB.prepare('UPDATE users SET scans_used = 0, scans_reset_date = ? WHERE id = ?').bind(firstOfMonth, user.id).run();
          user.scans_used = 0;
        }
        if (user.scans_used >= limit) {
          if ((user.credits_scans || 0) > 0) {
            await env.DB.prepare('UPDATE users SET credits_scans = credits_scans - 1 WHERE id = ?').bind(user.id).run();
          } else {
            const planMsg = user.plan === 'free'
              ? 'Free plan limit reached (3 scans/month). Upgrade to Seeker for 10 scans/month, or buy credits.'
              : 'Monthly scan limit reached. Upgrade to Campaigner for 200 scans/month, or buy credits.';
            return jsonRes({ error: { message: planMsg, type: 'rate_limit' } }, 429);
          }
        } else {
          await env.DB.prepare('UPDATE users SET scans_used = scans_used + 1 WHERE id = ?').bind(user.id).run();
        }
        }
      }

      const body = await request.json();
      const keywords = (body.keywords || '').trim();
      const location = (body.location || 'Singapore').trim();
      if (!keywords) return jsonRes({ error: 'Keywords required' }, 400);

      const tier = isPaid ? 'paid' : 'free';
      const cacheKey = keywords.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() + '|' + location.toLowerCase() + '|' + tier;

      const cached = await env.DB.prepare(
        "SELECT results, created_at FROM job_match_cache WHERE query_key = ? AND created_at > datetime('now', '-1 day')"
      ).bind(cacheKey).first();

      if (cached) {
        return jsonRes({ jobs: JSON.parse(cached.results), source: 'cache', tier });
      }

      let jobs = [];

      try {
        const joobleRes = await fetch('https://jooble.org/api/' + env.JOOBLE_API_KEY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keywords, location })
        });
        const joobleData = await joobleRes.json();
        if (joobleData.jobs) {
          jobs = jobs.concat(joobleData.jobs.slice(0, 15).map(j => ({
            title: j.title, company: j.company, location: j.location,
            snippet: j.snippet, link: j.link, source: 'Jooble', salary: j.salary || ''
          })));
        }
      } catch (e) {}

      if (isPaid) {
        try {
          const glRes = await fetch('https://api.apify.com/v2/acts/truefetch~glints-job-listing/run-sync-get-dataset-items?token=' + env.APIFY_TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyword: keywords, country: location, max_results: 15 })
          });
          const glData = await glRes.json();
          if (Array.isArray(glData)) {
            jobs = jobs.concat(glData.slice(0, 15).map(j => ({
              title: j.title, company: j.company_name,
              location: (j.location && j.location.raw) || location, snippet: j.description || '',
              link: j.platform_url, source: 'Glints',
              salary: j.salary_minimum ? (j.salary_currency + ' ' + j.salary_minimum + '-' + j.salary_maximum) : ''
            })));
          }
        } catch (e) {}
      }

      const seen = new Set();
      jobs = jobs.filter(j => {
        const k = (j.title || '').toLowerCase() + '|' + (j.company || '').toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      await env.DB.prepare(
        'INSERT OR REPLACE INTO job_match_cache (query_key, results, source, created_at) VALUES (?, ?, ?, datetime(\'now\'))'
      ).bind(cacheKey, JSON.stringify(jobs), tier).run();

      return jsonRes({ jobs, source: 'live', tier });
    }

    if (url.pathname === '/signal-gate' && request.method === 'POST') {
      const adminToken = request.headers.get('X-Admin-Token') || '';
      const isAdmin = env.ADMIN_TOKEN && adminToken === env.ADMIN_TOKEN;
      if (isAdmin) return jsonRes({ blocked: false, reason: 'admin' });

      const user = await getUserFromRequest(request, env);
      if (user && ADMIN_EMAILS.includes(user.email)) return jsonRes({ blocked: false, reason: 'admin-email' });

      if (user) {
        if (user.plan === 'campaigner') {
          if (isNewPeriod(user)) {
            const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
            await env.DB.prepare('UPDATE users SET scans_used = 0, scans_reset_date = ? WHERE id = ?').bind(firstOfMonth, user.id).run();
            user.scans_used = 0;
          }
          if (user.scans_used >= MONTHLY_LIMIT_CAMPAIGNER) {
            return jsonRes({ blocked: true, reason: 'Campaigner plan: 200 scans/month reached. Resets on the 1st.' });
          }
          return jsonRes({ blocked: false });
        }
        if (user.plan === 'seeker') {
          const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
          const signalCount = user.signal_count || 0;
          const signalReset = user.signal_reset_date || '';
          if (!signalReset || signalReset < firstOfMonth) {
            await env.DB.prepare('UPDATE users SET signal_count = 0, signal_reset_date = ? WHERE id = ?')
              .bind(new Date().toISOString().slice(0, 10), user.id).run();
            return jsonRes({ blocked: false });
          }
          if (signalCount >= 5) return jsonRes({ blocked: true, reason: 'Seeker plan: 5 Signals/month reached. Upgrade to Campaigner for unlimited.' });
          return jsonRes({ blocked: false });
        }
        if (user.signal_used) {
          if ((user.credits_signals || 0) > 0) {
            await env.DB.prepare('UPDATE users SET credits_signals = credits_signals - 1 WHERE id = ?').bind(user.id).run();
            return jsonRes({ blocked: false, used_credit: true });
          }
          return jsonRes({ blocked: true, reason: 'Free Signal used. Upgrade to Seeker for 5/month, or buy credits.' });
        }
        return jsonRes({ blocked: false });
      } else {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const kvKey = 'signal:' + ip;
        const used = await env.LIMITS.get(kvKey);
        if (used) return jsonRes({ blocked: true, reason: 'Free Signal used. Create an account or upgrade to generate more.' });
        return jsonRes({ blocked: false });
      }
    }

    function requireAdmin(request, env) {
      const token = request.headers.get('X-Admin-Token') || '';
      return env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
    }

    if (url.pathname === '/admin/stats' && request.method === 'GET') {
      if (!requireAdmin(request, env)) return jsonRes({ error: 'Unauthorized' }, 401);
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const [total, verified, newToday, newWeek, unverifiedOld] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as n FROM users').first(),
        env.DB.prepare('SELECT COUNT(*) as n FROM users WHERE verified = 1').first(),
        env.DB.prepare('SELECT COUNT(*) as n FROM users WHERE created_at LIKE ?').bind(today + '%').first(),
        env.DB.prepare('SELECT COUNT(*) as n FROM users WHERE created_at >= ?').bind(weekAgo).first(),
        env.DB.prepare("SELECT COUNT(*) as n FROM users WHERE verified = 0 AND created_at < ?").bind(sevenDaysAgo).first(),
      ]);
      return jsonRes({
        total: total.n, verified: verified.n, new_today: newToday.n,
        new_week: newWeek.n, unverified_old: unverifiedOld.n
      });
    }

    if (url.pathname === '/admin/users' && request.method === 'GET') {
      if (!requireAdmin(request, env)) return jsonRes({ error: 'Unauthorized' }, 401);
      const users = await env.DB.prepare(
        'SELECT id, email, plan, verified, scans_used, scans_reset_date, signal_used, signal_count, created_at FROM users ORDER BY created_at DESC'
      ).all();
      return jsonRes({ users: users.results });
    }

    if (url.pathname === '/admin/reset-quota' && request.method === 'POST') {
      if (!requireAdmin(request, env)) return jsonRes({ error: 'Unauthorized' }, 401);
      const { email, type } = await request.json();
      if (!email) return jsonRes({ error: 'Email required' }, 400);
      const em = email.toLowerCase();
      if (type === 'signal') {
        await env.DB.prepare("UPDATE users SET signal_used = 0, signal_count = 0, signal_reset_date = '' WHERE email = ?").bind(em).run();
      } else if (type === 'scans') {
        await env.DB.prepare("UPDATE users SET scans_used = 0, scans_reset_date = '' WHERE email = ?").bind(em).run();
      } else {
        await env.DB.prepare("UPDATE users SET scans_used = 0, scans_reset_date = '', signal_used = 0, signal_count = 0, signal_reset_date = '' WHERE email = ?").bind(em).run();
      }
      return jsonRes({ message: 'Quota reset for ' + email });
    }

    if (url.pathname === '/admin/change-plan' && request.method === 'POST') {
      if (!requireAdmin(request, env)) return jsonRes({ error: 'Unauthorized' }, 401);
      const { email, plan } = await request.json();
      if (!email || !plan) return jsonRes({ error: 'Email and plan required' }, 400);
      if (!['free','seeker','campaigner'].includes(plan)) return jsonRes({ error: 'Invalid plan' }, 400);
      await env.DB.prepare('UPDATE users SET plan = ? WHERE email = ?').bind(plan, email.toLowerCase()).run();
      return jsonRes({ message: 'Plan updated to ' + plan + ' for ' + email });
    }

    if (url.pathname === '/admin/delete-user' && request.method === 'POST') {
      if (!requireAdmin(request, env)) return jsonRes({ error: 'Unauthorized' }, 401);
      const body3 = await request.json();
      const delEmail = (body3.email || '').toLowerCase();
      const cancelSub = body3.cancel_subscription || false;
      if (!delEmail) return jsonRes({ error: 'Email required' }, 400);
      if (ADMIN_EMAILS.includes(delEmail)) return jsonRes({ error: 'Cannot delete admin account' }, 403);
      const delUser = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(delEmail).first();
      if (!delUser) return jsonRes({ error: 'User not found' }, 404);
      if (cancelSub && delUser.paypal_subscription_id) {
        try {
          const ppTok = await getPayPalToken(env);
          await fetch(PAYPAL_API + '/v1/billing/subscriptions/' + delUser.paypal_subscription_id + '/cancel', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + ppTok, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'Cancelled by admin' })
          });
        } catch(e) { console.error('PayPal cancel error:', e.message); }
      }
      await env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(delUser.id).run();
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(delUser.id).run();
      const cancelNote = (cancelSub && delUser.paypal_subscription_id) ? ' PayPal subscription cancelled.' : '';
      return jsonRes({ message: 'User ' + delEmail + ' deleted.' + cancelNote, had_subscription: !!(delUser.paypal_subscription_id) });
    }

    if (url.pathname === '/admin/add-user' && request.method === 'POST') {
      if (!requireAdmin(request, env)) return jsonRes({ error: 'Unauthorized' }, 401);
      const body4 = await request.json();
      const newEmail = (body4.email || '').toLowerCase();
      const newPlan = ['free','seeker','campaigner'].includes(body4.plan) ? body4.plan : 'free';
      if (!newEmail) return jsonRes({ error: 'Email required' }, 400);
      const existU = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(newEmail).first();
      if (existU) return jsonRes({ error: 'User already exists' }, 409);
      const newId = generateId();
      const tempHash = await hashPassword(generateToken(8));
      await env.DB.prepare("INSERT INTO users (id, email, password_hash, verified, plan, source) VALUES (?, ?, ?, 1, ?, 'manual')").bind(newId, newEmail, tempHash, newPlan).run();
      const rstTok = generateToken();
      const rstExp = new Date(Date.now() + 86400000).toISOString();
      await env.DB.prepare('INSERT INTO tokens (token, user_id, type, expires_at) VALUES (?, ?, ?, ?)').bind(rstTok, newId, 'reset', rstExp).run();
      const rstLink = APP_URL + '/?reset=' + rstTok;
      const wHtml = '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px"><h2 style="color:#2b5438">Your ApplyEdge account is ready</h2><p style="color:#6e6659;line-height:1.6">An account has been created for you with the <strong>' + newPlan + '</strong> plan.</p><a href="' + rstLink + '" style="display:inline-block;margin:24px 0;background:#2b5438;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Set your password</a><p style="color:#a09890;font-size:13px">Link expires in 24 hours.</p><hr style="border:none;border-top:1px solid #ddd8ce;margin:24px 0"><p style="color:#a09890;font-size:12px">applydge.work</p></div>';
      await sendEmail(newEmail, 'Your ApplyEdge account is ready', wHtml, env.RESEND_API_KEY);
      return jsonRes({ message: 'User ' + newEmail + ' created with ' + newPlan + ' plan. Setup email sent.' });
    }

    if (url.pathname === '/admin/cleanup' && request.method === 'POST') {
      if (!requireAdmin(request, env)) return jsonRes({ error: 'Unauthorized' }, 401);
      const cutoff = new Date(Date.now() - 7*86400000).toISOString();
      const old_users = await env.DB.prepare('SELECT id FROM users WHERE verified = 0 AND created_at < ?').bind(cutoff).all();
      let deleted = 0;
      for (const u of old_users.results) {
        await env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(u.id).run();
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run();
        deleted++;
      }
      return jsonRes({ message: deleted + ' unverified users cleaned up' });
    }

    if (url.pathname === '/fetch-jd' && request.method === 'POST') {
      const body = await request.json();
      const jinaUrl = 'https://r.jina.ai/' + body.url;
      const res = await fetch(jinaUrl, {
        headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' }
      });
      if (!res.ok) return jsonRes({ error: 'Could not fetch URL' }, 502);
      const text = await res.text();
      return jsonRes({ text: text.slice(0, 4000) });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const adminToken = request.headers.get('X-Admin-Token') || '';
    const isAdmin = env.ADMIN_TOKEN && adminToken === env.ADMIN_TOKEN;

    const user = await getUserFromRequest(request, env);

    const isAdminEmail = user && ADMIN_EMAILS.includes(user.email);

    const isSignalCall = request.headers.get('X-Signal-Call') === '1';

    let scansRemaining = null;

    if (!isAdmin && !isAdminEmail && !isSignalCall) {
      if (user) {
        const limit = getPlanLimit(user.plan);

        if (limit !== Infinity) {
          if (isNewPeriod(user)) {
            const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
            await env.DB.prepare(
              'UPDATE users SET scans_used = 0, scans_reset_date = ? WHERE id = ?'
            ).bind(firstOfMonth, user.id).run();
            user.scans_used = 0;
          }

          if (user.scans_used >= limit) {
            if ((user.credits_scans || 0) > 0) {
              await env.DB.prepare('UPDATE users SET credits_scans = credits_scans - 1 WHERE id = ?').bind(user.id).run();
              scansRemaining = null;
            } else {
              const planMsg = user.plan === 'free'
                ? 'Free plan limit reached (3 scans/month). Upgrade to Seeker for 10 scans/month, or buy credits.'
                : 'Monthly scan limit reached. You have reached your Campaigner plan limit of 200 scans this month. It resets on the 1st, or buy credits for an immediate top-up.';
              return jsonRes({ error: { message: planMsg, type: 'rate_limit' } }, 429);
            }
          }

          await env.DB.prepare(
            'UPDATE users SET scans_used = scans_used + 1 WHERE id = ?'
          ).bind(user.id).run();
          scansRemaining = limit - (user.scans_used + 1);
        }
      } else {
        return jsonRes({
          error: {
            message: 'Please create a free account to use ApplyEdge. Sign up takes 30 seconds.',
            type: 'auth_required',
            code: 'login_required'
          }
        }, 401);
      }
    }
    if (isSignalCall && !isAdmin) {
      if (user) {
        if (user.plan === 'free') {
          await env.DB.prepare('UPDATE users SET signal_used = 1 WHERE id = ?').bind(user.id).run();
        } else if (user.plan === 'seeker') {
          await env.DB.prepare('UPDATE users SET signal_count = signal_count + 1 WHERE id = ?').bind(user.id).run();
        } else if (user.plan === 'campaigner') {
          await env.DB.prepare('UPDATE users SET scans_used = scans_used + 1 WHERE id = ?').bind(user.id).run();
        }
      } else {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        await env.LIMITS.put('signal:' + ip, '1', { expirationTtl: 7776000 });
      }
    }

    const aiBody = await request.json();
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OR_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': APP_URL,
        'X-Title': 'ApplyEdge'
      },
      body: JSON.stringify(aiBody)
    });

    const data = await response.json();

    // Save to history for Seeker+ users
    if (data.choices && user && (user.plan === 'seeker' || user.plan === 'campaigner' || ADMIN_EMAILS.includes(user.email))) {
      const toolType = request.headers.get('X-Tool-Type') || 'scan';
      const output = data.choices[0].message.content || '';
      const title = output.slice(0, 80).replace(/[\n\r]+/g, ' ').trim();
      const hid = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO scan_history (id, user_id, tool_type, title, output, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
      ).bind(hid, user.id, toolType, title, output).run();
    }

    if (data.choices && scansRemaining !== null && scansRemaining <= 1) {
      data._applyedge = {
        scans_remaining: scansRemaining,
        message: scansRemaining === 0
          ? 'You have used all your scans. Upgrade for more.'
          : `${scansRemaining} scan remaining.`
      };
    }

    return jsonRes(data);
  }
};
