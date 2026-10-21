import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Automation, AutomationDocument, AutomationTrigger } from './entities/automation.entity';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';

@Injectable()
export class AutomationsService {
  constructor(
    @InjectModel(Automation.name)
    private automationModel: Model<AutomationDocument>,
  ) {}

  async create(tenantId: string, dto: CreateAutomationDto): Promise<Automation> {
    const automation = new this.automationModel({
      ...dto,
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: dto.workspaceId ? new Types.ObjectId(dto.workspaceId) : undefined,
    });
    return automation.save();
  }

  async findAll(tenantId: string, workspaceId?: string): Promise<Automation[]> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    return this.automationModel
      .find(query)
      .exec();
  }

  async findOne(tenantId: string, id: string, workspaceId?: string): Promise<Automation> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const automation = await this.automationModel
      .findOne(query)
      .exec();
    if (!automation) {
      throw new NotFoundException(`Automation with ID ${id} not found`);
    }
    return automation;
  }

  async update(tenantId: string, id: string, dto: UpdateAutomationDto, workspaceId?: string): Promise<Automation> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const updateData: any = { ...dto };
    if (dto.workspaceId) updateData.workspaceId = new Types.ObjectId(dto.workspaceId);

    const automation = await this.automationModel
      .findOneAndUpdate(
        query,
        updateData,
        { returnDocument: 'after' },
      )
      .exec();
    if (!automation) {
      throw new NotFoundException(`Automation with ID ${id} not found`);
    }
    return automation;
  }

  async remove(tenantId: string, id: string, workspaceId?: string): Promise<void> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const result = await this.automationModel
      .findOneAndDelete(query)
      .exec();
    if (!result) {
      throw new NotFoundException(`Automation with ID ${id} not found`);
    }
  }

  async findByTrigger(tenantId: string, trigger: AutomationTrigger, workspaceId?: string): Promise<Automation[]> {
    const query: any = {
      tenantId: new Types.ObjectId(tenantId),
      trigger,
      isActive: true,
    };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    return this.automationModel
      .find(query)
      .exec();
  }

  async incrementExecutionCount(id: string): Promise<void> {
    await this.automationModel.findByIdAndUpdate(id, {
      $inc: { executionCount: 1 },
      lastExecutedAt: new Date(),
    });
  }
}
