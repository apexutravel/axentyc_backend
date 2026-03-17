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
  ) {}

  async create(tenantId: string, createLeadDto: CreateLeadDto): Promise<Lead> {
    const lead = new this.leadModel({
      ...createLeadDto,
      tenantId: new Types.ObjectId(tenantId),
      contactId: new Types.ObjectId(createLeadDto.contactId),
      assignedTo: createLeadDto.assignedTo
        ? new Types.ObjectId(createLeadDto.assignedTo)
        : undefined,
    });
    return lead.save();
  }

  async findAll(tenantId: string): Promise<Lead[]> {
    return this.leadModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .populate('contactId')
      .populate('assignedTo', 'firstName lastName email')
      .exec();
  }

  async findOne(tenantId: string, id: string): Promise<Lead> {
    const lead = await this.leadModel
      .findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) })
      .populate('contactId')
      .populate('assignedTo', 'firstName lastName email')
      .exec();
    if (!lead) {
      throw new NotFoundException(`Lead with ID ${id} not found`);
    }
    return lead;
  }

  async update(tenantId: string, id: string, updateLeadDto: UpdateLeadDto): Promise<Lead> {
    const updateData: any = { ...updateLeadDto };
    if (updateLeadDto.contactId) updateData.contactId = new Types.ObjectId(updateLeadDto.contactId);
    if (updateLeadDto.assignedTo) updateData.assignedTo = new Types.ObjectId(updateLeadDto.assignedTo);
    updateData.lastActivityAt = new Date();

    const lead = await this.leadModel
      .findOneAndUpdate(
        { _id: id, tenantId: new Types.ObjectId(tenantId) },
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

  async remove(tenantId: string, id: string): Promise<void> {
    const result = await this.leadModel
      .findOneAndDelete({ _id: id, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!result) {
      throw new NotFoundException(`Lead with ID ${id} not found`);
    }
  }

  async bulkDelete(tenantId: string, ids: string[]): Promise<{ deleted: number }> {
    const result = await this.leadModel.deleteMany({
      _id: { $in: ids.map(id => new Types.ObjectId(id)) },
      tenantId: new Types.ObjectId(tenantId),
    });
    return { deleted: result.deletedCount };
  }

  async convertToDeal(tenantId: string, id: string): Promise<Deal> {
    const lead = await this.leadModel
      .findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!lead) {
      throw new NotFoundException(`Lead with ID ${id} not found`);
    }

    const deal = new this.dealModel({
      tenantId: new Types.ObjectId(tenantId),
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
