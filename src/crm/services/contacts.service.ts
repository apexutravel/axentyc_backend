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
      assignedTo: createContactDto.assignedTo
        ? new Types.ObjectId(createContactDto.assignedTo)
        : undefined,
    });
    return contact.save();
  }

  async findAll(tenantId: string): Promise<Contact[]> {
    return this.contactModel.find({ tenantId: new Types.ObjectId(tenantId) }).exec();
  }

  async findOne(tenantId: string, id: string): Promise<Contact> {
    const contact = await this.contactModel
      .findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) })
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

  async update(tenantId: string, id: string, updateContactDto: UpdateContactDto): Promise<Contact> {
    const contact = await this.contactModel
      .findOneAndUpdate(
        { _id: id, tenantId: new Types.ObjectId(tenantId) },
        updateContactDto,
        { returnDocument: 'after' },
      )
      .exec();
    if (!contact) {
      throw new NotFoundException(`Contact with ID ${id} not found`);
    }
    return contact;
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const result = await this.contactModel
      .findOneAndDelete({ _id: id, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!result) {
      throw new NotFoundException(`Contact with ID ${id} not found`);
    }
  }

  async bulkDelete(tenantId: string, ids: string[]): Promise<{ deletedCount: number }> {
    const result = await this.contactModel
      .deleteMany({
        _id: { $in: ids.map(id => new Types.ObjectId(id)) },
        tenantId: new Types.ObjectId(tenantId),
      })
      .exec();
    return { deletedCount: result.deletedCount };
  }
}
