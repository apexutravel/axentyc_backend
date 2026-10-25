import { Types } from 'mongoose';
import { FacebookService } from './facebook.service';

describe('Exactly-once processing of Meta messages', () => {
  const tenantId = new Types.ObjectId().toString();

  /** In-memory stand-in for the claims collection with real unique-key semantics. */
  const claimsStore = () => {
    const docs: any[] = [];
    const dup = () =>
      Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    return {
      docs,
      col: {
        createIndex: jest.fn().mockResolvedValue('ok'),
        insertOne: jest.fn().mockImplementation(async (d: any) => {
          if (
            docs.some(
              (x) =>
                String(x.tenantId) === String(d.tenantId) && x.key === d.key,
            )
          )
            throw dup();
          docs.push({ ...d });
          return {};
        }),
        updateOne: jest.fn().mockImplementation(async (f: any, u: any) => {
          const hit = docs.find(
            (x) =>
              String(x.tenantId) === String(f.tenantId) &&
              x.key === f.key &&
              x.at < f.at.$lt,
          );
          if (!hit) return { modifiedCount: 0 };
          hit.at = u.$set.at;
          return { modifiedCount: 1 };
        }),
        deleteOne: jest.fn().mockImplementation(async (f: any) => {
          const i = docs.findIndex(
            (x) => String(x.tenantId) === String(f.tenantId) && x.key === f.key,
          );
          if (i >= 0) docs.splice(i, 1);
          return {};
        }),
      },
    };
  };

  const build = (messageModelOverrides: any = {}, store = claimsStore()) => {
    const messageModel: any = Object.assign(
      jest.fn(),
      {
        db: { collection: () => store.col },
        exists: jest.fn().mockResolvedValue(null),
      },
      messageModelOverrides,
    );
    const service: any = new FacebookService(
      {} as any,
      {} as any,
      {} as any,
      messageModel,
      {} as any,
      { get: () => undefined } as any,
      {} as any,
      {} as any,
      { emit: jest.fn() } as any,
    );
    return { service, store, messageModel };
  };

  describe('claims', () => {
    it('only the first of many simultaneous deliveries wins', async () => {
      const { service } = build();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          service.claimMetaEvent(tenantId, 'msg:abc'),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('different messages, and the same message id for another account, are independent', async () => {
      const { service } = build();
      expect(await service.claimMetaEvent(tenantId, 'msg:1')).toBe(true);
      expect(await service.claimMetaEvent(tenantId, 'msg:2')).toBe(true);
      expect(
        await service.claimMetaEvent(new Types.ObjectId().toString(), 'msg:1'),
      ).toBe(true);
      expect(await service.claimMetaEvent(tenantId, 'msg:1')).toBe(false);
    });

    it('a failed attempt gives the claim back so the retry or the polling can deliver it', async () => {
      const { service } = build();
      expect(await service.claimMetaEvent(tenantId, 'msg:x')).toBe(true);
      expect(await service.claimMetaEvent(tenantId, 'msg:x')).toBe(false);
      await service.releaseMetaEvent(tenantId, 'msg:x');
      expect(await service.claimMetaEvent(tenantId, 'msg:x')).toBe(true);
    });

    it('a claim that was never completed (crash) can be taken over after it goes stale, not before', async () => {
      const { service, store } = build();
      await service.claimMetaEvent(tenantId, 'msg:y');
      expect(await service.claimMetaEvent(tenantId, 'msg:y', 90_000)).toBe(
        false,
      );
      store.docs[0].at = new Date(Date.now() - 120_000);
      expect(await service.claimMetaEvent(tenantId, 'msg:y', 90_000)).toBe(
        true,
      );
      expect(await service.claimMetaEvent(tenantId, 'msg:y', 90_000)).toBe(
        false,
      ); // the takeover refreshed it
    });

    it('never loses a message if the claim store is down (fails open)', async () => {
      const store = claimsStore();
      store.col.insertOne.mockRejectedValue(new Error('connection lost'));
      const { service } = build({}, store);
      expect(await service.claimMetaEvent(tenantId, 'msg:z')).toBe(true);
    });

    it('creates its indexes once and keeps claims for a week only', async () => {
      const { service, store } = build();
      await service.claimMetaEvent(tenantId, 'msg:1');
      await service.claimMetaEvent(tenantId, 'msg:2');
      expect(store.col.createIndex).toHaveBeenCalledTimes(2);
      expect(store.col.createIndex).toHaveBeenCalledWith(
        { at: 1 },
        { expireAfterSeconds: 7 * 24 * 3600 },
      );
    });
  });

  describe('same message reported under another id', () => {
    const conv = new Types.ObjectId();
    const at = new Date('2026-10-25T00:13:28Z');

    it('webhook looks for a twin stored by polling; polling looks for one stored by the webhook', async () => {
      const { service, messageModel } = build();
      await service.hasTwinInbound(tenantId, conv, 'Hola', at, 'polling');
      await service.hasTwinInbound(tenantId, conv, 'Hola', at, 'webhook');
      const [byPolling, byWebhook] = messageModel.exists.mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(byPolling['metadata.polled']).toBe(true);
      expect(byWebhook['metadata.polled']).toEqual({ $ne: true });
      for (const q of [byPolling, byWebhook]) {
        expect(q).toMatchObject({
          direction: 'inbound',
          type: 'text',
          content: 'Hola',
        });
        expect(q['metadata.sentAt']).toEqual({
          $gte: new Date(at.getTime() - 3000),
          $lte: new Date(at.getTime() + 3000),
        });
      }
    });

    it('never matches without a timestamp or text (cannot prove it is the same message)', async () => {
      const { service, messageModel } = build();
      expect(
        await service.hasTwinInbound(
          tenantId,
          conv,
          'Hola',
          undefined,
          'polling',
        ),
      ).toBe(false);
      expect(
        await service.hasTwinInbound(tenantId, conv, '', at, 'polling'),
      ).toBe(false);
      expect(messageModel.exists).not.toHaveBeenCalled();
    });

    it('reads Meta timestamps in ms, seconds and ISO form, and rejects garbage', () => {
      const { service } = build();
      expect(service.metaDate(1792887208000)?.toISOString()).toBe(
        '2026-10-25T00:13:28.000Z',
      );
      expect(service.metaDate(1792887208)?.toISOString()).toBe(
        '2026-10-25T00:13:28.000Z',
      );
      expect(service.metaDate('2026-10-25T00:13:28+0000')?.toISOString()).toBe(
        '2026-10-25T00:13:28.000Z',
      );
      expect(service.metaDate(undefined)).toBeUndefined();
      expect(service.metaDate('nope')).toBeUndefined();
    });
  });
});

describe('Instagram polling does not duplicate what the webhook already stored', () => {
  const tenantId = new Types.ObjectId().toString();
  const wsId = new Types.ObjectId();
  const fbAccount: any = { pageId: 'page-1', accessToken: 'tok' };
  const igAccount: any = {
    accountId: 'ig-1',
    accountName: 'tienda',
    workspaceId: wsId,
  };
  const conversation: any = {
    _id: new Types.ObjectId(),
    workspaceId: wsId,
    metadata: { externalId: 'cust-1', conversationId: 'graph-conv' },
    save: jest.fn(),
  };

  const build = (o: {
    storedIds?: string[];
    claimed?: boolean;
    twin?: boolean;
  }) => {
    const saved: any[] = [];
    const messageModel: any = jest.fn().mockImplementation((doc) => ({
      save: jest.fn().mockImplementation(async () => {
        const m = { _id: new Types.ObjectId(), ...doc, toObject: () => doc };
        saved.push(doc);
        return m;
      }),
    }));
    messageModel.exists = jest.fn().mockImplementation(async (q: any) => {
      if (q['metadata.externalId'])
        return (o.storedIds || []).includes(q['metadata.externalId'])
          ? { _id: 1 }
          : null;
      return o.twin ? { _id: 1 } : null; // the twin lookup
    });
    messageModel.findOne = jest.fn().mockResolvedValue(null);
    const socialAccountModel: any = {
      find: jest.fn().mockReturnValue({ exec: async () => [fbAccount] }),
      findOne: jest.fn().mockResolvedValue(igAccount),
    };
    const conversationModel: any = {
      findOne: jest.fn().mockResolvedValue(conversation),
      updateOne: jest.fn(),
      findByIdAndUpdate: jest
        .fn()
        .mockReturnValue({ populate: () => ({ lean: async () => ({}) }) }),
    };
    const eventsGateway: any = {
      isConversationBeingViewed: () => false,
      emitMessageReceived: jest.fn(),
      emitConversationUpdated: jest.fn(),
      emitToConversation: jest.fn(),
    };
    const bus: any = { emit: jest.fn() };
    const service: any = new FacebookService(
      socialAccountModel,
      { updateOne: jest.fn() } as any,
      conversationModel,
      messageModel,
      {} as any,
      { get: () => undefined } as any,
      eventsGateway,
      {} as any,
      bus,
    );
    service.getOrCreateContact = jest
      .fn()
      .mockResolvedValue({
        _id: new Types.ObjectId(),
        name: 'Rosa',
        customFields: { instagramPsid: 'cust-1' },
      });
    service.claimMetaEvent = jest.fn().mockResolvedValue(o.claimed !== false);
    service.releaseMetaEvent = jest.fn();
    (global as any).fetch = jest.fn().mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('/conversations?'))
        return {
          json: async () => ({
            data: [
              {
                id: 'graph-conv',
                updated_time: '2026-10-25T00:13:30+0000',
                participants: { data: [{ id: 'ig-1' }, { id: 'cust-1' }] },
              },
            ],
          }),
        };
      if (u.includes('/graph-conv/messages'))
        return { json: async () => ({ data: [{ id: 'm-1' }] }) };
      if (u.includes('/m-1?'))
        return {
          json: async () => ({
            from: { id: 'cust-1' },
            created_time: '2026-10-25T00:13:28+0000',
            message: 'Hola',
          }),
        };
      return { json: async () => ({}) };
    });
    return { service, saved, eventsGateway, bus };
  };
  afterEach(() => jest.restoreAllMocks());

  it('stores a new message once and notifies like a webhook would', async () => {
    const { service, saved, eventsGateway, bus } = build({});
    const r = await service.syncInstagramMessages(tenantId);
    expect(r.newMessages).toBe(1);
    expect(saved[0].metadata).toMatchObject({
      externalId: 'm-1',
      polled: true,
    });
    expect(saved[0].metadata.sentAt).toEqual(new Date('2026-10-25T00:13:28Z'));
    expect(eventsGateway.emitMessageReceived).toHaveBeenCalledTimes(1);
    expect(bus.emit).toHaveBeenCalledTimes(1);
  });

  it('skips it when the webhook already stored it under the same id', async () => {
    const { service, saved } = build({ storedIds: ['m-1'] });
    expect((await service.syncInstagramMessages(tenantId)).newMessages).toBe(0);
    expect(saved).toHaveLength(0);
  });

  it('skips it when the webhook is handling it right now (claim not available)', async () => {
    const { service, saved, eventsGateway } = build({ claimed: false });
    expect((await service.syncInstagramMessages(tenantId)).newMessages).toBe(0);
    expect(saved).toHaveLength(0);
    expect(eventsGateway.emitMessageReceived).not.toHaveBeenCalled();
  });

  it('skips it when the webhook stored the same text in the same second under a different id', async () => {
    const { service, saved, eventsGateway, bus } = build({ twin: true });
    expect((await service.syncInstagramMessages(tenantId)).newMessages).toBe(0);
    expect(saved).toHaveLength(0);
    expect(eventsGateway.emitMessageReceived).not.toHaveBeenCalled();
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it('gives the claim back when Meta cannot return the message details, so the next pass retries', async () => {
    const { service } = build({});
    (global as any).fetch = jest.fn().mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('/conversations?'))
        return {
          json: async () => ({
            data: [
              {
                id: 'graph-conv',
                participants: { data: [{ id: 'ig-1' }, { id: 'cust-1' }] },
              },
            ],
          }),
        };
      if (u.includes('/graph-conv/messages'))
        return { json: async () => ({ data: [{ id: 'm-1' }] }) };
      return { json: async () => ({ error: { message: 'temporary' } }) };
    });
    await service.syncInstagramMessages(tenantId);
    expect(service.releaseMetaEvent).toHaveBeenCalledWith(tenantId, 'msg:m-1');
  });
});
