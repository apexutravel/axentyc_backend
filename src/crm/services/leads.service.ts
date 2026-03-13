import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Lead, LeadDocument } from '../entities/lead.entity';
import { CreateLeadDto } from '../dto/create-lead.dto';
import { UpdateLeadDto } from '../dto/update-lead.dto';

@Injectable()
export class LeadsService {
  constructor(
    @InjectModel(Lead.name)
    private leadModel: Model<LeadDocument>,
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
}
