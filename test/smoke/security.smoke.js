const { createHmac, createHash } = require('crypto');
const { run } = require('./harness');

run('SECURITY / PASSWORD RECOVERY / DATA DELETION', async ({ ok, call, db, ids: { tenantId, userId }, mark, BASE, jwt, token, sleep }) => {
  const post = (path, body, headers = {}) =>
    fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  console.log('HEADERS');
  const plans = await fetch(BASE + '/billing/plans');
  ok(plans.headers.get('x-content-type-options') === 'nosniff', 'helmet: x-content-type-options');
  ok(!plans.headers.get('x-powered-by'), 'helmet: no x-powered-by');

  console.log('PASSWORD RECOVERY');
  let r = await post('/auth/forgot-password', { email: 'nobody-' + mark + '@nowhere.io' });
  ok(r.status === 200, 'unknown e-mail answers 200 (no account enumeration)', r.status);
  r = await post('/auth/forgot-password', { email: 'not-an-email' });
  ok(r.status === 400, 'invalid e-mail rejected', r.status);
  r = await post('/auth/reset-password', { token: 'f'.repeat(64), password: 'newpass123' });
  ok(r.status === 400, 'unknown token rejected', r.status);
  r = await post('/auth/reset-password', { token: 'x', password: '123' });
  ok(r.status === 400, 'short password rejected', r.status);

  // a valid reset: insert a known token for the test user
  const reset = 'a'.repeat(64);
  await db.collection('passwordresets').insertOne({ userId, tokenHash: createHash('sha256').update(reset).digest('hex'), expiresAt: new Date(Date.now() + 3600e3), createdAt: new Date() });
  await sleep(1100); // sessions are compared with 1s granularity
  const before = await call('GET', '/contacts');
  ok(before.status === 200, 'session works before the reset');
  r = await post('/auth/reset-password', { token: reset, password: 'BrandNew#123' });
  ok(r.status === 200, 'valid token resets the password', r.status);
  r = await post('/auth/reset-password', { token: reset, password: 'Another#123' });
  ok(r.status === 400, 'the same link cannot be used twice', r.status);
  const stale = await call('GET', '/contacts');
  ok(stale.status === 401, 'sessions opened before the reset are revoked', stale.status);
  r = await post('/auth/login', { email: mark + '@t.io', password: 'BrandNew#123' });
  ok(r.status === 200, 'login works with the new password', r.status);
  r = await post('/auth/login', { email: mark + '@t.io', password: 'x' });
  ok(r.status === 401, 'old password no longer works', r.status);

  console.log('RATE LIMITING');
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await post('/auth/login', { email: 'rl@x.io', password: 'bad' })).status);
  ok(codes.includes(429), 'login is rate limited (429 after repeated attempts)', codes);
  ok(codes[0] === 401, 'first attempts are still evaluated normally', codes[0]);

  console.log('META DATA DELETION CALLBACK');
  const secret = process.env.FACEBOOK_APP_SECRET;
  const b64 = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signed = (payload, s = secret) => {
    const p = b64(JSON.stringify(payload));
    return `${b64(createHmac('sha256', s).update(p).digest())}.${p}`;
  };
  const fbUser = 'fbuser_' + Date.now();
  const acc = await db.collection('socialaccounts').insertOne({ tenantId, platform: 'facebook', accountName: 'Smoke Page', pageId: 'p_' + mark, accessToken: 'tok', status: 'connected', isActive: true, metadata: { fbUserId: fbUser } });
  const form = (sr) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'signed_request=' + encodeURIComponent(sr) });
  let res = await fetch(BASE + '/webhook/facebook/data-deletion', form(signed({ algorithm: 'HMAC-SHA256', user_id: fbUser }, 'wrong-secret')));
  ok(res.status === 400, 'forged signed_request rejected', res.status);
  ok((await db.collection('socialaccounts').findOne({ _id: acc.insertedId })).accessToken === 'tok', 'forged request touched nothing');
  res = await fetch(BASE + '/webhook/facebook/data-deletion', form(signed({ algorithm: 'HMAC-SHA256', user_id: fbUser })));
  const body = await res.json();
  const out = body.data || body;
  ok(res.status === 200 && out.confirmation_code && /data-deletion\?code=/.test(out.url), 'valid callback returns url + confirmation_code', body);
  const after = await db.collection('socialaccounts').findOne({ _id: acc.insertedId });
  ok(after.status === 'disconnected' && !after.accessToken && after.isActive === false, 'tokens erased and account disconnected', after);
  res = await fetch(BASE + '/webhook/facebook/data-deletion/' + out.confirmation_code);
  const st = await res.json();
  ok((st.data || st).found === true && (st.data || st).status === 'completed', 'status endpoint reports completed');
  res = await fetch(BASE + '/webhook/facebook/data-deletion/' + 'z'.repeat(24));
  ok(((await res.json()).data || {}).found === false, 'unknown code → not found');
  await db.collection('deletionrequests').deleteMany({ fbUserId: fbUser });

  console.log('WEBHOOK SIGNATURE');
  res = await post('/webhook/facebook', { object: 'page', entry: [] });
  ok(res.status === 403, 'unsigned Facebook webhook rejected', res.status);
  res = await post('/billing/webhook/stripe', { id: 'evt', type: 'x' }, { 'stripe-signature': 't=1,v1=bad' });
  ok(res.status === 400, 'bad Stripe signature rejected', res.status);

  console.log('AUTH REQUIRED');
  res = await fetch(BASE + '/contacts?workspaceId=x');
  ok(res.status === 401, 'protected routes need a session', res.status);
});
