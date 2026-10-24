import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import { Conversation, ConversationDocument } from '../conversations/entities/conversation.entity';
import { Message, MessageDocument } from '../conversations/entities/message.entity';
import { Contact, ContactDocument } from '../crm/entities/contact.entity';
import { Lead, LeadDocument } from '../crm/entities/lead.entity';
import { Deal, DealDocument, DealStage } from '../crm/entities/deal.entity';
import { SalesDocument, SalesDocumentDoc } from '../invoicing/entities/sales-document.entity';
import { User, UserDocument } from '../users/entities/user.entity';
import { Task, TaskDocument, TaskStatus } from '../activities/entities/task.entity';

const DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const MAX_CONVERSATIONS_FOR_RESPONSE = 5000;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function resolveRange(from?: string, to?: string, now = new Date()) {
  const end = to ? new Date(to) : now;
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new BadRequestException('Rango de fechas inválido');
  if (start >= end) throw new BadRequestException('La fecha inicial debe ser anterior a la final');
  if ((end.getTime() - start.getTime()) / DAY > MAX_RANGE_DAYS) throw new BadRequestException(`El rango máximo es de ${MAX_RANGE_DAYS} días`);
  return { start, end };
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    @InjectModel(Contact.name) private contactModel: Model<ContactDocument>,
    @InjectModel(Lead.name) private leadModel: Model<LeadDocument>,
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(SalesDocument.name) private salesModel: Model<SalesDocumentDoc>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Task.name) private taskModel: Model<TaskDocument>,
  ) {}

  private scope(tenantId: string, workspaceId?: string) {
    const q: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) q.workspaceId = new Types.ObjectId(workspaceId);
    return q;
  }

  /** Today at a glance for the workspace home: what needs attention right now. */
  async dashboard(tenantId: string, workspaceId: string | undefined, userId: string, canSeeInvoices: boolean, canSeeDeals: boolean) {
    const base = this.scope(tenantId, workspaceId);
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + DAY);
    const weekAgo = new Date(now.getTime() - 7 * DAY);

    const unreadMatch = { ...base, unreadCount: { $gt: 0 }, 'metadata.isComment': { $ne: true } };
    const [unread, unreadConvs, tasksToday, tasksOverdue, myOpenTasks, newLeads, newContacts, openDeals, invoices, recent] = await Promise.all([
      this.conversationModel.aggregate([{ $match: unreadMatch }, { $group: { _id: null, conversations: { $sum: 1 }, messages: { $sum: '$unreadCount' } } }]),
      this.conversationModel.find(unreadMatch).sort({ lastMessageAt: -1 }).limit(5).populate('contactId', 'name avatar').select('channel lastMessage lastMessageAt unreadCount contactId').lean(),
      this.taskModel.countDocuments({ ...base, status: TaskStatus.OPEN, dueAt: { $gte: startOfDay, $lt: endOfDay } }),
      this.taskModel.countDocuments({ ...base, status: TaskStatus.OPEN, dueAt: { $lt: startOfDay } }),
      this.taskModel
        .find({ ...base, status: TaskStatus.OPEN, assignedTo: new Types.ObjectId(userId) })
        .sort({ dueAt: 1 })
        .limit(5)
        .select('title dueAt priority')
        .lean(),
      this.leadModel.countDocuments({ ...base, createdAt: { $gte: weekAgo } }),
      this.contactModel.countDocuments({ ...base, createdAt: { $gte: weekAgo } }),
      canSeeDeals
        ? this.dealModel.aggregate([
            { $match: { ...base, stage: { $nin: [DealStage.CLOSED_WON, DealStage.CLOSED_LOST] } } },
            { $group: { _id: '$currency', count: { $sum: 1 }, value: { $sum: '$value' } } },
          ])
        : Promise.resolve([]),
      canSeeInvoices
        ? this.salesModel.aggregate([
            { $match: { ...base, type: 'invoice', status: { $in: ['sent', 'partial'] } } },
            {
              $group: {
                _id: '$currency',
                count: { $sum: 1 },
                outstandingCents: { $sum: { $subtract: ['$totalCents', '$amountPaidCents'] } },
                overdueCount: { $sum: { $cond: [{ $and: [{ $ne: ['$dueDate', null] }, { $lt: ['$dueDate', new Date(now.getTime() - DAY)] }] }, 1, 0] } },
              },
            },
          ])
        : Promise.resolve([]),
      this.conversationModel.find({ ...base, 'metadata.isComment': { $ne: true } }).sort({ lastMessageAt: -1 }).limit(5).populate('contactId', 'name avatar').select('channel lastMessage lastMessageAt contactId').lean(),
    ]);

    return {
      unread: { conversations: unread[0]?.conversations || 0, messages: unread[0]?.messages || 0, items: unreadConvs },
      tasks: { today: tasksToday, overdue: tasksOverdue, mine: myOpenTasks },
      week: { leads: newLeads, contacts: newContacts },
      openDeals: openDeals.map((d: any) => ({ currency: d._id || 'USD', count: d.count, value: d.value })),
      invoices: invoices.map((i: any) => ({ currency: i._id || 'USD', count: i.count, outstandingCents: i.outstandingCents, overdueCount: i.overdueCount })),
      recent,
    };
  }

  async overview(tenantId: string, workspaceId: string | undefined, from?: string, to?: string) {
    const { start, end } = resolveRange(from, to);
    const base = this.scope(tenantId, workspaceId);
    const inRange = { $gte: start, $lte: end };

    const [conversations, response, agents, funnel, sales] = await Promise.all([
      this.conversationStats(base, inRange),
      this.responseTimes(base, inRange),
      this.agentStats(base, inRange),
      this.funnel(base, inRange),
      this.salesStats(base, inRange),
    ]);

    return { range: { from: start, to: end }, conversations, response, agents, funnel, sales };
  }

  private async conversationStats(base: any, inRange: any) {
    const match = { ...base, createdAt: inRange, 'metadata.isComment': { $ne: true } };
    const [byChannel, daily] = await Promise.all([
      this.conversationModel.aggregate([{ $match: match }, { $group: { _id: '$channel', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      this.conversationModel.aggregate([
        { $match: match },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);
    const total = byChannel.reduce((s, c) => s + c.count, 0);
    return {
      total,
      byChannel: byChannel.map((c) => ({ channel: c._id, count: c.count })),
      daily: daily.map((d) => ({ date: d._id, count: d.count })),
    };
  }

  /** Time between the first customer message and the first reply of the conversation. */
  private async responseTimes(base: any, inRange: any) {
    const convs = await this.conversationModel
      .find({ ...base, createdAt: inRange, 'metadata.isComment': { $ne: true } })
      .select('_id')
      .limit(MAX_CONVERSATIONS_FOR_RESPONSE)
      .lean();
    const ids = convs.map((c) => c._id);
    if (ids.length === 0) return { measured: 0, answered: 0, answerRate: 0, avgMinutes: 0, medianMinutes: 0, humanAvgMinutes: 0 };

    const pipeline: PipelineStage[] = [
      { $match: { conversationId: { $in: ids } } },
      {
        $group: {
          _id: '$conversationId',
          firstIn: { $min: { $cond: [{ $eq: ['$direction', 'inbound'] }, '$createdAt', null] } },
          firstOut: { $min: { $cond: [{ $and: [{ $eq: ['$direction', 'outbound'] }, { $ne: ['$isBot', true] }] }, '$createdAt', null] } },
          firstAny: { $min: { $cond: [{ $eq: ['$direction', 'outbound'] }, '$createdAt', null] } },
        },
      },
    ];
    const rows = await this.messageModel.aggregate(pipeline);

    const withInbound = rows.filter((r) => r.firstIn);
    const minutes = (a: Date, b: Date) => (new Date(b).getTime() - new Date(a).getTime()) / 60000;
    const any = withInbound.filter((r) => r.firstAny && r.firstAny >= r.firstIn).map((r) => minutes(r.firstIn, r.firstAny));
    const human = withInbound.filter((r) => r.firstOut && r.firstOut >= r.firstIn).map((r) => minutes(r.firstIn, r.firstOut));
    const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

    return {
      measured: withInbound.length,
      answered: any.length,
      answerRate: withInbound.length ? Math.round((any.length / withInbound.length) * 100) : 0,
      avgMinutes: Math.round(avg(any) * 10) / 10,
      medianMinutes: Math.round(median(any) * 10) / 10,
      /** Only replies written by a person (excludes automations) */
      humanAvgMinutes: Math.round(avg(human) * 10) / 10,
    };
  }

  private async agentStats(base: any, inRange: any) {
    const rows = await this.messageModel.aggregate([
      { $match: { ...base, createdAt: inRange, direction: 'outbound', senderId: { $ne: null } } },
      { $group: { _id: '$senderId', replies: { $sum: 1 }, conversations: { $addToSet: '$conversationId' } } },
      { $project: { replies: 1, conversations: { $size: '$conversations' } } },
      { $sort: { replies: -1 } },
      { $limit: 20 },
    ]);
    const users = await this.userModel.find({ _id: { $in: rows.map((r) => r._id) } }).select('firstName lastName email').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return rows.map((r) => {
      const u: any = byId.get(String(r._id));
      return { userId: String(r._id), name: u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email : 'Usuario eliminado', replies: r.replies, conversations: r.conversations };
    });
  }

  private async funnel(base: any, inRange: any) {
    const [contacts, leadsByStatus, dealsCreated, dealsWon, openPipeline] = await Promise.all([
      this.contactModel.countDocuments({ ...base, createdAt: inRange }),
      this.leadModel.aggregate([{ $match: { ...base, createdAt: inRange } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      this.dealModel.countDocuments({ ...base, createdAt: inRange }),
      this.dealModel.aggregate([
        { $match: { ...base, stage: DealStage.CLOSED_WON, actualCloseDate: inRange } },
        { $group: { _id: '$currency', count: { $sum: 1 }, value: { $sum: '$value' } } },
      ]),
      this.dealModel.aggregate([
        { $match: { ...base, stage: { $nin: [DealStage.CLOSED_WON, DealStage.CLOSED_LOST] } } },
        { $group: { _id: '$currency', count: { $sum: 1 }, value: { $sum: '$value' } } },
      ]),
    ]);
    const leads = leadsByStatus.reduce((s, l) => s + l.count, 0);
    const converted = leadsByStatus.find((l) => l._id === 'converted')?.count || 0;
    return {
      contacts,
      leads,
      leadsByStatus: Object.fromEntries(leadsByStatus.map((l) => [l._id, l.count])),
      leadConversionRate: leads ? Math.round((converted / leads) * 100) : 0,
      dealsCreated,
      dealsWon: dealsWon.map((d) => ({ currency: d._id || 'USD', count: d.count, value: d.value })),
      openPipeline: openPipeline.map((d) => ({ currency: d._id || 'USD', count: d.count, value: d.value })),
    };
  }

  /** Money, per currency, in cents. Paid = payments received inside the range (cash view). */
  private async salesStats(base: any, inRange: any) {
    const invoiceBase = { ...base, type: 'invoice', status: { $in: ['sent', 'partial', 'paid'] } };
    const [issued, paid, open, monthly] = await Promise.all([
      this.salesModel.aggregate([
        { $match: { ...invoiceBase, issueDate: inRange } },
        { $group: { _id: '$currency', count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } },
      ]),
      this.salesModel.aggregate([
        { $match: { ...base, type: 'invoice', status: { $ne: 'void' } } },
        { $unwind: '$payments' },
        { $match: { 'payments.date': inRange } },
        { $group: { _id: '$currency', count: { $sum: 1 }, amountCents: { $sum: '$payments.amountCents' } } },
      ]),
      this.salesModel.aggregate([
        { $match: { ...invoiceBase, status: { $in: ['sent', 'partial'] } } },
        {
          $group: {
            _id: '$currency',
            count: { $sum: 1 },
            outstandingCents: { $sum: { $subtract: ['$totalCents', '$amountPaidCents'] } },
            overdueCents: {
              $sum: {
                $cond: [{ $and: [{ $ne: ['$dueDate', null] }, { $lt: ['$dueDate', new Date(Date.now() - 24 * 60 * 60 * 1000)] }] }, { $subtract: ['$totalCents', '$amountPaidCents'] }, 0],
              },
            },
          },
        },
      ]),
      this.salesModel.aggregate([
        { $match: { ...base, type: 'invoice', status: { $ne: 'void' } } },
        { $unwind: '$payments' },
        { $match: { 'payments.date': inRange } },
        { $group: { _id: { currency: '$currency', month: { $dateToString: { format: '%Y-%m', date: '$payments.date' } } }, amountCents: { $sum: '$payments.amountCents' } } },
        { $sort: { '_id.month': 1 } },
      ]),
    ]);

    const currencies = new Set<string>([...issued, ...paid, ...open].map((r) => r._id || 'USD'));
    return [...currencies].map((currency) => ({
      currency,
      invoicedCents: issued.find((r) => (r._id || 'USD') === currency)?.totalCents || 0,
      invoices: issued.find((r) => (r._id || 'USD') === currency)?.count || 0,
      collectedCents: paid.find((r) => (r._id || 'USD') === currency)?.amountCents || 0,
      outstandingCents: open.find((r) => (r._id || 'USD') === currency)?.outstandingCents || 0,
      overdueCents: open.find((r) => (r._id || 'USD') === currency)?.overdueCents || 0,
      monthly: monthly.filter((m) => (m._id.currency || 'USD') === currency).map((m) => ({ month: m._id.month, amountCents: m.amountCents })),
    }));
  }
}
