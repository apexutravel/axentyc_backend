import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { WorkspaceScopeGuard, scopedSegment } from './workspace-scope.guard';

const ctx = (req: any, isPublic = false) =>
  ({
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
    __public: isPublic,
  }) as any;

describe('scopedSegment', () => {
  it('detects workspace scoped routes behind the global prefix', () => {
    expect(scopedSegment('/api/v1/contacts/123?workspaceId=x', 'api/v1')).toBe('contacts');
    expect(scopedSegment('/api/v1/integrations/email/accounts', 'api/v1')).toBe('integrations');
    expect(scopedSegment('/api/v1/chat-widget', 'api/v1')).toBe('chat-widget');
  });

  it('ignores account level routes', () => {
    for (const url of ['/api/v1/auth/login', '/api/v1/workspaces', '/api/v1/billing/subscription', '/api/v1/memberships/me/accounts', '/api/v1/users', '/api/v1/webhook/facebook']) {
      expect(scopedSegment(url, 'api/v1')).toBeNull();
    }
  });
});

describe('WorkspaceScopeGuard', () => {
  let service: { assertUsable: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: WorkspaceScopeGuard;
  const user = { tenantId: 't1', _id: 'u1' };

  beforeEach(() => {
    service = { assertUsable: jest.fn().mockResolvedValue(undefined) };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    guard = new WorkspaceScopeGuard(reflector as any, service as any);
  });

  it('lets public routes through', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(guard.canActivate(ctx({ originalUrl: '/api/v1/chat-widget/public/x' }))).resolves.toBe(true);
    expect(service.assertUsable).not.toHaveBeenCalled();
  });

  it('does not require a workspace on account level routes', async () => {
    await expect(guard.canActivate(ctx({ originalUrl: '/api/v1/billing/subscription', user }))).resolves.toBe(true);
    expect(service.assertUsable).not.toHaveBeenCalled();
  });

  it('validates the workspace from the query string', async () => {
    await guard.canActivate(ctx({ originalUrl: '/api/v1/contacts?workspaceId=w1', query: { workspaceId: 'w1' }, user }));
    expect(service.assertUsable).toHaveBeenCalledWith('t1', 'u1', 'w1');
  });

  it('validates the workspace from the body', async () => {
    await guard.canActivate(ctx({ originalUrl: '/api/v1/emails/send', query: {}, body: { workspaceId: 'w2' }, user }));
    expect(service.assertUsable).toHaveBeenCalledWith('t1', 'u1', 'w2');
  });

  it('rejects a scoped request without workspace', async () => {
    service.assertUsable.mockRejectedValue(new ForbiddenException({ code: 'WORKSPACE_REQUIRED' }));
    await expect(guard.canActivate(ctx({ originalUrl: '/api/v1/leads', query: {}, body: {}, user }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.assertUsable).toHaveBeenCalledWith('t1', 'u1', undefined);
  });

  it('never trusts an unauthenticated request on scoped routes', async () => {
    await expect(guard.canActivate(ctx({ originalUrl: '/api/v1/contacts', query: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
