import { EventEmitter2 } from '@nestjs/event-emitter';
import { AUTOMATION_EVENT } from '../../automations/automation-events';
import type { AutomationEventPayload } from '../../automations/automation-events';
import { AutomationTrigger } from '../../automations/entities/automation.entity';
import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Lead, LeadDocument, LeadStatus } from '../entities/lead.entity';
import { Deal, DealDocument } from '../entities/deal.entity';
import { CreateLeadDto } from '../dto/create-lead.dto';
import { UpdateLeadDto } from '../dto/update-lead.dto';

@Injectable()
export class LeadsService {
  constructor(
    @InjectModel(Lead.name)
    private leadModel: Model<LeadDocument>,
    @InjectModel(Deal.name)
    private dealModel: Model<DealDocument>,
    private bus: EventEmitter2,
  ) {}

  async create(tenantId: string, createLeadDto: CreateLeadDto): Promise<Lead> {
    const lead = new this.leadModel({
      ...createLeadDto,
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: createLeadDto.workspaceId
        ? new Types.ObjectId(createLeadDto.workspaceId)
        : undefined,
      contactId: new Types.ObjectId(createLeadDto.contactId),
      assignedTo: createLeadDto.assignedTo
        ? new Types.ObjectId(createLeadDto.assignedTo)
        : undefined,
    });
    const saved = await lead.save();
    this.bus.emit(AUTOMATION_EVENT, {
      trigger: AutomationTrigger.LEAD_CREATED,
      tenantId,
      workspaceId: saved.workspaceId ? String(saved.workspaceId) : undefined,
      contactId: String(saved.contactId),
      leadId: String(saved._id),
    } as AutomationEventPayload);
    return saved;
  }

  async findAll(tenantId: string, workspaceId?: string): Promise<Lead[]> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    return this.leadModel
      .find(query)
      .populate('contactId')
      .populate('assignedTo', 'firstName lastName email')
      .exec();
  }

  async findOne(tenantId: string, id: string, workspaceId?: string): Promise<Lead> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const lead = await this.leadModel
      .findOne(query)
      .populate('contactId')
      .populate('assignedTo', 'firstName lastName email')
      .exec();
    if (!lead) {
      throw new NotFoundException(`Lead with ID ${id} not found`);
    }
    return lead;
  }

  async update(tenantId: string, id: string, updateLeadDto: UpdateLeadDto, workspaceId?: string): Promise<Lead> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const updateData: any = { ...updateLeadDto };
    if (updateLeadDto.workspaceId) updateData.workspaceId = new Types.ObjectId(updateLeadDto.workspaceId);
    if (updateLeadDto.contactId) updateData.contactId = new Types.ObjectId(updateLeadDto.contactId);
    if (updateLeadDto.assignedTo) updateData.assignedTo = new Types.ObjectId(updateLeadDto.assignedTo);
    updateData.lastActivityAt = new Date();

    const lead = await this.leadModel
      .findOneAndUpdate(
        query,
        updateData,
        { returnDocument: 'after' },
      )
      .populate('contactId')
      .exec();
    if (!lead) {
      throw new NotFoundException(`Lead with ID ${id} not found`);
    }
    return lead;
  }

  async remove(tenantId: string, id: string, workspaceId?: string): Promise<void> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const result = await this.leadModel
      .findOneAndDelete(query)
      .exec();
    if (!result) {
      throw new NotFoundException(`Lead with ID ${id} not found`);
    }
  }

  async bulkDelete(tenantId: string, ids: string[], workspaceId?: string): Promise<{ deleted: number }> {
    const query: any = {
      _id: { $in: ids.map(id => new Types.ObjectId(id)) },
      tenantId: new Types.ObjectId(tenantId),
    };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const result = await this.leadModel.deleteMany(query);
    return { deleted: result.deletedCount };
  }

  async convertToDeal(tenantId: string, id: string, workspaceId?: string): Promise<Deal> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const lead = await this.leadModel
      .findOne(query)
      .exec();
    if (!lead) {
      throw new NotFoundException(`Lead with ID ${id} not found`);
    }

    // Converting twice would duplicate the deal
    const already = await this.dealModel.findOne({ tenantId: new Types.ObjectId(tenantId), leadId: lead._id });
    if (already) return already;

    const deal = new this.dealModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: lead.workspaceId,
      contactId: lead.contactId,
      leadId: lead._id,
      title: lead.title,
      description: lead.description,
      value: lead.estimatedValue || 0,
      currency: lead.currency || 'USD',
      stage: 'new_lead',
      assignedTo: lead.assignedTo,
      expectedCloseDate: lead.expectedCloseDate,
      tags: lead.tags,
      notes: lead.notes,
    });
    await deal.save();

    // Mark lead as converted
    lead.status = LeadStatus.CONVERTED;
    lead.lastActivityAt = new Date();
    await lead.save();

    return deal;
  }
}
