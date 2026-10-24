const { run } = require('./harness');

run('WIDGET -> AUTO REPLY (end to end)', async ({ ok, call, db, ids: { tenantId, wsId }, BASE }) => {
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    const widgetId = 'wdg_smoke_' + Date.now();
  await db.collection('widgetconfigs').insertOne({ tenantId, workspaceId: wsId, widgetId, enabled: true, showBranding: false, title: 't' });
  await call('POST', '/automations', { name: 'Bienvenida', trigger: 'message.received', conditions: { keywords: ['precio'] }, actions: [{ type: 'auto_reply', config: { message: 'Hola {{contact.firstName}}, te enviamos precios pronto' } }, { type: 'add_tag', config: { tag: 'interesado' } }] });
  const send = (m) => fetch(BASE + '/chat-widget/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ widgetId, message: m, visitorId: 'v1', visitorName: 'Carlos Ruiz' }) }).then((r) => r.status);
  ok((await send('hola')) === 201, 'visitor message 1 (no keyword)');
  await sleepMs(1000);
  ok((await db.collection('messages').countDocuments({ tenantId, direction: 'outbound' })) === 0, 'no reply without keyword match');
  ok((await send('Cual es el PRECIO?')) === 201, 'visitor message 2 (keyword)');
  await sleepMs(1500);
  const bot = await db.collection('messages').find({ tenantId, direction: 'outbound' }).toArray();
  ok(bot.length === 1 && bot[0].isBot === true && bot[0].content === 'Hola Carlos, te enviamos precios pronto', 'bot reply, personalised, flagged isBot', bot.map((b) => b.content));
  ok(bot[0].senderName === 'Automatización' && !bot[0].senderId, 'no human sender on automated reply');
  ok((await send('precio otra vez')) === 201, 'visitor message 3 (keyword, within cooldown)');
  await sleepMs(1200);
  ok((await db.collection('messages').countDocuments({ tenantId, direction: 'outbound' })) === 1, 'cooldown: no second auto-reply');
  const contact = await db.collection('contacts').findOne({ tenantId });
  ok((contact.tags || []).includes('interesado'), 'tag action ran on first match');
  const runs = await db.collection('automationruns').countDocuments({ tenantId });
  ok(runs === 1, 'exactly one run logged', runs);
  const r = await call('GET', '/chat-widget/config/' + widgetId, null, true);
  const cfg = (await r.json()); const d = cfg.data || cfg;
  ok(d.showBranding === false, 'pro plan may hide branding');
  await db.collection('tenants').updateOne({ _id: tenantId }, { $set: { plan: 'starter', subscription: { planKey: 'starter', status: 'active', complimentary: true, provider: 'manual' } } });
  const r2 = await (await call('GET', '/chat-widget/config/' + widgetId, null, true)).json();
  ok((r2.data || r2).showBranding === true, 'downgrade immediately brings the badge back');

});
