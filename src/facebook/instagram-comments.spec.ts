import { Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { FacebookService } from './facebook.service';

describe('Instagram comments (live from Graph API)', () => {
  const tenantId = new Types.ObjectId().toString();
  const account: any = {
    _id: new Types.ObjectId(),
    accountId: 'ig-1',
    accountName: 'mitienda',
    accessToken: 'token',
  };

  const build = () => {
    const socialAccountModel: any = {
      findOne: jest.fn().mockResolvedValue(account),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const configService: any = { get: () => undefined };
    const service = new FacebookService(
      socialAccountModel,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      configService,
      {} as any,
      {} as any,
      { emit: jest.fn() } as any,
    );
    return { service, socialAccountModel };
  };

  const mockFetch = (payload: any) => {
    const fn = jest.fn().mockResolvedValue({ json: async () => payload });
    (global as any).fetch = fn;
    return fn;
  };

  afterEach(() => jest.restoreAllMocks());

  it('flattens posts, comments and replies and flags the own account', async () => {
    const fetchMock = mockFetch({
      data: [
        {
          id: 'm1',
          caption: 'Promo',
          media_type: 'IMAGE',
          media_url: 'https://cdn/x.jpg',
          permalink: 'https://instagram.com/p/x',
          timestamp: '2026-10-20T10:00:00+0000',
          comments_count: 2,
          comments: {
            data: [
              {
                id: 'c1',
                text: 'precio?',
                username: 'rosa',
                timestamp: '2026-10-20T11:00:00+0000',
                replies: {
                  data: [{ id: 'r1', text: '$10', username: 'MiTienda', timestamp: '2026-10-20T12:00:00+0000' }],
                },
              },
            ],
          },
        },
      ],
    });
    const { service } = build();

    const { posts } = await service.getInstagramFeed(tenantId, 'ig-1');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/ig-1/media?');
    expect(posts).toHaveLength(1);
    expect(posts[0].full_picture).toBe('https://cdn/x.jpg');
    const [root, reply] = posts[0].comments.data;
    expect(root).toMatchObject({ id: 'c1', message: 'precio?', from: { name: '@rosa', isOwn: false } });
    expect(root.parent).toBeUndefined();
    expect(reply).toMatchObject({ id: 'r1', parent: { id: 'c1' }, from: { isOwn: true } });
  });

  it('flags the account as errored when Meta says the token is invalid', async () => {
    mockFetch({ error: { code: 190, message: 'Error validating access token' } });
    const { service, socialAccountModel } = build();

    await expect(service.getInstagramFeed(tenantId, 'ig-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(socialAccountModel.updateOne).toHaveBeenCalled();
  });

  it('refuses to work without a connected Instagram account', async () => {
    const { service, socialAccountModel } = build();
    socialAccountModel.findOne.mockResolvedValue(null);
    await expect(service.getInstagramFeed(tenantId, 'ig-x')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('replies to a comment or comments on a post, never both missing', async () => {
    const fetchMock = mockFetch({ id: 'new-1' });
    const { service } = build();

    await expect(service.replyToInstagramComment(tenantId, 'ig-1', 'hola', { commentId: 'c1' })).resolves.toEqual({ success: true, commentId: 'new-1' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/c1/replies');

    await service.replyToInstagramComment(tenantId, 'ig-1', 'hola', { mediaId: 'm1' });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/m1/comments');

    await expect(service.replyToInstagramComment(tenantId, 'ig-1', 'hola', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.replyToInstagramComment(tenantId, 'ig-1', '  ', { commentId: 'c1' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
