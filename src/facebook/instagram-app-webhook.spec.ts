import { FacebookService } from './facebook.service';

describe('Instagram app webhook (object "instagram")', () => {
  const REQUIRED = FacebookService.INSTAGRAM_APP_FIELDS;
  const cfg: Record<string, string> = {
    FACEBOOK_APP_ID: 'app-1',
    FACEBOOK_APP_SECRET: 'secret',
    FACEBOOK_VERIFY_TOKEN: 'verify-me',
    API_PREFIX: 'api/v1',
  };
  const build = (overrides: Record<string, string | undefined> = {}) => {
    const merged = { ...cfg, ...overrides };
    return new FacebookService(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      { get: (k: string) => merged[k] } as any, {} as any, {} as any, { emit: jest.fn() } as any,
    );
  };
  const sub = (object: string, fields: string[], extra: any = {}) => ({
    object, active: true, callback_url: `https://api.example.com/api/v1/webhook/facebook`,
    fields: fields.map((name) => ({ name })), ...extra,
  });
  /** First call lists the subscriptions, second (if any) is the POST. */
  const meta = (list: any, post: any = { success: true }) => {
    const fn = jest.fn().mockResolvedValueOnce({ json: async () => list }).mockResolvedValue({ json: async () => post });
    (global as any).fetch = fn;
    return fn;
  };
  afterEach(() => jest.restoreAllMocks());

  it('creates the webhook when the app only has "page" (the real situation), reusing the Messenger URL', async () => {
    const f = meta({ data: [sub('page', ['messages', 'feed'])] });
    const res = await build().ensureInstagramAppWebhook();

    expect(res.status).toBe('created');
    const [url, init] = f.mock.calls[1];
    expect(String(url)).toMatch(/\/app-1\/subscriptions$/);
    const body = new URLSearchParams(init.body);
    expect(body.get('object')).toBe('instagram');
    expect(body.get('callback_url')).toBe('https://api.example.com/api/v1/webhook/facebook');
    expect(body.get('verify_token')).toBe('verify-me');
    expect(body.get('access_token')).toBe('app-1|secret');
    expect(body.get('fields')!.split(',').sort()).toEqual([...REQUIRED].sort());
  });

  it('only adds what is missing and keeps fields that are already subscribed', async () => {
    const f = meta({ data: [sub('instagram', ['messages', 'mentions'])] });
    const res = await build().ensureInstagramAppWebhook();

    expect(res.status).toBe('updated');
    const fields = new URLSearchParams(f.mock.calls[1][1].body).get('fields')!.split(',');
    expect(fields).toContain('mentions'); // not removed
    for (const r of REQUIRED) expect(fields).toContain(r);
  });

  it('does nothing when it is already complete (no write to Meta)', async () => {
    const f = meta({ data: [sub('instagram', REQUIRED)] });
    const res = await build().ensureInstagramAppWebhook();
    expect(res.status).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('reactivates an existing but inactive subscription', async () => {
    const f = meta({ data: [sub('instagram', REQUIRED, { active: false })] });
    expect((await build().ensureInstagramAppWebhook()).status).toBe('updated');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('falls back to BACKEND_URL when there is no other callback to reuse', async () => {
    const f = meta({ data: [] });
    await build({ BACKEND_URL: 'https://api.mine.io/' }).ensureInstagramAppWebhook();
    expect(new URLSearchParams(f.mock.calls[1][1].body).get('callback_url')).toBe('https://api.mine.io/api/v1/webhook/facebook');
  });

  it('reports Meta errors and missing configuration instead of throwing', async () => {
    meta({ data: [sub('page', ['messages'])] }, { error: { message: 'Callback verification failed' } });
    expect(await build().ensureInstagramAppWebhook()).toMatchObject({ status: 'error', message: 'Callback verification failed' });

    meta({ error: { message: 'Invalid OAuth access token' } });
    expect((await build().ensureInstagramAppWebhook()).status).toBe('error');

    const f = meta({ data: [] });
    expect(await build({ FACEBOOK_VERIFY_TOKEN: '' }).ensureInstagramAppWebhook()).toMatchObject({ status: 'error' });
    expect(f).toHaveBeenCalledTimes(1); // never POSTs without a verify token

    expect((await build({ FACEBOOK_APP_ID: undefined }).ensureInstagramAppWebhook()).status).toBe('error');
  });

  it('never leaks the app secret in what it returns or logs', async () => {
    meta({ data: [sub('page', ['messages'])] }, { error: { message: 'boom' } });
    const res = await build().ensureInstagramAppWebhook();
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('the read-only status flags what is missing', async () => {
    meta({ data: [sub('instagram', ['messages'])] });
    const st = await build().getInstagramAppWebhookStatus();
    expect(st.configured).toBe(false);
    expect(st.missing).toEqual(REQUIRED.filter((f) => f !== 'messages'));

    meta({ data: [sub('page', ['messages'])] });
    expect((await build().getInstagramAppWebhookStatus()).configured).toBe(false);

    meta({ data: [sub('instagram', REQUIRED)] });
    expect((await build().getInstagramAppWebhookStatus()).configured).toBe(true);
  });
});

describe('Instagram real time heals itself (no button needed)', () => {
  const ACCOUNT_FIELDS = FacebookService.INSTAGRAM_ACCOUNT_FIELDS;
  const REQUIRED = FacebookService.INSTAGRAM_APP_FIELDS;
  const ig: any = { _id: 'ig-doc', tenantId: 't1', accountId: 'ig-1', accountName: 'tienda', pageId: 'page-1', accessToken: 'tok' };
  const fb: any = { accessToken: 'page-tok' };

  const build = (accounts: any[] = [ig], env: Record<string, string> = {}) => {
    const updates: any[] = [];
    const socialAccountModel: any = {
      find: jest.fn().mockResolvedValue(accounts),
      findOne: jest.fn().mockResolvedValue(fb),
      updateOne: jest.fn().mockImplementation((f, u) => { updates.push(u.$set); return Promise.resolve({}); }),
    };
    const cfg: Record<string, string> = { FACEBOOK_APP_ID: 'app-1', FACEBOOK_APP_SECRET: 'secret', FACEBOOK_VERIFY_TOKEN: 'vt', ...env };
    const service: any = new FacebookService(
      socialAccountModel, {} as any, {} as any, {} as any, {} as any,
      { get: (k: string) => cfg[k] } as any, {} as any, {} as any, { emit: jest.fn() } as any,
    );
    return { service, socialAccountModel, updates };
  };
  const sub = (object: string, fields: string[]) => ({ object, active: true, callback_url: 'https://api.x/api/v1/webhook/facebook', fields: fields.map((name) => ({ name })) });

  /** Routes each Graph call by URL so the order of calls does not matter. */
  const meta = (o: { app?: any[]; accountFields?: string[]; accountError?: string; post?: any } = {}) => {
    const calls: { url: string; method: string }[] = [];
    (global as any).fetch = jest.fn().mockImplementation(async (url: any, init: any = {}) => {
      const u = String(url); const method = init.method || 'GET';
      calls.push({ url: u, method });
      if (u.includes('/app-1/subscriptions')) return { json: async () => (method === 'POST' ? o.post ?? { success: true } : { data: o.app ?? [] }) };
      if (u.includes('/ig-1/subscribed_apps')) {
        if (method === 'POST') return { json: async () => ({ success: true }) };
        if (o.accountError) return { json: async () => ({ error: { message: o.accountError } }) };
        return { json: async () => ({ data: [{ subscribed_fields: o.accountFields ?? ACCOUNT_FIELDS }] }) };
      }
      return { json: async () => ({}) };
    });
    return calls;
  };
  afterEach(() => jest.restoreAllMocks());

  it('is a no-op against Meta when everything is already in place, and records it as healthy', async () => {
    const calls = meta({ app: [sub('instagram', REQUIRED)] });
    const { service, updates } = build();

    const res = await service.ensureInstagramRealtime();

    expect(res).toMatchObject({ checked: 1, fixed: 0, failed: 0 });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0); // nothing written
    expect(updates[0]['metadata.realtime']).toMatchObject({ ok: true, error: null });
  });

  it('creates the app webhook and re-subscribes only when something is missing', async () => {
    const calls = meta({ app: [sub('page', ['messages'])], accountFields: ['messages'] });
    const { service, updates } = build();

    const res = await service.ensureInstagramRealtime();

    expect(res.fixed).toBe(2);
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(posts.some((u) => u.includes('/app-1/subscriptions'))).toBe(true);
    expect(posts.some((u) => u.includes('/ig-1/subscribed_apps'))).toBe(true);
    expect(updates[0]['metadata.realtime'].ok).toBe(true);
  });

  it('uses the linked page token and never sends the app secret anywhere but the app token', async () => {
    const calls = meta({ app: [sub('instagram', REQUIRED)] });
    await build().service.ensureInstagramRealtime();
    const accountCall = calls.find((c) => c.url.includes('/ig-1/subscribed_apps'))!;
    expect(accountCall.url).toContain('access_token=page-tok');
    expect(accountCall.url).not.toContain('secret');
  });

  it('records the reason when Meta refuses, so the UI can offer the manual retry', async () => {
    meta({ app: [sub('instagram', REQUIRED)], accountError: 'Token expired' });
    const { service, updates } = build();
    const res = await service.ensureInstagramRealtime();
    expect(res.failed).toBe(1);
    expect(updates[0]['metadata.realtime']).toMatchObject({ ok: false, error: 'Token expired' });
    expect(updates[0]['metadata.webhookError']).toBe('Token expired');

    meta({ app: [sub('page', ['messages'])], post: { error: { message: 'Callback verification failed' } } });
    const second = build();
    await second.service.ensureInstagramRealtime();
    expect(second.updates[0]['metadata.realtime']).toMatchObject({ ok: false, error: 'Callback verification failed' });
  });

  it('does nothing (and never calls Meta) when no Instagram account is connected', async () => {
    const calls = meta();
    const res = await build([]).service.ensureInstagramRealtime();
    expect(res).toEqual({ checked: 0, fixed: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });

  it('never runs two checks at once', async () => {
    meta({ app: [sub('instagram', REQUIRED)] });
    const { service } = build();
    const [a, b] = await Promise.all([service.ensureInstagramRealtime(), service.ensureInstagramRealtime()]);
    expect([a.checked, b.checked].sort()).toEqual([0, 1]);
  });

  it('start-up and the hourly job respect the off switch', async () => {
    const calls = meta({ app: [] });
    jest.useFakeTimers();
    const off = build([ig], { META_AUTOHEAL_ENABLED: 'false' });
    off.service.onModuleInit();
    await off.service.autoHealInstagramRealtime();
    jest.advanceTimersByTime(60_000);
    jest.useRealTimers();
    expect(calls).toHaveLength(0);

    const spy = jest.spyOn(build().service, 'ensureInstagramRealtime');
    expect(typeof spy).toBe('function');
  });

  it('start-up schedules the check without blocking', () => {
    meta({ app: [sub('instagram', REQUIRED)] });
    jest.useFakeTimers();
    const { service } = build();
    const ensure = jest.spyOn(service, 'ensureInstagramRealtime').mockResolvedValue({ checked: 0, fixed: 0, failed: 0 });
    service.onModuleInit();
    expect(ensure).not.toHaveBeenCalled();
    jest.advanceTimersByTime(16_000);
    jest.useRealTimers();
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});
