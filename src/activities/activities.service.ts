import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Task, TaskDocument, TaskStatus } from './entities/task.entity';
import { Note, NoteDocument } from './entities/note.entity';
import { QuickReply, QuickReplyDocument } from './entities/quick-reply.entity';
import { Contact, ContactDocument } from '../crm/entities/contact.entity';
import { Lead, LeadDocument } from '../crm/entities/lead.entity';
import { Deal, DealDocument } from '../crm/entities/deal.entity';
import { Conversation, ConversationDocument } from '../conversations/entities/conversation.entity';
import { SalesDocument, SalesDocumentDoc } from '../invoicing/entities/sales-document.entity';
import { EventsGateway } from '../events/events.gateway';
import { CreateNoteDto, CreateTaskDto, UpdateNoteDto, UpdateTaskDto, UpsertQuickReplyDto } from './dto/activities.dto';

const oid = (id?: string) => (id ? new Types.ObjectId(id) : undefined);
const clean = <T extends Record<string, any>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export interface TimelineItem {
  type: 'note' | 'task' | 'conversation' | 'lead' | 'deal' | 'quote' | 'invoice' | 'payment';
  at: Date;
  title: string;
  detail?: string;
  refId: string;
  meta?: Record<string, any>;
}

@Injectable()
export class ActivitiesService {
  private readonly logger = new Logger(ActivitiesService.name);

  constructor(
    @InjectModel(Task.name) private taskModel: Model<TaskDocument>,
    @InjectModel(Note.name) private noteModel: Model<NoteDocument>,
    @InjectModel(QuickReply.name) private quickReplyModel: Model<QuickReplyDocument>,
    @InjectModel(Contact.name) private contactModel: Model<ContactDocument>,
    @InjectModel(Lead.name) private leadModel: Model<LeadDocument>,
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
    @InjectModel(SalesDocument.name) private salesModel: Model<SalesDocumentDoc>,
    private readonly events: EventsGateway,
  ) {}

