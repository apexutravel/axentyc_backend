import { Types } from 'mongoose';
import { FacebookService } from './facebook.service';
import { AUTOMATION_EVENT } from '../automations/automation-events';
import { AutomationTrigger } from '../automations/entities/automation.entity';

describe('Instagram polling safety net', () => {
  const tenantId = new Types.ObjectId().toString();
  const workspaceId = new Types.ObjectId();
  const account: any = {
    _id: new Types.ObjectId(),
    tenantId: new Types.ObjectId(tenantId),
    workspaceId,
    accountId: 'ig-1',
    accountName: 'mitienda',
    accessToken: 'token',
  };
  const contactId = new Types.ObjectId();
  const conversationId = new Types.ObjectId();

  const media = (comments: any[]) => ({
    data: [{ id: 'm1', timestamp: '2026-10-24T10:00:00+0000', comments: { data: comments } }],
  });
  const comment = (id: string, username: string, text: string, timestamp = '2026-10-25T10:00:00+0000') => ({ id, username, text, timestamp });

  const build = (opts: { stored?: string[] } = {}) => {
    const stored = new Set(opts.stored || []);
    const saved: any[] = [];
    const MessageModel: any = jest.fn().mockImplementation((doc) => ({
      save: jest.fn().mockImplementation(async () => {
        const m = { _id: new Types.ObjectId(), ...doc };
        saved.push(m);
        return m;
      }),
    }));
    MessageModel.exists = jest.fn().mockImplementation(async (q: any) => (stored.has(q['metadata.commentId']) ? { _id: 1 } : null));

    const socialAccountModel: any = { find: jest.fn().mockResolvedValue([account]), updateOne: jest.fn() };
    const conversationModel: any = {
      findByIdAndUpdate: jest.fn().mockReturnValue({
        populate: () => ({ lean: async () => ({ _id: conversationId, unreadCount: 1 }) }),
      }),
    };
    const eventsGateway: any = {
      isConversationBeingViewed: jest.fn().mockReturnValue(false),
      emitMessageReceived: jest.fn(),
      emitConversationUpdated: jest.fn(),
      emitToTenant: jest.fn(),
    };
    const bus: any = { emit: jest.fn() };
    const service: any = new FacebookService(
      socialAccountModel,
      {} as any,
      conversationModel,
      MessageModel,
      {} as any,
      { get: () => undefined } as any,
      eventsGateway,
      {} as any,
      bus,
    );
    service.getOrCreateInstagramContactByUsername = jest.fn().mockResolvedValue({ _id: contactId, name: '@rosa', customFields: {} });
    service.getOrCreateInstagramCommentConversation = jest.fn().mockResolvedValue({ _id: conversationId, workspaceId });
    return { service, saved, eventsGateway, bus, conversationModel };
  };

  const mockGraph = (payload: any) => {
    const fn = jest.fn().mockResolvedValue({ json: async () => payload });
    (global as any).fetch = fn;
    return fn;
  };

  afterEach(() => jest.restoreAllMocks());

  it('turns an unseen comment into a stored message, notification and automation event', async () => {
    mockGraph(media([comment('c1', 'rosa', 'precio?')]));
    const { service, saved, eventsGateway, bus } = build();

    const res = await service.syncInstagramComments(tenantId);

    expect(res.newComments).toBe(1);
    expect(saved[0]).toMatchObject({ content: 'precio?', metadata: expect.objectContaining({ commentId: 'c1', isComment: true, polled: true }) });
    expect(eventsGateway.emitMessageReceived).toHaveBeenCalledTimes(1);
    expect(eventsGateway.emitToTenant).toHaveBeenCalledWith(tenantId, 'ig.comment.new', expect.objectContaining({ accountId: 'ig-1' }));
    expect(bus.emit).toHaveBeenCalledWith(
      AUTOMATION_EVENT,
      expect.objectContaining({ trigger: AutomationTrigger.MESSAGE_RECEIVED, channel: 'instagram', text: 'precio?', tenantId }),
    );
  });

  it('never duplicates a comment that is already stored (webhook arrived first)', async () => {
    mockGraph(media([comment('c1', 'rosa', 'precio?')]));
    const { service, saved, eventsGateway, bus } = build({ stored: ['c1'] });

    expect((await service.syncInstagramComments(tenantId)).newComments).toBe(0);
    expect(saved).toHaveLength(0);
    expect(eventsGateway.emitMessageReceived).not.toHaveBeenCalled();
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it('ignores comments written by the business itself', async () => {
    mockGraph(media([comment('c1', 'MiTienda', 'Gracias!')]));
    const { service, saved } = build();
    expect((await service.syncInstagramComments(tenantId)).newComments).toBe(0);
    expect(saved).toHaveLength(0);
  });

  it('only looks at comments newer than the last pass, and includes replies', async () => {
    const replies = { data: [comment('r1', 'pedro', 'yo tambien', '2026-10-25T10:05:00+0000')] };
    mockGraph(
      media([
        comment('old', 'ana', 'viejo', '2026-10-20T10:00:00+0000'),
        { ...comment('c2', 'rosa', 'nuevo', '2026-10-25T10:00:00+0000'), replies },
      ]),
    );
    const { service, saved } = build();

    const res = await service.syncInstagramComments(tenantId, { since: new Date('2026-10-25T09:00:00+0000') });

    expect(res.newComments).toBe(2);
    expect(saved.map((m) => m.metadata.commentId)).toEqual(['c2', 'r1']);
  });

  it('one failing account does not stop the pass', async () => {
    mockGraph({ error: { code: 4, message: 'rate limited' } });
    const { service } = build();
    await expect(service.syncInstagramComments(tenantId)).resolves.toEqual({ newComments: 0 });
  });

  it('the cron never runs two passes at once and can be switched off', async () => {
    const { service } = build();
    const sync = jest.spyOn(service, 'syncInstagramMessages').mockImplementation(() => new Promise(() => undefined));
    service.socialAccountModel.find = jest.fn().mockReturnValue({ select: () => ({ lean: async () => [account] }) });
    service.syncInstagramComments = jest.fn().mockResolvedValue({ newComments: 0 });

    void service.autoSyncInstagram();
    await new Promise((r) => setImmediate(r));
    await service.autoSyncInstagram(); // second call while the first is still running
    expect(sync).toHaveBeenCalledTimes(1);

    const off = build();
    (off.service as any).configService = { get: (k: string) => (k === 'META_POLLING_ENABLED' ? 'false' : undefined) };
    off.service.socialAccountModel.find = jest.fn();
    await off.service.autoSyncInstagram();
    expect(off.service.socialAccountModel.find).not.toHaveBeenCalled();
  });
});
