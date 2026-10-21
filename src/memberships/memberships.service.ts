import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AccountMember, AccountMemberDocument, AccountRole, MembershipStatus } from './entities/account-member.entity';
import { WorkspaceMember, WorkspaceMemberDocument } from './entities/workspace-member.entity';
import { User, UserDocument, UserRole } from '../users/entities/user.entity';
import { Workspace, WorkspaceDocument } from '../workspaces/entities/workspace.entity';

@Injectable()
export class MembershipsService {
  constructor(
    @InjectModel(AccountMember.name)
    private accountMemberModel: Model<AccountMemberDocument>,
    @InjectModel(WorkspaceMember.name)
    private workspaceMemberModel: Model<WorkspaceMemberDocument>,
    @InjectModel(User.name)
    private userModel: Model<UserDocument>,
    @InjectModel(Workspace.name)
    private workspaceModel: Model<WorkspaceDocument>,
  ) {}

  /**
   * Self-healing for users created before memberships existed: if the user belongs to the tenant
   * through the legacy `user.tenantId` field but has no AccountMember, create it from their role.
   * Never grants access to a tenant the user does not legitimately belong to.
   */
  private async backfillLegacyMember(tenantId: string, userId: string): Promise<AccountMember | null> {
    if (!Types.ObjectId.isValid(tenantId) || !Types.ObjectId.isValid(userId)) return null;

    const user = await this.userModel.findOne({
      _id: new Types.ObjectId(userId),
      tenantId: new Types.ObjectId(tenantId),
      isActive: true,
    });
    if (!user) return null;

    let role: AccountRole;
    if (user.role === UserRole.ADMIN) {
      // The first admin of a legacy tenant becomes the owner; later admins stay admins
      const hasOwner = await this.accountMemberModel.exists({
        tenantId: new Types.ObjectId(tenantId),
        role: AccountRole.OWNER,
        status: MembershipStatus.ACTIVE,
      });
      role = hasOwner ? AccountRole.ADMIN : AccountRole.OWNER;
    } else if (user.role === UserRole.MANAGER) {
      role = AccountRole.MANAGER;
    } else {
      role = AccountRole.AGENT;
    }

    const member = await this.ensureAccountMember({ tenantId, userId, role });

    // Keep the previous behaviour for non-admins: access to the tenant's existing workspaces
    if (role !== AccountRole.OWNER && role !== AccountRole.ADMIN) {
      const workspaces = await this.workspaceModel.find({ tenantId: new Types.ObjectId(tenantId) }).select('_id');
      for (const ws of workspaces) {
        await this.setWorkspaceAccess({ tenantId, userId, workspaceId: ws._id.toString(), role });
      }
    }
    return member;
  }

