import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { WorkspacesService } from './workspaces.service';

/** Route groups whose data lives inside a workspace (a company). */
export const WORKSPACE_SCOPED_SEGMENTS = new Set([
  'contacts',
  'leads',
  'deals',
  'conversations',
  'automations',
  'chat-widget',
  'emails',
  'integrations',
]);

/** Returns the first path segment after the global prefix, e.g. `/api/v1/contacts/123` -> `contacts`. */
export function scopedSegment(url: string, prefix: string): string | null {
  const path = (url || '').split('?')[0].replace(/^\/+/, '');
  const clean = prefix.replace(/^\/+|\/+$/g, '');
  const rest = clean && path.startsWith(clean + '/') ? path.slice(clean.length + 1) : path;
  const segment = rest.split('/')[0];
  return WORKSPACE_SCOPED_SEGMENTS.has(segment) ? segment : null;
}

/**
 * Makes the workspace mandatory for company data. Without it, an optional `workspaceId` silently
 * widened queries to the whole account. Runs after the JWT guard (see AppModule provider order).
 */
@Injectable()
export class WorkspaceScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly workspacesService: WorkspacesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const prefix = process.env.API_PREFIX || 'api/v1';
    if (!scopedSegment(req.originalUrl || req.url, prefix)) return true;

    const user = req.user;
    if (!user) throw new UnauthorizedException();

    const workspaceId = (req.query?.workspaceId as string) || req.body?.workspaceId;
    await this.workspacesService.assertUsable(user.tenantId, user._id || user.sub, workspaceId);
    return true;
  }
}
