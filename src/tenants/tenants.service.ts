import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tenant, TenantDocument } from './entities/tenant.entity';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';

@Injectable()
export class TenantsService {
  constructor(
    @InjectModel(Tenant.name)
    private tenantModel: Model<TenantDocument>,
  ) {}

  async create(createTenantDto: CreateTenantDto): Promise<Tenant> {
    const existingTenant = await this.tenantModel.findOne({
      $or: [
        { slug: createTenantDto.slug },
        { name: createTenantDto.name },
      ],
    });

    if (existingTenant) {
      throw new ConflictException('Tenant with this name or slug already exists');
    }

    const tenant = new this.tenantModel({
      ...createTenantDto,
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days trial
    });

    return tenant.save();
  }

  async findAll(): Promise<Tenant[]> {
    return this.tenantModel.find().exec();
  }

  async findOne(id: string): Promise<Tenant> {
    const tenant = await this.tenantModel.findById(id).exec();
    if (!tenant) {
      throw new NotFoundException(`Tenant with ID ${id} not found`);
    }
    return tenant;
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    return this.tenantModel.findOne({ slug }).exec();
  }

  async update(id: string, updateTenantDto: UpdateTenantDto): Promise<Tenant> {
    const tenant = await this.tenantModel
      .findByIdAndUpdate(id, updateTenantDto, { returnDocument: 'after' })
      .exec();

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID ${id} not found`);
    }

    return tenant;
  }

  async remove(id: string): Promise<void> {
    const result = await this.tenantModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Tenant with ID ${id} not found`);
    }
  }
}
