import { Types } from 'mongoose';
import { FacebookService } from './facebook.service';

describe('Meta read receipts and sender actions', () => {
  const tenantId = new Types.ObjectId();
  const conversationId = new Types.ObjectId();
  const fbAccount: any = { tenantId, pageId: 'page-1', accountId: undefined, platform: 'facebook', accessToken: 'tok' };
  const igAccount: any = { tenantId, pageId: 'page-1', accountId: 'ig-1', platform: 'instagram', accessToken: 'tok' };

  const build = (opts: { account?: any; conversation?: any; midMessage?: any; modified?: number } = {}) => {
    const account = 'account' in opts ? opts.account : fbAccount;
    const conversation = 'conversation' in opts ? opts.conversation : { _id: conversationId, channel: 'facebook', metadata: { externalId: 'psid-9', pageId: 'page-1' } };
    const socialAccountModel: any = { findOne: jest.fn().mockResolvedValue(account) };
    const conversationModel: any = { findOne: jest.fn().mockResolvedValue(conversation) };
    const messageModel: any = {
      findOne: jest.fn().mockReturnValue({ select: () => ({ lean: async () => opts.midMessage ?? null }) }),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: opts.modified ?? 2 }),
    };
    const eventsGateway: any = { emitToTenant: jest.fn(), emitToConversation: jest.fn() };
    const service: any = new FacebookService(
      socialAccountModel, {} as any, conversationModel, messageModel, {} as any,
      { get: () => undefined } as any, eventsGateway, {} as any, { emit: jest.fn() } as any,
    );
    return { service, socialAccountModel, conversationModel, messageModel, eventsGateway };
  };

  describe('read receipts', () => {
    it('Messenger: marks everything sent up to the watermark as read and tells the UI how far', async () => {
      const { service, messageModel, eventsGateway } = build();
      const watermark = Date.UTC(2026, 9, 25, 12, 0, 0);

      await service.handleMessageRead('page-1', { sender: { id: 'psid-9' }, recipient: { id: 'page-1' }, read: { watermark } }, 'facebook');

      const [filter, update] = messageModel.updateMany.mock.calls[0];
      expect(filter).toMatchObject({ direction: 'outbound', status: { $in: ['sent', 'delivered'] }, createdAt: { $lte: new Date(watermark) } });
      expect(update).toEqual({ $set: { status: 'read' } });
      const payload = { conversationId: String(conversationId), status: 'read', readUpTo: new Date(watermark).toISOString() };
      expect(eventsGateway.emitToTenant).toHaveBeenCalledWith(String(tenantId), 'message.status.updated', payload);
      expect(eventsGateway.emitToConversation).toHaveBeenCalledWith(String(conversationId), 'message.status.updated', payload);
    });

    it('Instagram: uses the time of the last message the customer saw (read.mid)', async () => {
      const seenAt = new Date('2026-10-25T10:30:00Z');
      const { service, messageModel, eventsGateway, conversationModel } = build({
        account: igAccount,
        conversation: { _id: conversationId, channel: 'instagram', metadata: { externalId: 'igsid-5', accountId: 'ig-1', pageId: 'page-1' } },
        midMessage: { createdAt: seenAt },
      });

      await service.handleMessageRead('ig-1', { sender: { id: 'igsid-5' }, recipient: { id: 'ig-1' }, read: { mid: 'mid-77' } }, 'instagram');

      expect(messageModel.findOne.mock.calls[0][0]).toMatchObject({ 'metadata.externalId': 'mid-77' });
      expect(messageModel.updateMany.mock.calls[0][0].createdAt).toEqual({ $lte: seenAt });
      expect(eventsGateway.emitToTenant).toHaveBeenCalledWith(String(tenantId), 'message.status.updated', expect.objectContaining({ readUpTo: seenAt.toISOString() }));
      expect(conversationModel.findOne.mock.calls[0][0]).toMatchObject({ channel: 'instagram', 'metadata.externalId': 'igsid-5' });
    });

    it('falls back to the event timestamp when the seen message is unknown, and accepts seconds', async () => {
      const { service, messageModel } = build({ midMessage: null });
      await service.handleMessageRead('page-1', { sender: { id: 'psid-9' }, timestamp: 1_792_920_000, read: { mid: 'unknown' } }, 'facebook');
      expect(messageModel.updateMany.mock.calls[0][0].createdAt).toEqual({ $lte: new Date(1_792_920_000 * 1000) });
    });

    it('never touches comment threads and stays quiet when nothing changed', async () => {
      const quiet = build({ modified: 0 });
      await quiet.service.handleMessageRead('page-1', { sender: { id: 'psid-9' }, read: { watermark: Date.now() } }, 'facebook');
      expect(quiet.conversationModel.findOne.mock.calls[0][0]).toMatchObject({ 'metadata.isComment': { $ne: true } });
      expect(quiet.eventsGateway.emitToTenant).not.toHaveBeenCalled();
    });

    it('ignores events for unknown accounts, unknown conversations or without a sender', async () => {
      const noAccount = build({ account: null });
      await noAccount.service.handleMessageRead('x', { sender: { id: 'u' }, read: { watermark: 1 } }, 'facebook');
      const noConversation = build({ conversation: null });
      await noConversation.service.handleMessageRead('page-1', { sender: { id: 'u' }, read: { watermark: 1 } }, 'facebook');
      const noSender = build();
      await noSender.service.handleMessageRead('page-1', { read: { watermark: 1 } }, 'facebook');
      for (const t of [noAccount, noConversation, noSender]) expect(t.messageModel.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('webhook routing of read events', () => {
    const route = async (body: any, account: any = igAccount) => {
      const t = build({ account });
      t.socialAccountModel.updateMany = jest.fn().mockResolvedValue({});
      const spy = jest.spyOn(t.service, 'handleMessageRead').mockResolvedValue(undefined);
      await t.service.handleWebhook(body);
      return spy;
    };
    const read = (recipient: string) => ({ sender: { id: 'user-1' }, recipient: { id: recipient }, read: { watermark: 1 } });

    it('a Messenger read (object=page, recipient=page) goes to Facebook', async () => {
      const ev = read('page-1');
      const spy = await route({ object: 'page', entry: [{ id: 'page-1', messaging: [ev] }] });
      expect(spy).toHaveBeenCalledWith('page-1', ev, 'facebook');
    });

    it('an Instagram read delivered through the page object goes to Instagram', async () => {
      const ev = read('ig-1');
      const spy = await route({ object: 'page', entry: [{ id: 'page-1', messaging: [ev] }] });
      expect(spy).toHaveBeenCalledWith('ig-1', ev, 'instagram');
    });

    it('an Instagram read (object=instagram) goes to Instagram', async () => {
      const ev = read('ig-1');
      const spy = await route({ object: 'instagram', entry: [{ id: 'ig-1', messaging: [ev] }] });
      expect(spy).toHaveBeenCalledWith('ig-1', ev, 'instagram');
    });
  });

  describe('sender actions (typing / seen shown to the customer)', () => {
    const thread = (extra: any = {}) => ({
      _id: conversationId, channel: 'instagram', metadata: { externalId: 'igsid-5', accountId: 'ig-1', pageId: 'page-1', ...extra },
    });
    const graph = (payload: any) => {
      const fn = jest.fn().mockResolvedValue({ json: async () => payload });
      (global as any).fetch = fn;
      return fn;
    };
    afterEach(() => jest.restoreAllMocks());

    it.each(['typing_on', 'typing_off', 'mark_seen'] as const)('sends %s to the customer through /me/messages', async (action) => {
      const f = graph({ recipient_id: 'igsid-5' });
      const { service } = build({ account: igAccount, conversation: thread() });
      await expect(service.sendSenderAction(String(tenantId), String(conversationId), action)).resolves.toBe(true);
      const [url, init] = f.mock.calls[0];
      expect(String(url)).toContain('/me/messages?access_token=tok');
      expect(JSON.parse(init.body)).toEqual({ recipient: { id: 'igsid-5' }, sender_action: action });
    });

    it('does nothing for comment threads', async () => {
      const f = graph({});
      const { service } = build({ account: igAccount, conversation: thread({ isComment: true }) });
      await expect(service.sendSenderAction(String(tenantId), String(conversationId), 'typing_on')).resolves.toBe(false);
      expect(f).not.toHaveBeenCalled();
    });

    it('never throws when Meta refuses it (e.g. outside the 24h window) or the network fails', async () => {
      graph({ error: { code: 10, message: 'outside of allowed window' } });
      const { service } = build({ account: igAccount, conversation: thread() });
      await expect(service.sendSenderAction(String(tenantId), String(conversationId), 'typing_on')).resolves.toBe(false);
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));
      await expect(service.sendSenderAction(String(tenantId), String(conversationId), 'mark_seen')).resolves.toBe(false);
    });
  });
});
