import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { WorkspacesService } from './workspaces.service';
import { AccountRole } from '../memberships/entities/account-member.entity';

describe('WorkspacesService access rules', () => {
  const tenantId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const w1 = { _id: new Types.ObjectId(), name: 'A' };
  const w2 = { _id: new Types.ObjectId(), name: 'B' };

  let workspaceModel: any;
  let memberships: any;
  let service: WorkspacesService;

  const build = (opts: { workspace?: any; role?: AccountRole; access?: any[] } = {}) => {
    workspaceModel = {
      findOne: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve(opts.workspace ?? null) }) }),
      find: jest.fn().mockReturnValue({ sort: () => ({ exec: () => Promise.resolve([w1, w2]) }) }),
    };
    memberships = {
      assertCanAccessWorkspace: jest.fn().mockResolvedValue(undefined),
      findActiveAccountMember: jest.fn().mockResolvedValue({ role: opts.role ?? AccountRole.OWNER }),
      findWorkspaceAccessForUser: jest.fn().mockResolvedValue(opts.access ?? []),
    };
    const Ctor: any = WorkspacesService;
    service = new Ctor(workspaceModel, ...Array(10).fill({}), {}, memberships);
  };

  const code = async (p: Promise<any>) => {
    try { await p; return 'ok'; } catch (e: any) { return e.getResponse?.().code; }
  };

  it('requires a workspace id', async () => {
    build();
    expect(await code(service.assertUsable(tenantId, userId, undefined))).toBe('WORKSPACE_REQUIRED');
    expect(await code(service.assertUsable(tenantId, userId, 'not-an-id'))).toBe('WORKSPACE_REQUIRED');
  });

  it('rejects a workspace that does not exist / is inactive / belongs to another account', async () => {
    build({ workspace: null });
    expect(await code(service.assertUsable(tenantId, userId, w1._id.toString()))).toBe('WORKSPACE_REQUIRED');
    const filter = workspaceModel.findOne.mock.calls[0][0];
    expect(filter.isActive).toBe(true);
    expect(String(filter.tenantId)).toBe(tenantId);
  });

  it('rejects members without access to the workspace', async () => {
    build({ workspace: w1 });
    memberships.assertCanAccessWorkspace.mockRejectedValue(new ForbiddenException('no'));
    expect(await code(service.assertUsable(tenantId, userId, w1._id.toString()))).toBe('WORKSPACE_FORBIDDEN');
  });

  it('accepts a valid workspace', async () => {
    build({ workspace: w1 });
    expect(await code(service.assertUsable(tenantId, userId, w1._id.toString()))).toBe('ok');
  });

  it('owners see every workspace', async () => {
    build({ role: AccountRole.OWNER });
    expect(await service.findAccessible(tenantId, userId)).toHaveLength(2);
  });

  it('agents only see the workspaces they were added to', async () => {
    build({ role: AccountRole.AGENT, access: [{ workspaceId: { _id: w2._id } }] });
    const list: any[] = await service.findAccessible(tenantId, userId);
    expect(list.map((w) => w.name)).toEqual(['B']);
  });

  it('agents with no assigned workspace see none', async () => {
    build({ role: AccountRole.AGENT, access: [] });
    expect(await service.findAccessible(tenantId, userId)).toEqual([]);
  });
});
