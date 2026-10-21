import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { EmailIntegrationsService } from './email-integrations.service';

describe('EmailIntegrationsService (multiple mailboxes per agency)', () => {
  const tenantId = new Types.ObjectId().toString();

  const baseDto: any = {
    smtpHost: 'smtp.x.com', smtpPort: 587, smtpSecure: false, smtpUser: 'ventas@x.com', smtpPass: 'a',
    imapHost: 'imap.x.com', imapPort: 993, imapSecure: true, imapUser: 'ventas@x.com', imapPass: 'b',
  };

  let model: any;
  let emails: any;
  let billing: any;
  let service: EmailIntegrationsService;

  const build = (opts: { duplicate?: boolean } = {}) => {
    const created: any = {
      _id: new Types.ObjectId(),
      workspaceId: undefined,
      status: 'connected',
      toObject() { return this; },
    };
    model = {
      findOne: jest.fn().mockImplementation((q: any) =>
        // the duplicate lookup is the only findOne that filters by emailAddress
        Promise.resolve(q.emailAddress && opts.duplicate ? { _id: new Types.ObjectId() } : null),
      ),
      create: jest.fn().mockResolvedValue(created),
      find: jest.fn().mockReturnValue({ sort: () => Promise.resolve([created]) }),
      findById: jest.fn().mockResolvedValue(created),
      updateMany: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    emails = { startAutoSync: jest.fn(), stopAutoSync: jest.fn(), getUnreadByIntegration: jest.fn().mockResolvedValue({}) };
    billing = { assertCanConnectEmail: jest.fn().mockResolvedValue(undefined) };
    service = new EmailIntegrationsService(model, { get: () => 'k' } as any, emails, billing);
    jest.spyOn(service, 'testConnection').mockResolvedValue({ smtp: { ok: true }, imap: { ok: true } });
    return created;
  };

  it('derives the mailbox identity from the from-address, then login', () => {
    expect(EmailIntegrationsService.resolveEmailAddress({ fromAddress: ' Info@X.com ', smtpUser: 'u' })).toBe('info@x.com');
    expect(EmailIntegrationsService.resolveEmailAddress({ smtpUser: 'apikey', imapUser: 'Soporte@x.com' })).toBe('soporte@x.com');
    expect(EmailIntegrationsService.resolveEmailAddress({})).toBe('');
  });

  it('links a second mailbox: checks plan capacity, stores it and starts its own sync loop', async () => {
    const created = build();
    const res: any = await service.connect(tenantId, { ...baseDto, label: 'Ventas' });

    expect(billing.assertCanConnectEmail).toHaveBeenCalledTimes(1);
    const payload = model.create.mock.calls[0][0];
    expect(payload.emailAddress).toBe('ventas@x.com');
    expect(payload.label).toBe('Ventas');
    expect(payload.smtp.passEnc).toBeDefined();
    expect(payload.smtp.passEnc).not.toContain('"a"');
    expect(emails.startAutoSync).toHaveBeenCalledWith(created._id.toString(), tenantId);
    expect(res.smtp.passEnc).toBeUndefined(); // secrets never leave the service
  });

  it('rejects linking the same address twice in the same agency', async () => {
    build({ duplicate: true });
    await expect(service.connect(tenantId, baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(model.create).not.toHaveBeenCalled();
    expect(billing.assertCanConnectEmail).not.toHaveBeenCalled();
  });

  it('does not save a mailbox whose SMTP/IMAP test fails', async () => {
    build();
    (service.testConnection as jest.Mock).mockResolvedValue({ smtp: { ok: false, error: 'auth' }, imap: { ok: true } });
    await expect(service.connect(tenantId, baseDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('requires an address to identify the mailbox', async () => {
    build();
    await expect(
      service.connect(tenantId, { ...baseDto, smtpUser: '', imapUser: '', fromAddress: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removing a mailbox stops its loop and deletes only its own cached messages', async () => {
    const doc: any = { _id: new Types.ObjectId(), tenantId: new Types.ObjectId(tenantId), workspaceId: undefined };
    build();
    model.findOne = jest.fn().mockResolvedValue(doc);
    model.deleteOne = jest.fn().mockResolvedValue({});
    emails.deleteAllForIntegration = jest.fn().mockResolvedValue(7);

    const res = await service.remove(tenantId, doc._id.toString());

    expect(emails.stopAutoSync).toHaveBeenCalledWith(doc._id.toString());
    expect(emails.deleteAllForIntegration).toHaveBeenCalledWith(tenantId, doc._id.toString());
    expect(res.messagesDeleted).toBe(7);
  });
});
