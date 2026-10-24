import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Automation, AutomationAction, AutomationDocument } from './entities/automation.entity';
import { ActionResult, AutomationRun, AutomationRunDocument } from './entities/automation-run.entity';
import { AUTOMATION_EVENT, MAX_AUTOMATION_DEPTH } from './automation-events';
import type { AutomationEventPayload } from './automation-events';
import { AutomationTrigger } from './entities/automation.entity';
import { safePostJson } from './safe-fetch';
import { Conversation, ConversationDocument, ConversationStatus } from '../conversations/entities/conversation.entity';
import { Contact, ContactDocument } from '../crm/entities/contact.entity';
import { Lead, LeadDocument, LeadStatus } from '../crm/entities/lead.entity';
import { Deal, DealDocument, DealStage } from '../crm/entities/deal.entity';
import { User, UserDocument } from '../users/entities/user.entity';
import { ConversationsService } from '../conversations/conversations.service';
import { ActivitiesService } from '../activities/activities.service';
import { BillingService } from '../billing/billing.service';
import { EventsGateway } from '../events/events.gateway';
import { isUnlimited } from '../billing/plans';

const DEFAULT_COOLDOWN_MIN = 60;
const REPLY_CHANNELS = ['facebook', 'instagram', 'web_chat'];

interface Ctx {
  event: AutomationEventPayload;
  automation: AutomationDocument;
  conversation?: ConversationDocument | null;
  contact?: ContactDocument | null;
  lead?: LeadDocument | null;
  deal?: DealDocument | null;
}

