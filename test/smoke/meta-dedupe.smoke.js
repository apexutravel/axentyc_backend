const crypto = require('crypto');
const { run } = require('./harness');

// A customer message must be stored once, however many times Meta (or our own safety net) delivers it.
run(
  'META WEBHOOK: the same Instagram / Messenger message is stored exactly once',
  async ({ ok, db, ids, BASE, sleep }) => {
    const secret = process.env.FACEBOOK_APP_SECRET;
    if (!secret)
      return ok(false, 'FACEBOOK_APP_SECRET is needed to sign webhooks');
    const { tenantId, wsId } = ids;
    await db.collection('socialaccounts').insertMany([
      {
        tenantId,
        workspaceId: wsId,
        platform: 'facebook',
        accountName: 'Pagina Smoke',
        pageId: 'page-smoke-1',
        accessToken: 'fake-token',
        status: 'connected',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        tenantId,
        workspaceId: wsId,
        platform: 'instagram',
        accountName: 'tienda_smoke',
        accountId: 'ig-smoke-1',
        pageId: 'page-smoke-1',
        accessToken: 'fake-token',
        status: 'connected',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const post = async (body) => {
      const raw = JSON.stringify(body);
      const sig =
        'sha256=' +
        crypto.createHmac('sha256', secret).update(raw).digest('hex');
      const res = await fetch(`${BASE}/webhook/facebook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': sig,
        },
        body: raw,
      });
      return res.status;
    };
    const count = (mid) =>
      db
        .collection('messages')
        .countDocuments({ tenantId, 'metadata.externalId': mid });
    const waitFor = async (mid, min = 1) => {
      for (let i = 0; i < 40; i++) {
        if ((await count(mid)) >= min) break;
        await sleep(250);
      }
      await sleep(2500);
    };

    const igEvent = (mid, text, ts = Date.now()) => ({
      sender: { id: 'cust-1' },
      recipient: { id: 'ig-smoke-1' },
      timestamp: ts,
      message: { mid, text },
    });
    const igBody = (ev) => ({
      object: 'instagram',
      entry: [{ id: 'ig-smoke-1', time: Date.now(), messaging: [ev] }],
    });
    const pageBody = (ev) => ({
      object: 'page',
      entry: [{ id: 'page-smoke-1', time: Date.now(), messaging: [ev] }],
    });

    // 1) Meta retries / delivers twice at the same moment
    const e1 = igEvent('mid-A', 'ok');
    const statuses = await Promise.all([post(igBody(e1)), post(igBody(e1))]);
    ok(
      statuses.every((s) => s === 200),
      'webhook answers 200 to both deliveries',
      statuses,
    );
    await waitFor('mid-A');
    ok(
      (await count('mid-A')) === 1,
      'same message delivered twice at once -> stored once',
      await count('mid-A'),
    );

    // 2) Same message arriving through BOTH webhook objects (instagram + page), the situation after enabling the app webhook
    // This is a genuinely different message with the same text. It must not be merged with A.
    const e2 = igEvent('mid-B', 'ok', Date.now() + 10000);
    await Promise.all([post(igBody(e2)), post(pageBody(e2))]);
    await waitFor('mid-B');
    ok(
      (await count('mid-B')) === 1,
      'same message through the instagram AND page webhook -> stored once',
      await count('mid-B'),
    );

    // 3) Sequential redelivery later
    await post(igBody(e2));
    await sleep(2500);
    ok(
      (await count('mid-B')) === 1,
      'redelivery after it was stored is ignored',
      await count('mid-B'),
    );

    // 4) Distinct ids are kept even when the customer repeats the exact text
    ok(
      (await count('mid-A')) === 1 && (await count('mid-B')) === 1,
      'two different messages with the same text are both kept',
    );

    // 5) What the customer sees: one conversation, one unread count per real message
    const convs = await db
      .collection('conversations')
      .find({
        tenantId,
        channel: 'instagram',
        'metadata.isComment': { $ne: true },
      })
      .toArray();
    ok(
      convs.length === 1,
      'a single conversation for the customer',
      convs.length,
    );
    const inbound = await db
      .collection('messages')
      .countDocuments({ tenantId, direction: 'inbound' });
    ok(inbound === 2, 'exactly 2 inbound messages in total (A and B)', inbound);
    ok(
      convs[0] && convs[0].unreadCount === 2,
      'unread counter matches the real messages',
      convs[0] && convs[0].unreadCount,
    );
  },
);
