const { run } = require('./harness');

// Replying from the Contact Center. The web app adds `workspaceId` to every request body (and now to
// the query string); the API used to answer 400 "property workspaceId should not exist" on this route.
run('INBOX: reply to a conversation with the web-app request shape', async ({ ok, call, db, O, ids, BASE, jwt, mark, mongoose }) => {
  let r = await call('POST', '/contacts', { name: 'Cliente IG' });
  const contact = r.data;
  r = await call('POST', '/conversations', { channel: 'web_chat', contactId: contact._id, subject: 'Hola' });
  ok(r.status === 201, 'create conversation', r.json);
  const conv = r.data;

  // The exact shape that used to fail: workspaceId inside the body
  r = await call('POST', `/conversations/${conv._id}/messages`, { content: 'Gracias por escribirnos' });
  ok(r.status === 201 && r.data.content === 'Gracias por escribirnos', 'reply with workspaceId in the body → 201 (was 400)', r.json);

  r = await call('GET', `/conversations/${conv._id}/messages`);
  ok(r.status === 200 && (r.data.messages || r.data).length === 1, 'reply is stored and listed');

  // PATCH must not write the scoping field into the conversation
  r = await call('PATCH', `/conversations/${conv._id}`, { status: 'closed' });
  ok(r.status === 200 && r.data.status === 'closed', 'update with workspaceId in the body → 200', r.json);
  const stored = await db.collection('conversations').findOne({ _id: O(conv._id) });
  ok(stored.workspaceId instanceof mongoose.Types.ObjectId && String(stored.workspaceId) === String(ids.wsId), 'workspaceId stays an ObjectId (not overwritten by the body string)', stored.workspaceId);

  // An agent (not owner/admin) only has the workspace through membership: it must work from the query or the body
  const agentId = new mongoose.Types.ObjectId();
  await db.collection('users').insertOne({ _id: agentId, email: `agent_${mark}@t.io`, password: 'x', firstName: 'Ag', lastName: 'Ent', role: 'agent', tenantId: ids.tenantId, isActive: true });
  await db.collection('accountmembers').insertOne({ tenantId: ids.tenantId, userId: agentId, role: 'agent', status: 'active', joinedAt: new Date() });
  await db.collection('workspacemembers').insertOne({ tenantId: ids.tenantId, workspaceId: ids.wsId, userId: agentId, role: 'agent', status: 'active', permissions: ['*'] });
  const agentToken = jwt.sign({ sub: String(agentId), email: `agent_${mark}@t.io`, tenantId: String(ids.tenantId), role: 'agent' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const asAgent = async (path, body) => {
    const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'access_token=' + agentToken }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const W = String(ids.wsId);
  r = await asAgent(`/conversations/${conv._id}/messages?workspaceId=${W}`, { workspaceId: W, content: 'Soy el agente (web actual)' });
  ok(r.status === 201, 'agent: workspaceId in query + body → 201', r.json);
  r = await asAgent(`/conversations/${conv._id}/messages`, { workspaceId: W, content: 'Soy el agente (cliente antiguo)' });
  ok(r.status === 201, 'agent: workspaceId only in the body → 201 (was 403/400)', r.json);
  r = await asAgent(`/conversations/${conv._id}/messages`, { content: 'sin workspace' });
  ok(r.status === 403, 'agent: no workspace at all is still refused', r.status);
  r = await asAgent(`/conversations/${conv._id}/messages?workspaceId=${W}`, { workspaceId: W, content: 'x', hack: 'no' });
  ok(r.status === 400, 'unknown fields are still rejected', r.status);

  await db.collection('users').deleteOne({ _id: agentId });
});
