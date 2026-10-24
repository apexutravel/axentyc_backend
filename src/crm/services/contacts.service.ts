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
import { Contact, ContactDocument } from '../entities/contact.entity';
import { CSV_COLUMNS, isEmail, normalizeEmail, normalizePhone, toCsv } from './contacts-csv';
import { ContactSource } from '../entities/contact.entity';
import { CreateContactDto } from '../dto/create-contact.dto';
import { UpdateContactDto } from '../dto/update-contact.dto';

@Injectable()
export class ContactsService {
  constructor(
    @InjectModel(Contact.name)
    private contactModel: Model<ContactDocument>,
    private bus: EventEmitter2,
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
    const saved = await contact.save();
    this.bus.emit(AUTOMATION_EVENT, {
      trigger: AutomationTrigger.CONTACT_CREATED,
      tenantId,
      workspaceId: saved.workspaceId ? String(saved.workspaceId) : undefined,
      contactId: String(saved._id),
    } as AutomationEventPayload);
    return saved;
  }

  async exportCsv(tenantId: string, workspaceId?: string): Promise<string> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);
    const contacts = await this.contactModel.find(query).sort({ createdAt: -1 }).limit(50000).lean();
    return toCsv(
      contacts.map((c: any) => ({
        name: c.name,
        email: c.email,
        phone: c.phone,
        company: c.company,
        tags: (c.tags || []).join(';'),
        notes: c.notes,
        source: c.source,
        createdAt: c.createdAt?.toISOString?.(),
      })),
    );
  }

  /** Creates contacts from parsed CSV rows. Existing email / phone in the workspace are skipped, never overwritten. */
  async importRows(
    tenantId: string,
    workspaceId: string | undefined,
    rows: Record<string, any>[],
  ): Promise<{ created: number; skippedDuplicates: number; invalid: { row: number; reason: string }[] }> {
    const scope: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) scope.workspaceId = new Types.ObjectId(workspaceId);

    const existing = await this.contactModel.find(scope).select('email phone').lean();
    const emails = new Set(existing.map((c: any) => normalizeEmail(c.email)).filter(Boolean));
    const phones = new Set(existing.map((c: any) => normalizePhone(c.phone)).filter(Boolean));

    const toInsert: any[] = [];
    const invalid: { row: number; reason: string }[] = [];
    let skippedDuplicates = 0;

    rows.forEach((raw, i) => {
      const rowNo = i + 2; // +1 header, +1 human numbering
      const email = normalizeEmail(String(raw.email ?? ''));
      const phone = String(raw.phone ?? '').trim();
      const phoneKey = normalizePhone(phone);
      const name = String(raw.name ?? '').trim() || email || phone;

      if (!name) return invalid.push({ row: rowNo, reason: 'Sin nombre, email ni teléfono' });
      if (email && !isEmail(email)) return invalid.push({ row: rowNo, reason: `Email inválido: ${email}` });
      if (phone && phoneKey.length < 7) return invalid.push({ row: rowNo, reason: `Teléfono inválido: ${phone}` });
      if ((email && emails.has(email)) || (phoneKey && phones.has(phoneKey))) {
        skippedDuplicates++;
        return;
      }
      if (email) emails.add(email);
      if (phoneKey) phones.add(phoneKey);

      toInsert.push({
        ...scope,
        name: name.slice(0, 200),
        email: email || undefined,
        phone: phone ? phone.slice(0, 40) : undefined,
        company: String(raw.company ?? '').trim().slice(0, 200) || undefined,
        notes: String(raw.notes ?? '').trim().slice(0, 5000) || undefined,
        tags: String(raw.tags ?? '').split(/[;,]/).map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20),
        source: ContactSource.IMPORT,
      });
    });

    if (toInsert.length) await this.contactModel.insertMany(toInsert, { ordered: false });
    return { created: toInsert.length, skippedDuplicates, invalid: invalid.slice(0, 100) };
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
