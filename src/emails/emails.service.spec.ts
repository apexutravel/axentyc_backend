import { Types } from 'mongoose';
import { EmailsService } from './emails.service';

describe('EmailsService (mailbox isolation)', () => {
  const tenantId = new Types.ObjectId().toString();
  const mailboxA: any = { _id: new Types.ObjectId(), emailAddress: 'a@x.com', label: 'A', imap: { passEnc: 'x' }, workspaceId: undefined };

  let emailModel: any;
  let integrations: any;
  let gateway: any;
  let service: EmailsService;

  const build = () => {
    emailModel = {
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      find: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) }),
      countDocuments: jest.fn().mockResolvedValue(0),
    };
    integrations = {
      resolveConnected: jest.fn().mockResolvedValue(mailboxA),
      decryptSecret: jest.fn().mockReturnValue('pw'),
      recordSync: jest.fn().mockResolvedValue(undefined),
    };
    gateway = { emitToTenant: jest.fn() };
    service = new EmailsService(emailModel, integrations, gateway);
  };

  beforeEach(build);

  it('an empty server folder only clears the local copy of THAT mailbox', async () => {
    const client = { status: jest.fn().mockResolvedValue({ messages: 0 }) };
    await (service as any).syncOneFolder(client, tenantId, mailboxA, 'INBOX', 50, false);

    const filter = emailModel.deleteMany.mock.calls[0][0];
    expect(filter.integrationId).toEqual(mailboxA._id);
    expect(filter.folder).toBe('INBOX');
    expect(String(filter.tenantId)).toBe(tenantId);
  });

  it('stored-message lookups during a sync are scoped to the mailbox', async () => {
    async function* none() {}
    const client = { status: jest.fn().mockResolvedValue({ messages: 3 }), fetch: jest.fn().mockReturnValue(none()) };
    await (service as any).syncOneFolder(client, tenantId, mailboxA, 'INBOX', 50, false);

    for (const [filter] of emailModel.find.mock.calls) {
      expect(filter.integrationId).toEqual(mailboxA._id);
    }
  });

  it('orphan cleanup after listing folders never touches other mailboxes', async () => {
    const client: any = {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue([]), // no folders -> nothing to sync
      logout: jest.fn().mockResolvedValue(undefined),
      usable: false,
    };
    jest.spyOn(service as any, 'createImapClient').mockReturnValue(client);

    const res: any = await service.syncAllFolders(tenantId, 50, mailboxA._id.toString());

    const filter = emailModel.deleteMany.mock.calls[0][0];
    expect(filter.integrationId).toEqual(mailboxA._id);
    expect(filter.folder).toEqual({ $nin: [] });
    expect(integrations.recordSync).toHaveBeenCalledWith(mailboxA._id.toString(), null);
    expect(res.integrationId).toBe(mailboxA._id.toString());
  });

  it('does not start a second concurrent sync of the same mailbox', async () => {
    (service as any).syncing.add(mailboxA._id.toString());
    const res: any = await service.syncAllFolders(tenantId, 50, mailboxA._id.toString());
    expect(res.skipped).toBe(true);
  });

  it('a failing mailbox is reported without blocking the others in syncAllAccounts', async () => {
    const mailboxB: any = { _id: new Types.ObjectId(), emailAddress: 'b@x.com' };
    integrations.findConnectedByTenant = jest.fn().mockResolvedValue([mailboxA, mailboxB]);
    jest.spyOn(service, 'syncAllFolders').mockImplementation(async (_t, _l, id) => {
      if (id === mailboxA._id.toString()) throw new Error('boom');
      return { folders: [], totalSynced: 4, integrationId: id } as any;
    });

    const res = await service.syncAllAccounts(tenantId);

    expect(res.totalSynced).toBe(4);
    expect(res.accounts.map((a: any) => a.ok)).toEqual([false, true]);
  });

  it('start/stop keep one independent loop per mailbox', () => {
    jest.useFakeTimers();
    service.startAutoSync('m1', tenantId);
    service.startAutoSync('m2', tenantId);
    expect((service as any).syncIntervals.size).toBe(2);
    service.stopAutoSync('m1');
    expect([...(service as any).syncIntervals.keys()]).toEqual(['m2']);
    service.stopAutoSync('m2');
    jest.useRealTimers();
  });
});
