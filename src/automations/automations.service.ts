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
    });
    return automation.save();
  }

  async findAll(tenantId: string): Promise<Automation[]> {
    return this.automationModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .exec();
  }

  async findOne(tenantId: string, id: string): Promise<Automation> {
    const automation = await this.automationModel
      .findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!automation) {
      throw new NotFoundException(`Automation with ID ${id} not found`);
    }
    return automation;
  }

  async update(tenantId: string, id: string, dto: UpdateAutomationDto): Promise<Automation> {
    const automation = await this.automationModel
      .findOneAndUpdate(
        { _id: id, tenantId: new Types.ObjectId(tenantId) },
        dto,
        { returnDocument: 'after' },
      )
      .exec();
    if (!automation) {
      throw new NotFoundException(`Automation with ID ${id} not found`);
    }
    return automation;
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const result = await this.automationModel
      .findOneAndDelete({ _id: id, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!result) {
      throw new NotFoundException(`Automation with ID ${id} not found`);
    }
  }

  async findByTrigger(tenantId: string, trigger: AutomationTrigger): Promise<Automation[]> {
    return this.automationModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        trigger,
        isActive: true,
      })
      .exec();
  }

  async incrementExecutionCount(id: string): Promise<void> {
    await this.automationModel.findByIdAndUpdate(id, {
      $inc: { executionCount: 1 },
      lastExecutedAt: new Date(),
    });
  }
}