/** Fills {{contact.name}}, {{contact.firstName}}, {{message}} in user written templates. */
export function renderTemplate(template: string, vars: { contactName?: string; message?: string }): string {
  const name = (vars.contactName || '').trim();
  return String(template || '')
    .replace(/\{\{\s*contact\.name\s*\}\}/gi, name || '')
    .replace(/\{\{\s*contact\.firstName\s*\}\}/gi, name.split(/\s+/)[0] || '')
    .replace(/\{\{\s*message\s*\}\}/gi, vars.message || '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Do the automation's conditions match the event? Empty conditions always match. */
export function matchesConditions(
  conditions: Record<string, any> | undefined,
  ev: Pick<AutomationEventPayload, 'channel' | 'text' | 'stage' | 'status'>,
  contactTags: string[] = [],
): boolean {
  const c = conditions || {};
  if (c.channel && c.channel !== 'any' && ev.channel !== c.channel) return false;
  if (c.stage && c.stage !== 'any' && ev.stage !== c.stage) return false;
  if (c.status && c.status !== 'any' && ev.status !== c.status) return false;
  if (Array.isArray(c.keywords) && c.keywords.length > 0) {
    const text = (ev.text || '').toLowerCase();
    if (!c.keywords.some((k: string) => k && text.includes(String(k).toLowerCase()))) return false;
  }
  if (Array.isArray(c.tags) && c.tags.length > 0) {
    const have = contactTags.map((t) => t.toLowerCase());
    if (!c.tags.some((t: string) => have.includes(String(t).toLowerCase()))) return false;
  }
  return true;
}

@Injectable()
export class AutomationEngineService {
  private readonly logger = new Logger(AutomationEngineService.name);

  constructor(
    @InjectModel(Automation.name) private automationModel: Model<AutomationDocument>,
    @InjectModel(AutomationRun.name) private runModel: Model<AutomationRunDocument>,
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
    @InjectModel(Contact.name) private contactModel: Model<ContactDocument>,
    @InjectModel(Lead.name) private leadModel: Model<LeadDocument>,
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly conversations: ConversationsService,
    private readonly activities: ActivitiesService,
    private readonly billing: BillingService,
    private readonly events: EventsGateway,
    private readonly bus: EventEmitter2,
  ) {}

  /** Entry point. Never throws: a broken automation must not break the message flow that triggered it. */
  @OnEvent(AUTOMATION_EVENT, { async: true, suppressErrors: true })
  async handle(event: AutomationEventPayload): Promise<void> {
    try {
      await this.process(event);
    } catch (e: any) {
      this.logger.error(`Automation event ${event?.trigger} failed: ${e?.message || e}`);
    }
  }

  private async process(event: AutomationEventPayload) {
    if (!event?.tenantId || !event.trigger) return;
    if ((event.depth ?? 0) >= MAX_AUTOMATION_DEPTH) return;
    if (!(await this.billing.canWrite(event.tenantId))) return;

    const automations = await this.eligibleAutomations(event);
    if (automations.length === 0) return;

    const [conversation, contact] = await Promise.all([
      event.conversationId ? this.conversationModel.findOne({ _id: event.conversationId, tenantId: new Types.ObjectId(event.tenantId) }) : null,
      event.contactId ? this.contactModel.findOne({ _id: event.contactId, tenantId: new Types.ObjectId(event.tenantId) }) : null,
    ]);
    const contactDoc =
      contact ||
      (conversation?.contactId ? await this.contactModel.findOne({ _id: conversation.contactId, tenantId: new Types.ObjectId(event.tenantId) }) : null);

    for (const automation of automations) {
      if (!matchesConditions(automation.conditions, event, contactDoc?.tags || [])) continue;
      if (await this.inCooldown(automation, event)) continue;
      await this.run({ event, automation, conversation, contact: contactDoc });
    }
  }

  /** Active automations of the workspace, limited to what the current plan allows to run. */
  private async eligibleAutomations(event: AutomationEventPayload): Promise<AutomationDocument[]> {
    const query: any = { tenantId: new Types.ObjectId(event.tenantId), trigger: event.trigger, isActive: true };
    if (event.workspaceId) {
      query.$or = [{ workspaceId: new Types.ObjectId(event.workspaceId) }, { workspaceId: { $exists: false } }, { workspaceId: null }];
    }
    const candidates = await this.automationModel.find(query).sort({ createdAt: 1 });
    if (candidates.length === 0) return [];

    // A downgraded account keeps its rules, but only as many as the plan allows are executed (oldest first)
    const tenantAll = await this.automationModel.find({ tenantId: new Types.ObjectId(event.tenantId), isActive: true }).sort({ createdAt: 1 }).select('_id');
    const limit = (await this.billing.getPlanLimits(event.tenantId)).maxAutomations;
    if (isUnlimited(limit)) return candidates;
    const allowed = new Set(tenantAll.slice(0, Math.max(0, limit)).map((a) => String(a._id)));
    return candidates.filter((a) => allowed.has(String(a._id)));
  }

  /** The same rule is not fired again for the same conversation within the cooldown (avoids reply spam). */
  private async inCooldown(automation: AutomationDocument, event: AutomationEventPayload): Promise<boolean> {
    if (event.trigger !== AutomationTrigger.MESSAGE_RECEIVED || !event.conversationId) return false;
    const minutes = Number.isFinite(automation.conditions?.cooldownMinutes) ? Number(automation.conditions!.cooldownMinutes) : DEFAULT_COOLDOWN_MIN;
    if (minutes <= 0) return false;
    const since = new Date(Date.now() - minutes * 60 * 1000);
    return !!(await this.runModel.exists({
      automationId: automation._id,
      conversationId: new Types.ObjectId(event.conversationId),
      createdAt: { $gte: since },
    }));
  }

  async run(ctx: Ctx): Promise<AutomationRunDocument> {
    const started = Date.now();
    const results: ActionResult[] = [];
    for (const action of ctx.automation.actions || []) {
      try {
        const detail = await this.execute(action.type, action.config || {}, ctx);
        results.push({ type: action.type, ok: true, detail });
      } catch (e: any) {
        results.push({ type: action.type, ok: false, detail: String(e?.message || e).slice(0, 300) });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    const status = okCount === results.length ? 'success' : okCount === 0 ? 'failed' : 'partial';
    if (okCount > 0) {
      await this.automationModel.updateOne({ _id: ctx.automation._id }, { $inc: { executionCount: 1 }, $set: { lastExecutedAt: new Date() } });
    }
    return this.runModel.create({
      tenantId: ctx.automation.tenantId,
      workspaceId: ctx.automation.workspaceId,
      automationId: ctx.automation._id,
      automationName: ctx.automation.name,
      trigger: ctx.event.trigger,
      status,
      conversationId: ctx.event.conversationId ? new Types.ObjectId(ctx.event.conversationId) : undefined,
      contactId: ctx.contact?._id,
      results,
      durationMs: Date.now() - started,
    });
  }

  // ─── actions ───

  private async execute(type: AutomationAction, cfg: Record<string, any>, ctx: Ctx): Promise<string> {
    const { event } = ctx;
    const tenantId = event.tenantId;
    const nextDepth = (event.depth ?? 0) + 1;

    switch (type) {
      case AutomationAction.AUTO_REPLY: {
        const conv = ctx.conversation;
        if (!conv) throw new Error('No hay conversación para responder');
        if (!REPLY_CHANNELS.includes(conv.channel)) throw new Error(`La respuesta automática no está disponible en ${conv.channel}`);
        if ((conv.metadata as any)?.isComment) throw new Error('Los comentarios públicos no se responden con respuesta automática (usa etiquetas, tareas o notificaciones)');
        const text = renderTemplate(cfg.message, { contactName: ctx.contact?.name, message: event.text });
        if (!text) throw new Error('El mensaje de respuesta está vacío');
        await this.conversations.sendMessage(tenantId, String(conv._id), undefined, { content: text } as any, event.workspaceId);
        return 'Respuesta enviada';
      }

      case AutomationAction.ASSIGN_AGENT: {
        if (!cfg.userId || !Types.ObjectId.isValid(cfg.userId)) throw new Error('Falta el agente');
        const agent = await this.userModel.findOne({ _id: cfg.userId, tenantId: new Types.ObjectId(tenantId), isActive: true }).select('_id');
        if (!agent) throw new Error('El agente no existe en esta cuenta');
        let touched = 0;
        if (ctx.conversation) {
          await this.conversationModel.updateOne({ _id: ctx.conversation._id }, { $set: { assignedTo: agent._id } });
          touched++;
        }
        if (ctx.contact) {
          await this.contactModel.updateOne({ _id: ctx.contact._id }, { $set: { assignedTo: agent._id } });
          touched++;
        }
        if (event.leadId) touched += (await this.leadModel.updateOne({ _id: event.leadId, tenantId: new Types.ObjectId(tenantId) }, { $set: { assignedTo: agent._id } })).matchedCount;
        if (event.dealId) touched += (await this.dealModel.updateOne({ _id: event.dealId, tenantId: new Types.ObjectId(tenantId) }, { $set: { assignedTo: agent._id } })).matchedCount;
        if (!touched) throw new Error('No hay nada que asignar en este evento');
        return 'Agente asignado';
      }

      case AutomationAction.ADD_TAG: {
        const tag = String(cfg.tag || '').trim().slice(0, 40);
        if (!tag) throw new Error('Falta la etiqueta');
        let touched = 0;
        if (ctx.contact) {
          await this.contactModel.updateOne({ _id: ctx.contact._id }, { $addToSet: { tags: tag } });
          touched++;
        }
        if (ctx.conversation) {
          await this.conversationModel.updateOne({ _id: ctx.conversation._id }, { $addToSet: { tags: tag } });
          touched++;
        }
        if (!touched) throw new Error('No hay contacto ni conversación para etiquetar');
        return `Etiqueta "${tag}" agregada`;
      }

      case AutomationAction.UPDATE_STATUS: {
        const value = String(cfg.status || '');
        const target = cfg.target || (ctx.conversation ? 'conversation' : event.leadId ? 'lead' : 'deal');
        const scope = { tenantId: new Types.ObjectId(tenantId) };
        if (target === 'conversation') {
          if (!ctx.conversation) throw new Error('No hay conversación');
          if (!Object.values(ConversationStatus).includes(value as ConversationStatus)) throw new Error(`Estado de conversación inválido: ${value}`);
          await this.conversationModel.updateOne({ _id: ctx.conversation._id }, { $set: { status: value } });
        } else if (target === 'lead') {
          if (!event.leadId) throw new Error('No hay lead');
          if (!Object.values(LeadStatus).includes(value as LeadStatus)) throw new Error(`Estado de lead inválido: ${value}`);
          await this.leadModel.updateOne({ _id: event.leadId, ...scope }, { $set: { status: value, lastActivityAt: new Date() } });
        } else {
          if (!event.dealId) throw new Error('No hay deal');
          if (!Object.values(DealStage).includes(value as DealStage)) throw new Error(`Etapa de deal inválida: ${value}`);
          await this.dealModel.updateOne({ _id: event.dealId, ...scope }, { $set: { stage: value } });
        }
        return `${target} → ${value}`;
      }

      case AutomationAction.CREATE_LEAD: {
        if (!ctx.contact) throw new Error('No hay contacto para crear el lead');
        const open = await this.leadModel.exists({
          tenantId: new Types.ObjectId(tenantId),
          contactId: ctx.contact._id,
          status: { $in: [LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.QUALIFIED] },
        });
        if (open) return 'Omitido: el contacto ya tiene un lead abierto';
        const lead = await this.leadModel.create({
          tenantId: new Types.ObjectId(tenantId),
          workspaceId: ctx.contact.workspaceId,
          contactId: ctx.contact._id,
          title: renderTemplate(cfg.title || 'Lead de {{contact.name}}', { contactName: ctx.contact.name, message: event.text }),
          estimatedValue: Number(cfg.estimatedValue) > 0 ? Number(cfg.estimatedValue) : 0,
          source: ctx.contact.source,
        } as any);
        this.bus.emit(AUTOMATION_EVENT, {
          trigger: AutomationTrigger.LEAD_CREATED,
          tenantId,
          workspaceId: lead.workspaceId ? String(lead.workspaceId) : event.workspaceId,
          contactId: String(ctx.contact._id),
          leadId: String(lead._id),
          depth: nextDepth,
        } as AutomationEventPayload);
        return 'Lead creado';
      }

      case AutomationAction.CREATE_DEAL: {
        if (!ctx.contact) throw new Error('No hay contacto para crear el deal');
        if (!(await this.billing.hasFeature(tenantId, 'deals'))) throw new Error('Tu plan no incluye el pipeline de deals');
        const open = await this.dealModel.exists({
          tenantId: new Types.ObjectId(tenantId),
          contactId: ctx.contact._id,
          stage: { $nin: [DealStage.CLOSED_WON, DealStage.CLOSED_LOST] },
        });
        if (open) return 'Omitido: el contacto ya tiene un deal abierto';
        await this.dealModel.create({
          tenantId: new Types.ObjectId(tenantId),
          workspaceId: ctx.contact.workspaceId,
          contactId: ctx.contact._id,
          leadId: event.leadId ? new Types.ObjectId(event.leadId) : undefined,
          title: renderTemplate(cfg.title || 'Deal de {{contact.name}}', { contactName: ctx.contact.name }),
          value: Number(cfg.value) > 0 ? Number(cfg.value) : 0,
        } as any);
        return 'Deal creado';
      }

      case AutomationAction.CREATE_TASK: {
        const title = renderTemplate(cfg.title, { contactName: ctx.contact?.name, message: event.text });
        if (!title) throw new Error('Falta el título de la tarea');
        const hours = Number(cfg.dueInHours);
        await this.activities.createTask(
          tenantId,
          '',
          {
            title: title.slice(0, 200),
            description: cfg.description ? renderTemplate(cfg.description, { contactName: ctx.contact?.name, message: event.text }).slice(0, 2000) : undefined,
            dueAt: Number.isFinite(hours) && hours > 0 ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : undefined,
            assignedTo: cfg.assignedTo && Types.ObjectId.isValid(cfg.assignedTo) ? cfg.assignedTo : undefined,
            workspaceId: event.workspaceId,
            contactId: ctx.contact ? String(ctx.contact._id) : undefined,
            leadId: event.leadId,
            dealId: event.dealId,
            conversationId: event.conversationId,
          },
          'automation',
        );
        return 'Tarea creada';
      }

      case AutomationAction.SEND_NOTIFICATION: {
        const message = renderTemplate(cfg.message, { contactName: ctx.contact?.name, message: event.text });
        if (!message) throw new Error('Falta el mensaje de la notificación');
        this.events.emitNotification(tenantId, {
          title: cfg.title || ctx.automation.name,
          message,
          workspaceId: event.workspaceId,
          conversationId: event.conversationId,
          createdAt: new Date().toISOString(),
        });
        return 'Notificación enviada';
      }

      case AutomationAction.SEND_WEBHOOK: {
        const status = await safePostJson(String(cfg.url || ''), {
          automation: ctx.automation.name,
          trigger: event.trigger,
          occurredAt: new Date().toISOString(),
          contact: ctx.contact ? { id: String(ctx.contact._id), name: ctx.contact.name, email: ctx.contact.email, phone: ctx.contact.phone, tags: ctx.contact.tags } : undefined,
          conversationId: event.conversationId,
          leadId: event.leadId,
          dealId: event.dealId,
          invoiceId: event.invoiceId,
          message: event.text,
        });
        return `Webhook enviado (${status})`;
      }

      default:
        throw new Error(`Acción desconocida: ${type}`);
    }
  }
}