  async ensureAccountMember(input: {
    tenantId: string;
    userId: string;
    role: AccountRole;
    invitedBy?: string;
  }): Promise<AccountMember> {
    const update: any = {
      role: input.role,
      status: MembershipStatus.ACTIVE,
      joinedAt: new Date(),
    };

    if (input.invitedBy) {
      update.invitedBy = new Types.ObjectId(input.invitedBy);
    }

    return this.accountMemberModel.findOneAndUpdate(
      {
        tenantId: new Types.ObjectId(input.tenantId),
        userId: new Types.ObjectId(input.userId),
      },
      {
        $set: update,
        $setOnInsert: {
          tenantId: new Types.ObjectId(input.tenantId),
          userId: new Types.ObjectId(input.userId),
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
  }

  async setWorkspaceAccess(input: {
    tenantId: string;
    workspaceId: string;
    userId: string;
    role: AccountRole;
    permissions?: string[];
  }): Promise<WorkspaceMember> {
    return this.workspaceMemberModel.findOneAndUpdate(
      {
        workspaceId: new Types.ObjectId(input.workspaceId),
        userId: new Types.ObjectId(input.userId),
      },
      {
        $set: {
          tenantId: new Types.ObjectId(input.tenantId),
          workspaceId: new Types.ObjectId(input.workspaceId),
          userId: new Types.ObjectId(input.userId),
          role: input.role,
          permissions: input.permissions || [],
          status: MembershipStatus.ACTIVE,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
  }

  async findAccountsForUser(userId: string): Promise<AccountMember[]> {
    return this.accountMemberModel
      .find({ userId: new Types.ObjectId(userId), status: MembershipStatus.ACTIVE })
      .populate('tenantId', 'name slug plan status')
      .sort({ createdAt: 1 })
      .exec();
  }

  async findActiveAccountMember(tenantId: string, userId: string): Promise<AccountMember> {
    let member: AccountMember | null = await this.accountMemberModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      status: MembershipStatus.ACTIVE,
    });

    if (!member) {
      const exists = await this.accountMemberModel.exists({
        tenantId: new Types.ObjectId(tenantId),
        userId: new Types.ObjectId(userId),
      });
      // Only backfill when there is no record at all (do not override suspended/invited members)
      if (!exists) {
        member = await this.backfillLegacyMember(tenantId, userId);
      }
    }

    if (!member) {
      throw new NotFoundException('Account membership not found');
    }

    return member;
  }

  async assertCanManageAccount(tenantId: string, userId: string): Promise<AccountMember> {
    const member = await this.findActiveAccountMember(tenantId, userId);

    if (![AccountRole.OWNER, AccountRole.ADMIN].includes(member.role)) {
      throw new ForbiddenException('Only account owners and admins can manage this account');
    }

    return member;
  }

  async assertCanAccessWorkspace(tenantId: string, userId: string, workspaceId?: string): Promise<void> {
    const member = await this.findActiveAccountMember(tenantId, userId);

    if ([AccountRole.OWNER, AccountRole.ADMIN].includes(member.role)) {
      return;
    }

    if (!workspaceId) {
      throw new ForbiddenException('Workspace access is required for this action');
    }

    const workspaceMember = await this.workspaceMemberModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: new Types.ObjectId(workspaceId),
      userId: new Types.ObjectId(userId),
      status: MembershipStatus.ACTIVE,
    });

    if (!workspaceMember) {
      throw new ForbiddenException('You do not have access to this workspace');
    }
  }

  async findAccountMembers(tenantId: string): Promise<AccountMember[]> {
    return this.accountMemberModel
      .find({ tenantId: new Types.ObjectId(tenantId), status: MembershipStatus.ACTIVE })
      .populate('userId', 'email firstName lastName avatar isActive')
      .sort({ createdAt: 1 })
      .exec();
  }

  async findWorkspaceAccessForUser(tenantId: string, userId: string): Promise<WorkspaceMember[]> {
    return this.workspaceMemberModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        userId: new Types.ObjectId(userId),
        status: MembershipStatus.ACTIVE,
      })
      .populate('workspaceId', 'name slug type color icon isActive')
      .sort({ createdAt: 1 })
      .exec();
  }

  async findWorkspaceMembers(tenantId: string, workspaceId?: string): Promise<WorkspaceMember[]> {
    const query: any = {
      tenantId: new Types.ObjectId(tenantId),
      status: MembershipStatus.ACTIVE,
    };

    if (workspaceId) {
      query.workspaceId = new Types.ObjectId(workspaceId);
    }

    return this.workspaceMemberModel
      .find(query)
      .populate('userId', 'email firstName lastName avatar isActive')
      .populate('workspaceId', 'name slug type color icon isActive')
      .sort({ createdAt: 1 })
      .exec();
  }

  async revokeWorkspaceAccess(tenantId: string, workspaceId: string, userId: string): Promise<void> {
    const result = await this.workspaceMemberModel.findOneAndUpdate(
      {
        tenantId: new Types.ObjectId(tenantId),
        workspaceId: new Types.ObjectId(workspaceId),
        userId: new Types.ObjectId(userId),
        status: MembershipStatus.ACTIVE,
      },
      { $set: { status: MembershipStatus.SUSPENDED } },
    );

    if (!result) {
      throw new NotFoundException('Workspace access not found');
    }
  }
}