  private scope(tenantId: string, workspaceId?: string) {
    const q: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) q.workspaceId = new Types.ObjectId(workspaceId);
    return q;
  }

  // ─── Tasks ───

  async createTask(tenantId: string, userId: string, dto: CreateTaskDto, source: 'manual' | 'automation' = 'manual') {
    return this.taskModel.create({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: oid(dto.workspaceId),
      title: dto.title,
      description: dto.description,
      dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
      priority: dto.priority,
      assignedTo: oid(dto.assignedTo) ?? (source === 'manual' ? oid(userId) : undefined),
      createdBy: oid(userId),
      contactId: oid(dto.contactId),
      leadId: oid(dto.leadId),
      dealId: oid(dto.dealId),
      conversationId: oid(dto.conversationId),
      source,
    });
  }

  async listTasks(
    tenantId: string,
    workspaceId: string | undefined,
    f: { status?: string; mine?: boolean; userId?: string; contactId?: string; leadId?: string; dealId?: string; overdue?: boolean },
  ) {
    const q = this.scope(tenantId, workspaceId);
    if (f.status === 'open' || f.status === 'done') q.status = f.status;
    if (f.mine && f.userId) q.assignedTo = new Types.ObjectId(f.userId);
    if (f.contactId) q.contactId = new Types.ObjectId(f.contactId);
    if (f.leadId) q.leadId = new Types.ObjectId(f.leadId);
    if (f.dealId) q.dealId = new Types.ObjectId(f.dealId);
    if (f.overdue) {
      q.status = TaskStatus.OPEN;
      q.dueAt = { $lt: new Date() };
    }
    return this.taskModel
      .find(q)
      .populate('contactId', 'name avatar')
      .populate('assignedTo', 'firstName lastName')
      .sort({ status: 1, dueAt: 1, createdAt: -1 })
      .limit(500)
      .exec();
  }

  async updateTask(tenantId: string, id: string, dto: UpdateTaskDto) {
    const { workspaceId, ...rest } = dto;
    const set: any = clean({
      ...rest,
      dueAt: rest.dueAt ? new Date(rest.dueAt) : undefined,
      assignedTo: oid(rest.assignedTo),
    });
    if (rest.status === TaskStatus.DONE) set.completedAt = new Date();
    const update: any = { $set: set };
    if (rest.status === TaskStatus.OPEN) update.$unset = { completedAt: '' };
    if (rest.dueAt) {
      // a new due date re-arms the reminder
      update.$unset = { ...(update.$unset || {}), remindedAt: '' };
    }
    const task = await this.taskModel.findOneAndUpdate({ _id: id, ...this.scope(tenantId, workspaceId) }, update, { returnDocument: 'after' });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  async removeTask(tenantId: string, id: string, workspaceId?: string) {
    const res = await this.taskModel.deleteOne({ _id: id, ...this.scope(tenantId, workspaceId) });
    if (!res.deletedCount) throw new NotFoundException('Task not found');
  }

  /** Pushes a notification once for tasks that are due within 15 minutes or already overdue. */
  @Cron('*/5 * * * *')
  async remindDueTasks() {
    try {
      const due = await this.taskModel
        .find({ status: TaskStatus.OPEN, remindedAt: { $exists: false }, dueAt: { $lte: new Date(Date.now() + 15 * 60 * 1000) } })
        .limit(200);
      for (const task of due) {
        this.events.emitToTenant(task.tenantId.toString(), 'task.due', {
          taskId: task._id.toString(),
          title: task.title,
          dueAt: task.dueAt,
          assignedTo: task.assignedTo?.toString(),
          workspaceId: task.workspaceId?.toString(),
        });
        task.remindedAt = new Date();
        await task.save();
      }
    } catch (e: any) {
      this.logger.error(`Task reminders failed: ${e?.message || e}`);
    }
  }

  // ─── Notes ───

  async createNote(tenantId: string, userId: string, dto: CreateNoteDto) {
    return this.noteModel.create({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: oid(dto.workspaceId),
      body: dto.body,
      pinned: dto.pinned,
      authorId: oid(userId),
      contactId: oid(dto.contactId),
      leadId: oid(dto.leadId),
      dealId: oid(dto.dealId),
      conversationId: oid(dto.conversationId),
    });
  }

  async listNotes(tenantId: string, workspaceId: string | undefined, f: { contactId?: string; leadId?: string; dealId?: string; conversationId?: string }) {
    const q = this.scope(tenantId, workspaceId);
    if (f.contactId) q.contactId = new Types.ObjectId(f.contactId);
    if (f.leadId) q.leadId = new Types.ObjectId(f.leadId);
    if (f.dealId) q.dealId = new Types.ObjectId(f.dealId);
    if (f.conversationId) q.conversationId = new Types.ObjectId(f.conversationId);
    return this.noteModel.find(q).populate('authorId', 'firstName lastName').sort({ pinned: -1, createdAt: -1 }).limit(200).exec();
  }

  async updateNote(tenantId: string, id: string, dto: UpdateNoteDto) {
    const { workspaceId, ...rest } = dto;
    const note = await this.noteModel.findOneAndUpdate({ _id: id, ...this.scope(tenantId, workspaceId) }, { $set: clean(rest) }, { returnDocument: 'after' });
    if (!note) throw new NotFoundException('Note not found');
    return note;
  }

  async removeNote(tenantId: string, id: string, workspaceId?: string) {
    const res = await this.noteModel.deleteOne({ _id: id, ...this.scope(tenantId, workspaceId) });
    if (!res.deletedCount) throw new NotFoundException('Note not found');
  }

  // ─── Quick replies ───

  listQuickReplies(tenantId: string, workspaceId?: string) {
    return this.quickReplyModel.find(this.scope(tenantId, workspaceId)).sort({ shortcut: 1 }).exec();
  }

  async createQuickReply(tenantId: string, dto: UpsertQuickReplyDto) {
    try {
      return await this.quickReplyModel.create({
        tenantId: new Types.ObjectId(tenantId),
        workspaceId: oid(dto.workspaceId),
        shortcut: dto.shortcut,
        body: dto.body,
      });
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException(`Ya existe un atajo "/${dto.shortcut}"`);
      throw e;
    }
  }

  async updateQuickReply(tenantId: string, id: string, dto: UpsertQuickReplyDto) {
    try {
      const doc = await this.quickReplyModel.findOneAndUpdate(
        { _id: id, ...this.scope(tenantId, dto.workspaceId) },
        { $set: { shortcut: dto.shortcut, body: dto.body } },
        { returnDocument: 'after' },
      );
      if (!doc) throw new NotFoundException('Quick reply not found');
      return doc;
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException(`Ya existe un atajo "/${dto.shortcut}"`);
      throw e;
    }
  }

  async removeQuickReply(tenantId: string, id: string, workspaceId?: string) {
    const res = await this.quickReplyModel.deleteOne({ _id: id, ...this.scope(tenantId, workspaceId) });
    if (!res.deletedCount) throw new NotFoundException('Quick reply not found');
  }

  // ─── Tags ───

  /** Distinct tags used by contacts of the workspace (for autocomplete / filters). */
  async listTags(tenantId: string, workspaceId?: string): Promise<string[]> {
    const tags = await this.contactModel.distinct('tags', this.scope(tenantId, workspaceId));
    return (tags as string[]).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }

  // ─── Timeline ───

  /** Everything that happened with a contact, newest first, across channels and CRM objects. */
  async timeline(tenantId: string, workspaceId: string | undefined, contactId: string): Promise<TimelineItem[]> {
    const base = { ...this.scope(tenantId, workspaceId), contactId: new Types.ObjectId(contactId) };
    const [notes, tasks, conversations, leads, deals, docs] = await Promise.all([
      this.noteModel.find(base).sort({ createdAt: -1 }).limit(100).lean(),
      this.taskModel.find(base).sort({ createdAt: -1 }).limit(100).lean(),
      this.conversationModel.find(base).sort({ lastMessageAt: -1 }).limit(50).lean(),
      this.leadModel.find(base).sort({ createdAt: -1 }).limit(50).lean(),
      this.dealModel.find(base).sort({ createdAt: -1 }).limit(50).lean(),
      this.salesModel.find(base).sort({ createdAt: -1 }).limit(100).lean(),
    ]);

    const items: TimelineItem[] = [];
    notes.forEach((n: any) => items.push({ type: 'note', at: n.createdAt, title: 'Nota', detail: n.body, refId: String(n._id) }));
    tasks.forEach((t: any) =>
      items.push({
        type: 'task',
        at: t.completedAt || t.createdAt,
        title: t.status === 'done' ? `Tarea completada: ${t.title}` : `Tarea: ${t.title}`,
        detail: t.dueAt ? `Vence ${new Date(t.dueAt).toISOString()}` : undefined,
        refId: String(t._id),
        meta: { status: t.status },
      }),
    );
    conversations.forEach((c: any) =>
      items.push({
        type: 'conversation',
        at: c.lastMessageAt || c.createdAt,
        title: `Conversación por ${c.channel}`,
        detail: c.lastMessage,
        refId: String(c._id),
        meta: { channel: c.channel, status: c.status },
      }),
    );
    leads.forEach((l: any) => items.push({ type: 'lead', at: l.createdAt, title: `Lead: ${l.title}`, detail: `Estado ${l.status}`, refId: String(l._id), meta: { status: l.status } }));
    deals.forEach((d: any) =>
      items.push({ type: 'deal', at: d.createdAt, title: `Deal: ${d.title}`, detail: `${d.currency} ${d.value} · ${d.stage}`, refId: String(d._id), meta: { stage: d.stage } }),
    );
    docs.forEach((d: any) => {
      items.push({
        type: d.type,
        at: d.createdAt,
        title: `${d.type === 'quote' ? 'Cotización' : 'Factura'} ${d.number}`,
        detail: `${d.currency} ${(d.totalCents / 100).toFixed(2)} · ${d.status}`,
        refId: String(d._id),
        meta: { status: d.status, type: d.type },
      });
      (d.payments || []).forEach((p: any) =>
        items.push({ type: 'payment', at: p.date, title: `Pago recibido ${d.currency} ${(p.amountCents / 100).toFixed(2)}`, detail: `${d.number} · ${p.method}`, refId: String(d._id) }),
      );
    });

    return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 300);
  }
}
