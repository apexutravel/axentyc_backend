/**
 * End-to-end smoke harness. Boots the COMPILED app (dist/main) on a spare port against the database in .env,
 * creates a throw-away account + workspace, runs a scenario, then deletes everything it created.
 *
 *   npm run build && npm run test:smoke
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const PORT = process.env.SMOKE_PORT || '3999';
const BASE = `http://localhost:${PORT}/api/v1`;

async function run(title, scenario) {
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg, extra) => {
    if (cond) { pass++; console.log('  ✓', msg); }
    else { fail++; console.log('  ✗', msg, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); }
  };
  const O = (s) => new mongoose.Types.ObjectId(s);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const tenantId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const wsId = new mongoose.Types.ObjectId();
  const mark = 'zz_smoke_' + Date.now();
  await db.collection('tenants').insertOne({ _id: tenantId, name: mark, slug: mark, plan: 'pro', status: 'active', isActive: true, limits: {}, subscription: { planKey: 'pro', status: 'active', complimentary: true, provider: 'manual' }, billingNotices: { legacy_migrated: new Date() } });
  await db.collection('users').insertOne({ _id: userId, email: mark + '@t.io', password: 'x', firstName: 'Smoke', lastName: 'Test', role: 'admin', tenantId, isActive: true });
  await db.collection('accountmembers').insertOne({ tenantId, userId, role: 'owner', status: 'active', joinedAt: new Date() });
  await db.collection('workspaces').insertOne({ _id: wsId, tenantId, name: 'Smoke WS', slug: 'smoke-ws', type: 'default', isActive: true, currency: 'USD', taxSettings: { taxRate: 8.25, taxName: 'Sales tax' }, documentSettings: { invoicePrefix: 'SM', language: 'en' }, businessEmail: 'biz@x.com' });
  await db.collection('workspacemembers').insertOne({ tenantId, workspaceId: wsId, userId, role: 'owner', status: 'active', permissions: ['*'] });

  const token = jwt.sign({ sub: String(userId), email: mark + '@t.io', tenantId: String(tenantId), role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const W = `workspaceId=${wsId}`;
  const call = async (method, p, body, raw) => {
    const sep = p.includes('?') ? '&' : '?';
    const res = await fetch(BASE + p + (method === 'GET' || method === 'DELETE' ? sep + W : ''), {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: 'access_token=' + token },
      body: body ? JSON.stringify({ workspaceId: String(wsId), ...body }) : undefined,
    });
    if (raw) return res;
    const json = await res.json().catch(() => ({}));
    return { status: res.status, data: json.data !== undefined ? json.data : json, json };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const server = spawn('node', ['dist/main'], { cwd: ROOT, env: { ...process.env, PORT }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/billing/plans'); if (r.ok) break; } catch {} await sleep(1000); }

  console.log(title);
  try {
    await scenario({ ok, call, db, O, ids: { tenantId, userId, wsId }, token, mark, sleep, BASE, mongoose, jwt });
  } catch (e) {
    fail++;
    console.log('  ✗ EXCEPTION', e);
  } finally {
    server.kill();
    let removed = 0;
    for (const c of (await db.listCollections().toArray()).map((x) => x.name)) removed += (await db.collection(c).deleteMany({ tenantId })).deletedCount;
    await db.collection('tenants').deleteOne({ _id: tenantId });
    await db.collection('users').deleteOne({ _id: userId });
    await db.collection('workspaces').deleteOne({ _id: wsId });
    console.log(`\ncleanup: removed ${removed} docs`);
    console.log(`RESULT [${title}]: ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exitCode = fail ? 1 : 0;
  }
}

module.exports = { run };
