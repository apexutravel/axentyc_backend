import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Deal, DealDocument, DealStage } from '../entities/deal.entity';
import { CreateDealDto } from '../dto/create-deal.dto';
import { UpdateDealDto } from '../dto/update-deal.dto';

@Injectable()
export class DealsService {
  constructor(
    @InjectModel(Deal.name)
    private dealModel: Model<DealDocument>,
  ) {}

  async create(tenantId: string, createDealDto: CreateDealDto): Promise<Deal> {
    const deal = new this.dealModel({
      ...createDealDto,
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: createDealDto.workspaceId
        ? new Types.ObjectId(createDealDto.workspaceId)
        : undefined,
      contactId: new Types.ObjectId(createDealDto.contactId),
      leadId: createDealDto.leadId
        ? new Types.ObjectId(createDealDto.leadId)
        : undefined,
      assignedTo: createDealDto.assignedTo
        ? new Types.ObjectId(createDealDto.assignedTo)
        : undefined,
    });
    return deal.save();
  }

  async findAll(tenantId: string, workspaceId?: string): Promise<Deal[]> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    return this.dealModel
      .find(query)
      .populate('contactId')
      .populate('assignedTo', 'firstName lastName email')
      .exec();
  }

  async findByStage(tenantId: string, stage: DealStage, workspaceId?: string): Promise<Deal[]> {
    const query: any = { tenantId: new Types.ObjectId(tenantId), stage };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    return this.dealModel
      .find(query)
      .populate('contactId')
      .populate('assignedTo', 'firstName lastName email')
      .exec();
  }

  async findOne(tenantId: string, id: string, workspaceId?: string): Promise<Deal> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const deal = await this.dealModel
      .findOne(query)
      .populate('contactId')
      .populate('leadId')
      .populate('assignedTo', 'firstName lastName email')
      .exec();
    if (!deal) {
      throw new NotFoundException(`Deal with ID ${id} not found`);
    }
    return deal;
  }

  async update(tenantId: string, id: string, updateDealDto: UpdateDealDto, workspaceId?: string): Promise<Deal> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const updateData: any = { ...updateDealDto };
    if (updateDealDto.workspaceId) updateData.workspaceId = new Types.ObjectId(updateDealDto.workspaceId);
    if (updateDealDto.contactId) updateData.contactId = new Types.ObjectId(updateDealDto.contactId);
    if (updateDealDto.leadId) updateData.leadId = new Types.ObjectId(updateDealDto.leadId);
    if (updateDealDto.assignedTo) updateData.assignedTo = new Types.ObjectId(updateDealDto.assignedTo);

    if (updateDealDto.stage === DealStage.CLOSED_WON || updateDealDto.stage === DealStage.CLOSED_LOST) {
      updateData.actualCloseDate = new Date();
    }

    const deal = await this.dealModel
      .findOneAndUpdate(
        query,
        updateData,
        { returnDocument: 'after' },
      )
      .populate('contactId')
      .exec();
    if (!deal) {
      throw new NotFoundException(`Deal with ID ${id} not found`);
    }
    return deal;
  }

  async remove(tenantId: string, id: string, workspaceId?: string): Promise<void> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const result = await this.dealModel
      .findOneAndDelete(query)
      .exec();
    if (!result) {
      throw new NotFoundException(`Deal with ID ${id} not found`);
    }
  }

  async getPipelineSummary(tenantId: string, workspaceId?: string) {
    const match: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) match.workspaceId = new Types.ObjectId(workspaceId);

    return this.dealModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$stage',
          count: { $sum: 1 },
          totalValue: { $sum: '$value' },
        },
      },
      { $sort: { _id: 1 } },
    ]);
  }
}
