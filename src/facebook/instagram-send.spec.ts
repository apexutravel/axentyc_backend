import { Types } from 'mongoose';
import { FacebookService } from './facebook.service';

describe('Replying to an Instagram DM from AXENTYC', () => {
  const tenantId = new Types.ObjectId().toString();
  const conversationId = new Types.ObjectId().toString();
  const igAccount = { accountId: 'ig-1', pageId: 'page-1', accessToken: 'page-token', platform: 'instagram' };

  const build = (conversation: any, account: any = igAccount) => {
    const conversationModel: any = { findOne: jest.fn().mockResolvedValue(conversation) };
    const socialAccountModel: any = { findOne: jest.fn().mockResolvedValue(account) };
    const chain: any = { sort: () => chain, limit: () => Promise.resolve({}) };
    const messageModel: any = { updateOne: jest.fn().mockReturnValue(chain) };
    const service = new FacebookService(
      socialAccountModel, {} as any, conversationModel, messageModel, {} as any,
      { get: () => undefined } as any, {} as any, {} as any, { emit: jest.fn() } as any,
    );
    return { service, socialAccountModel, messageModel };
  };
  const igConversation = {
    channel: 'instagram',
    metadata: { externalId: 'igsid-99', accountId: 'ig-1', pageId: 'page-1', conversationId: 'graph-conv' },
  };
  const graph = (payload: any) => {
    const fn = jest.fn().mockResolvedValue({ json: async () => payload });
    (global as any).fetch = fn;
    return fn;
  };

  afterEach(() => jest.restoreAllMocks());

  it('posts to /me/messages with the page token and the sender IGSID', async () => {
    const fetchMock = graph({ message_id: 'mid-1', recipient_id: 'igsid-99' });
    const { service, messageModel } = build(igConversation);

    await expect(service.sendMessage(tenantId, conversationId, 'Hola!')).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/me/messages?access_token=page-token');
    expect(JSON.parse(init.body)).toEqual({ recipient: { id: 'igsid-99' }, messaging_type: 'RESPONSE', message: { text: 'Hola!' } });
    expect(messageModel.updateOne).toHaveBeenCalled(); // stored the Meta message id (avoids duplicates when polling)
  });

  it('finds the Instagram account through the linked page when the conversation only has pageId', async () => {
    graph({ message_id: 'mid-2' });
    const { service, socialAccountModel } = build({ ...igConversation, metadata: { externalId: 'igsid-99', pageId: 'page-1' } });
    await expect(service.sendMessage(tenantId, conversationId, 'Hola')).resolves.toBe(true);
    const query = socialAccountModel.findOne.mock.calls[0][0];
    expect(query.$or).toContainEqual({ pageId: 'page-1', platform: 'instagram' });
  });

  it('returns false (message marked failed) when Meta rejects it, e.g. outside the 24h window', async () => {
    graph({ error: { code: 10, message: 'This message is sent outside of allowed window.' } });
    const { service } = build(igConversation);
    await expect(service.sendMessage(tenantId, conversationId, 'Hola')).resolves.toBe(false);
  });

  it('returns false when there is no sender id, no connected account or no token', async () => {
    const f = graph({ message_id: 'x' });
    await expect(build({ channel: 'instagram', metadata: { accountId: 'ig-1' } }).service.sendMessage(tenantId, conversationId, 'Hola')).resolves.toBe(false);
    await expect(build(igConversation, null).service.sendMessage(tenantId, conversationId, 'Hola')).resolves.toBe(false);
    await expect(build(igConversation, { ...igAccount, accessToken: undefined }).service.sendMessage(tenantId, conversationId, 'Hola')).resolves.toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
