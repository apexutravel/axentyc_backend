import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Workspace, WorkspaceDocument, WorkspaceType } from './entities/workspace.entity';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { Contact, ContactDocument } from '../crm/entities/contact.entity';
import { Lead, LeadDocument } from '../crm/entities/lead.entity';
import { Deal, DealDocument } from '../crm/entities/deal.entity';
import { Conversation, ConversationDocument } from '../conversations/entities/conversation.entity';
import { Message, MessageDocument } from '../conversations/entities/message.entity';
import { SocialAccount, SocialAccountDocument } from '../integrations/entities/social-account.entity';
import { EmailIntegration, EmailIntegrationDocument } from '../integrations/entities/email-integration.entity';
import { WidgetConfig, WidgetConfigDocument } from '../chat-widget/entities/widget-config.entity';
import { EmailMessage, EmailMessageDocument } from '../emails/entities/email-message.entity';
import { Automation, AutomationDocument } from '../automations/entities/automation.entity';
import { BillingService } from '../billing/billing.service';
import { MembershipsService } from '../memberships/memberships.service';
import { AccountRole } from '../memberships/entities/account-member.entity';

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';
}

@Injectable()
export class WorkspacesService implements OnModuleInit {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    @InjectModel(Workspace.name)
    private workspaceModel: Model<WorkspaceDocument>,
    @InjectModel(Contact.name)
    private contactModel: Model<ContactDocument>,
    @InjectModel(Lead.name)
    private leadModel: Model<LeadDocument>,
    @InjectModel(Deal.name)
    private dealModel: Model<DealDocument>,
    @InjectModel(Conversation.name)
    private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name)
    private messageModel: Model<MessageDocument>,
    @InjectModel(SocialAccount.name)
    private socialAccountModel: Model<SocialAccountDocument>,
    @InjectModel(EmailIntegration.name)
    private emailIntegrationModel: Model<EmailIntegrationDocument>,
    @InjectModel(WidgetConfig.name)
    private widgetConfigModel: Model<WidgetConfigDocument>,
    @InjectModel(EmailMessage.name)
    private emailMessageModel: Model<EmailMessageDocument>,
    @InjectModel(Automation.name)
    private automationModel: Model<AutomationDocument>,
    private billingService: BillingService,
    private membershipsService: MembershipsService,
  ) {}

  onModuleInit() {
    // Do not block start-up; repair legacy data once the app is running
    setTimeout(() => {
      this.repairWorkspaceData().catch((e) => this.logger.error(`Workspace data repair failed: ${e?.message || e}`));
    }, 8000);
  }

  async create(tenantId: string, dto: CreateWorkspaceDto): Promise<Workspace> {
    await this.billingService.assertCanCreateWorkspace(tenantId);

    const slug = dto.slug ? toSlug(dto.slug) : toSlug(dto.name);
    const existing = await this.workspaceModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      slug,
    });

    if (existing) {
      throw new ConflictException('Workspace with this slug already exists');
    }

    const workspace = new this.workspaceModel({
      ...dto,
      tenantId: new Types.ObjectId(tenantId),
      slug,
      type: dto.type || WorkspaceType.DEFAULT,
    });

    const hadActive = await this.workspaceModel.exists({
      tenantId: new Types.ObjectId(tenantId),
      isActive: true,
    });
    const saved = await workspace.save();

    // The first workspace of an account adopts the data created before workspaces existed
    if (!hadActive) {
      const adopted = await this.adoptOrphans(tenantId, saved._id as Types.ObjectId);
      this.logger.log(`First workspace "${saved.name}" of tenant ${tenantId} adopted ${JSON.stringify(adopted)}`);
    }
    return saved;
  }

  async createDefaultForTenant(tenantId: string, name: string): Promise<Workspace> {
    const existingDefault = await this.workspaceModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      slug: 'default',
    });

    if (existingDefault) return existingDefault;

    const workspace = new this.workspaceModel({
      tenantId: new Types.ObjectId(tenantId),
      name,
      slug: 'default',
      type: WorkspaceType.DEFAULT,
      isActive: true,
    });

    return workspace.save();
  }

  async findAllByTenant(tenantId: string): Promise<Workspace[]> {
    return this.workspaceModel
      .find({ tenantId: new Types.ObjectId(tenantId), isActive: true })
      .sort({ createdAt: 1 })
      .exec();
  }

  /** Active workspaces the user can open: owners/admins see all, others only those they were added to. */
  async findAccessible(tenantId: string, userId: string): Promise<Workspace[]> {
    const all = await this.findAllByTenant(tenantId);
    const member = await this.membershipsService.findActiveAccountMember(tenantId, userId);
    if ([AccountRole.OWNER, AccountRole.ADMIN].includes(member.role)) return all;

    const access = await this.membershipsService.findWorkspaceAccessForUser(tenantId, userId);
    const allowed = new Set(
      access.map((a: any) => (a.workspaceId?._id || a.workspaceId)?.toString()).filter(Boolean),
    );
    return all.filter((w: any) => allowed.has(w._id.toString()));
  }

  /**
   * Guard helper: the workspace must exist, be active, belong to the tenant and the user must have access.
   * Throws a 403 with code WORKSPACE_REQUIRED / WORKSPACE_FORBIDDEN so the client can react.
   */
  async assertUsable(tenantId: string, userId: string, workspaceId?: string): Promise<void> {
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      throw new ForbiddenException({ message: 'Select a workspace to continue', code: 'WORKSPACE_REQUIRED' });
    }
    const workspace = await this.workspaceModel
      .findOne({ _id: new Types.ObjectId(workspaceId), tenantId: new Types.ObjectId(tenantId), isActive: true })
      .select('_id')
      .lean();
    if (!workspace) {
      throw new ForbiddenException({ message: 'Workspace not found or inactive', code: 'WORKSPACE_REQUIRED' });
    }
    try {
      await this.membershipsService.assertCanAccessWorkspace(tenantId, userId, workspaceId);
    } catch {
      throw new ForbiddenException({ message: 'You do not have access to this workspace', code: 'WORKSPACE_FORBIDDEN' });
    }
  }

  async findOne(tenantId: string, id: string): Promise<Workspace> {
    const workspace = await this.workspaceModel.findOne({
      _id: id,
      tenantId: new Types.ObjectId(tenantId),
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    return workspace;
  }

  async update(tenantId: string, id: string, dto: UpdateWorkspaceDto): Promise<Workspace> {
    const updateData: any = { ...dto };
    if (dto.slug) updateData.slug = toSlug(dto.slug);

    const workspace = await this.workspaceModel.findOneAndUpdate(
      { _id: id, tenantId: new Types.ObjectId(tenantId) },
      updateData,
      { returnDocument: 'after' },
    );

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    return workspace;
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const workspace = await this.workspaceModel.findOneAndUpdate(
      { _id: id, tenantId: new Types.ObjectId(tenantId) },
      { isActive: false },
    );

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
  }

  async backfillDefaultWorkspace(tenantId: string): Promise<Record<string, number | string>> {
    const defaultWorkspace = await this.createDefaultForTenant(tenantId, 'Default');
    const workspaceId = (defaultWorkspace as any)._id;
    const tenantObjectId = new Types.ObjectId(tenantId);
    const missingWorkspaceFilter = {
      tenantId: tenantObjectId,
      $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }],
    };

    const [
      contacts,
      leads,
      deals,
      conversations,
      messages,
      socialAccounts,
      emailIntegrations,
      widgetConfigs,
      emailMessages,
      automations,
    ] = await Promise.all([
      this.contactModel.updateMany(missingWorkspaceFilter, { $set: { workspaceId } }),
      this.leadModel.updateMany(missingWorkspaceFilter, { $set: { workspaceId } }),
      this.dealModel.updateMany(missingWorkspaceFilter, { $set: { workspaceId } }),
      this.conversationModel.updateMany(missingWorkspaceFilter, { $set: { workspaceId } }),
      this.messageModel.updateMany(missingWorkspaceFilter, { $set: { workspaceId } }),
      this.socialAccountModel.updateMany(missingWorkspaceFilter, { $set: { workspaceId } }),
      this.emailIntegrationModel.updateMany(missingWorkspaceFilter, { $set: { workspaceId } }),
      this.widgetConfigModel.updateMany(missingWorkspaceFilter, { $set: { workspaceId } }),
      this.emailMessageModel.updateMany(missingWorkspaceFilter, { $set: { workspaceId } }),
      this.automationModel.updateMany(missingWorkspaceFilter, { $set: { workspaceId } }),
    ]);

    return {
      workspaceId: workspaceId.toString(),
      contacts: contacts.modifiedCount,
      leads: leads.modifiedCount,
      deals: deals.modifiedCount,
      conversations: conversations.modifiedCount,
      messages: messages.modifiedCount,
      socialAccounts: socialAccounts.modifiedCount,
      emailIntegrations: emailIntegrations.modifiedCount,
      widgetConfigs: widgetConfigs.modifiedCount,
      emailMessages: emailMessages.modifiedCount,
      automations: automations.modifiedCount,
    };
  }

  private readonly SCOPED_MODELS = () => [
    ['contacts', this.contactModel],
    ['leads', this.leadModel],
    ['deals', this.dealModel],
    ['conversations', this.conversationModel],
    ['messages', this.messageModel],
    ['socialAccounts', this.socialAccountModel],
    ['emailIntegrations', this.emailIntegrationModel],
    ['widgetConfigs', this.widgetConfigModel],
    ['emailMessages', this.emailMessageModel],
    ['automations', this.automationModel],
  ] as const;

  /**
   * Point records of a tenant that have NO workspace, or one that belongs to ANOTHER tenant,
   * to `workspaceId`. Records of the tenant's own (even deactivated) workspaces are left alone.
   */
  async adoptOrphans(tenantId: string, workspaceId: Types.ObjectId | string, dryRun = false): Promise<Record<string, number>> {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const target = new Types.ObjectId(workspaceId.toString());
    const own = await this.workspaceModel.find({ tenantId: tenantObjectId }).select('_id').lean();
    const ownIds = own.map((w) => w._id);

    const filter = {
      tenantId: tenantObjectId,
      $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }, { workspaceId: { $nin: ownIds } }],
    };

    const result: Record<string, number> = {};
    for (const [name, model] of this.SCOPED_MODELS()) {
      const m: any = model;
      if (name === 'emailMessages') continue; // handled below: they follow their mailbox
      result[name] = dryRun
        ? await m.countDocuments(filter)
        : (await m.updateMany(filter, { $set: { workspaceId: target } })).modifiedCount;
    }

    // Email messages follow the workspace of their mailbox; the rest go to the target workspace
    const mailboxes = await this.emailIntegrationModel.find({ tenantId: tenantObjectId }).select('_id workspaceId').lean();
    let emailCount = 0;
    for (const mb of mailboxes) {
      const f: any = { tenantId: tenantObjectId, integrationId: mb._id, workspaceId: { $ne: mb.workspaceId } };
      emailCount += dryRun
        ? await this.emailMessageModel.countDocuments(f)
        : (await this.emailMessageModel.updateMany(f, { $set: { workspaceId: mb.workspaceId } })).modifiedCount;
    }
    emailCount += dryRun
      ? await this.emailMessageModel.countDocuments({ ...filter, integrationId: null } as any)
      : (await this.emailMessageModel.updateMany({ ...filter, integrationId: null }, { $set: { workspaceId: target } })).modifiedCount;
    result.emailMessages = emailCount;
    return result;
  }

  /** Idempotent start-up repair: every tenant with an active workspace gets its orphan data attached to the oldest one. */
  async repairWorkspaceData(dryRun = false) {
    const firstByTenant = await this.workspaceModel.aggregate([
      { $match: { isActive: true } },
      { $sort: { createdAt: 1 } },
      { $group: { _id: '$tenantId', workspaceId: { $first: '$_id' } } },
    ]);

    const report: Record<string, Record<string, number>> = {};
    for (const row of firstByTenant) {
      const counts = await this.adoptOrphans(row._id.toString(), row.workspaceId, dryRun);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total > 0) {
        report[row._id.toString()] = counts;
        this.logger.log(`[Workspace repair] tenant ${row._id}: ${dryRun ? 'would fix' : 'fixed'} ${JSON.stringify(counts)}`);
      }
    }
    return report;
  }
}
