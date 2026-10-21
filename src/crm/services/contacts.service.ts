import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Contact, ContactDocument } from '../entities/contact.entity';
import { CreateContactDto } from '../dto/create-contact.dto';
import { UpdateContactDto } from '../dto/update-contact.dto';

@Injectable()
export class ContactsService {
  constructor(
    @InjectModel(Contact.name)
    private contactModel: Model<ContactDocument>,
  ) {}

  async create(tenantId: string, createContactDto: CreateContactDto): Promise<Contact> {
    const contact = new this.contactModel({
      ...createContactDto,
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: createContactDto.workspaceId
        ? new Types.ObjectId(createContactDto.workspaceId)
        : undefined,
      assignedTo: createContactDto.assignedTo
        ? new Types.ObjectId(createContactDto.assignedTo)
        : undefined,
    });
    return contact.save();
  }

  async findAll(tenantId: string, workspaceId?: string): Promise<Contact[]> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    return this.contactModel.find(query).exec();
  }

  async findOne(tenantId: string, id: string, workspaceId?: string): Promise<Contact> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const contact = await this.contactModel
      .findOne(query)
      .exec();
    if (!contact) {
      throw new NotFoundException(`Contact with ID ${id} not found`);
    }
    return contact;
  }

  async findByEmail(tenantId: string, email: string): Promise<Contact | null> {
    return this.contactModel
      .findOne({ tenantId: new Types.ObjectId(tenantId), email })
      .exec();
  }

  async update(tenantId: string, id: string, updateContactDto: UpdateContactDto, workspaceId?: string): Promise<Contact> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const contact = await this.contactModel
      .findOneAndUpdate(
        query,
        {
          ...updateContactDto,
          workspaceId: updateContactDto.workspaceId
            ? new Types.ObjectId(updateContactDto.workspaceId)
            : undefined,
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!contact) {
      throw new NotFoundException(`Contact with ID ${id} not found`);
    }
    return contact;
  }

  async remove(tenantId: string, id: string, workspaceId?: string): Promise<void> {
    const query: any = { _id: id, tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const result = await this.contactModel
      .findOneAndDelete(query)
      .exec();
    if (!result) {
      throw new NotFoundException(`Contact with ID ${id} not found`);
    }
  }

  async bulkDelete(tenantId: string, ids: string[], workspaceId?: string): Promise<{ deletedCount: number }> {
    const query: any = {
      _id: { $in: ids.map(id => new Types.ObjectId(id)) },
      tenantId: new Types.ObjectId(tenantId),
    };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const result = await this.contactModel
      .deleteMany(query)
      .exec();
    return { deletedCount: result.deletedCount };
  }
}
