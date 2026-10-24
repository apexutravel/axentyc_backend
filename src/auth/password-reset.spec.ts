import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { AuthService } from './auth.service';

describe('password recovery', () => {
  const userId = new Types.ObjectId();
  let resets: any[];
  let users: any;
  let mailer: any;
  let service: AuthService;

  const build = (opts: { user?: any } = {}) => {
    resets = [];
    const resetModel: any = {
      findOne: () => ({ sort: () => ({ lean: () => Promise.resolve(resets[resets.length - 1] ?? null) }) }),
      deleteMany: jest.fn().mockImplementation(async () => { resets = []; }),
      create: jest.fn().mockImplementation(async (d: any) => { resets.push({ ...d, createdAt: new Date() }); }),
      findOneAndDelete: jest.fn().mockImplementation(async (q: any) => {
        const i = resets.findIndex((r) => r.tokenHash === q.tokenHash && r.expiresAt > q.expiresAt.$gt);
        return i >= 0 ? resets.splice(i, 1)[0] : null;
      }),
    };
    users = {
      findByEmail: jest.fn().mockImplementation(async (e: string) => (opts.user && e.toLowerCase() === 'ana@x.com' ? opts.user : null)),
      changePassword: jest.fn().mockResolvedValue({}),
    };
    mailer = { send: jest.fn().mockResolvedValue(true) };
    const config: any = { get: (k: string) => (k === 'FRONTEND_URL' ? 'https://app.test/' : undefined) };
    const Ctor: any = AuthService;
    service = new Ctor(users, {}, {}, {}, {}, {}, {}, config, resetModel, mailer);
  };

  const activeUser = () => ({ _id: userId, email: 'ana@x.com', firstName: 'Ana', isActive: true });

  it('sends a link only to real, active accounts but answers the same either way', async () => {
    build({ user: activeUser() });
    await expect(service.forgotPassword('nobody@x.com')).resolves.toBeUndefined();
    expect(mailer.send).not.toHaveBeenCalled();

    await expect(service.forgotPassword(' Ana@X.com ')).resolves.toBeUndefined();
    expect(mailer.send).toHaveBeenCalledTimes(1);
    const html = mailer.send.mock.calls[0][2] as string;
    expect(html).toMatch(/https:\/\/app\.test\/auth\/reset-password\?token=[a-f0-9]{64}/);

    build({ user: { ...activeUser(), isActive: false } });
    await service.forgotPassword('ana@x.com');
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('stores only a hash of the token, never the token itself', async () => {
    build({ user: activeUser() });
    await service.forgotPassword('ana@x.com');
    const token = /token=([a-f0-9]{64})/.exec(mailer.send.mock.calls[0][2])![1];
    expect(resets[0].tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(resets[0])).not.toContain(token);
  });

  it('does not email again within a minute (no mail bombing)', async () => {
    build({ user: activeUser() });
    await service.forgotPassword('ana@x.com');
    await service.forgotPassword('ana@x.com');
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });

  it('the link works exactly once', async () => {
    build({ user: activeUser() });
    await service.forgotPassword('ana@x.com');
    const token = /token=([a-f0-9]{64})/.exec(mailer.send.mock.calls[0][2])![1];
    await expect(service.resetPassword(token, 'newpass1')).resolves.toBeUndefined();
    expect(users.changePassword).toHaveBeenCalledWith(String(userId), 'newpass1');
    await expect(service.resetPassword(token, 'again123')).rejects.toBeInstanceOf(BadRequestException);
    expect(users.changePassword).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown and expired tokens', async () => {
    build({ user: activeUser() });
    await expect(service.resetPassword('f'.repeat(64), 'newpass1')).rejects.toBeInstanceOf(BadRequestException);
    resets.push({ userId, tokenHash: createHash('sha256').update('old').digest('hex'), expiresAt: new Date(Date.now() - 1000) });
    await expect(service.resetPassword('old', 'newpass1')).rejects.toBeInstanceOf(BadRequestException);
    expect(users.changePassword).not.toHaveBeenCalled();
  });
});
