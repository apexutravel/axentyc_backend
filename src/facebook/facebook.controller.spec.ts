import { ForbiddenException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { FacebookController } from './facebook.controller';

describe('FacebookController webhook', () => {
  const appSecret = 'test-app-secret';
  const body = { object: 'page', entry: [{ id: '123', messaging: [] }] };
  const rawBody = Buffer.from(JSON.stringify(body));

  const sign = (algo: 'sha256' | 'sha1', secret = appSecret) =>
    `${algo}=` + createHmac(algo, secret).update(rawBody).digest('hex');

  let handleWebhook: jest.Mock;
  let controller: FacebookController;

  const build = (secret: string | null = appSecret) => {
    handleWebhook = jest.fn().mockResolvedValue(undefined);
    const facebookService: any = { handleWebhook };
    const configService: any = {
      get: (key: string) => (key === 'FACEBOOK_APP_SECRET' ? secret ?? undefined : undefined),
    };
    controller = new FacebookController(facebookService, configService, {} as any, {} as any);
  };

  const req = (headers: Record<string, string>, raw: Buffer | null = rawBody) =>
    ({ headers, rawBody: raw ?? undefined }) as any;

  beforeEach(() => build());

  it('accepts a correctly signed sha256 payload', async () => {
    const res = await controller.handleWebhook(body, req({ 'x-hub-signature-256': sign('sha256') }));
    expect(res).toEqual({ status: 'ok' });
    expect(handleWebhook).toHaveBeenCalledWith(body);
  });

  it('accepts a correctly signed sha1 payload when sha256 is absent', async () => {
    const res = await controller.handleWebhook(body, req({ 'x-hub-signature': sign('sha1') }));
    expect(res).toEqual({ status: 'ok' });
  });

  it('rejects a missing signature', async () => {
    await expect(controller.handleWebhook(body, req({}))).rejects.toBeInstanceOf(ForbiddenException);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature', async () => {
    await expect(
      controller.handleWebhook(body, req({ 'x-hub-signature-256': sign('sha256', 'other-secret') })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('rejects when the raw body was not captured', async () => {
    await expect(
      controller.handleWebhook(body, req({ 'x-hub-signature-256': sign('sha256') }, null)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects everything when the app secret is not configured', async () => {
    build(null);
    await expect(
      controller.handleWebhook(body, req({ 'x-hub-signature-256': sign('sha256') })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
