import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { MembershipsService } from './memberships.service';
import { AccountRole, MembershipStatus } from './entities/account-member.entity';
import { UserRole } from '../users/entities/user.entity';

describe('MembershipsService legacy backfill', () => {
  const tenantId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();

  let accountMemberModel: any;
  let workspaceMemberModel: any;
  let userModel: any;
  let workspaceModel: any;
  let service: MembershipsService;

  const build = (opts: { user?: any; existingRecord?: boolean; hasOwner?: boolean } = {}) => {
    const created: any[] = [];
    accountMemberModel = {
      findOne: jest.fn().mockImplementation(() => Promise.resolve(created[0] ?? null)),
      exists: jest.fn().mockImplementation((q: any) => {
        if (q.role === AccountRole.OWNER) return Promise.resolve(opts.hasOwner ? { _id: 1 } : null);
        return Promise.resolve(opts.existingRecord ? { _id: 1 } : null);
      }),
      findOneAndUpdate: jest.fn().mockImplementation((_q: any, update: any) => {
        const doc = { role: update.$set.role, status: MembershipStatus.ACTIVE };
        created.push(doc);
        return Promise.resolve(doc);
      }),
    };
    workspaceMemberModel = { findOneAndUpdate: jest.fn().mockResolvedValue({}) };
    userModel = { findOne: jest.fn().mockResolvedValue(opts.user ?? null) };
    workspaceModel = {
      find: jest.fn().mockReturnValue({ select: () => Promise.resolve([{ _id: new Types.ObjectId() }]) }),
    };
    service = new MembershipsService(accountMemberModel, workspaceMemberModel, userModel, workspaceModel);
  };

  it('creates an OWNER membership for the first legacy admin', async () => {
    build({ user: { role: UserRole.ADMIN } });
    const member = await service.assertCanManageAccount(tenantId, userId);
    expect(member.role).toBe(AccountRole.OWNER);
  });

  it('creates an ADMIN membership when the tenant already has an owner', async () => {
    build({ user: { role: UserRole.ADMIN }, hasOwner: true });
    const member = await service.assertCanManageAccount(tenantId, userId);
    expect(member.role).toBe(AccountRole.ADMIN);
  });

  it('backfills agents but they still cannot manage the account; workspace access is restored', async () => {
    build({ user: { role: UserRole.AGENT } });
    await expect(service.assertCanManageAccount(tenantId, userId)).rejects.toBeInstanceOf(ForbiddenException);
    expect(workspaceMemberModel.findOneAndUpdate).toHaveBeenCalled();
  });

  it('does not grant membership to a user outside the tenant', async () => {
    build({ user: null });
    await expect(service.assertCanManageAccount(tenantId, userId)).rejects.toBeInstanceOf(NotFoundException);
    expect(accountMemberModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not override an existing suspended/invited membership', async () => {
    build({ user: { role: UserRole.ADMIN }, existingRecord: true });
    await expect(service.assertCanManageAccount(tenantId, userId)).rejects.toBeInstanceOf(NotFoundException);
    expect(accountMemberModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
