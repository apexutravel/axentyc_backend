import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DocCounter,
  DocCounterDoc,
  Product,
  ProductDoc,
  SalesDocStatus,
  SalesDocType,
  SalesDocument,
  SalesDocumentDoc,
} from './entities/sales-document.entity';
import { computeTotals } from './totals';
import { buildPdf } from './pdf';
import { AddPaymentDto, CreateSalesDocDto, SendDocDto, SetStatusDto, UpdateSalesDocDto, UpsertProductDto } from './dto/invoicing.dto';
import { Contact, ContactDocument } from '../crm/entities/contact.entity';
import { Deal, DealDocument, DealStage } from '../crm/entities/deal.entity';
import { Workspace, WorkspaceDocument } from '../workspaces/entities/workspace.entity';
import { EmailsService } from '../emails/emails.service';
import { AUTOMATION_EVENT, AutomationEventPayload } from '../automations/automation-events';
import { AutomationTrigger } from '../automations/entities/automation.entity';

const DAY = 24 * 60 * 60 * 1000;
const oid = (id?: string) => (id ? new Types.ObjectId(id) : undefined);

/** Quote transitions allowed from each status. Invoices move through payments, not manual status changes. */
const QUOTE_TRANSITIONS: Record<string, SalesDocStatus[]> = {
  [SalesDocStatus.DRAFT]: [SalesDocStatus.SENT, SalesDocStatus.VOID],
  [SalesDocStatus.SENT]: [SalesDocStatus.ACCEPTED, SalesDocStatus.REJECTED, SalesDocStatus.VOID],
  [SalesDocStatus.ACCEPTED]: [SalesDocStatus.VOID],
  [SalesDocStatus.REJECTED]: [SalesDocStatus.SENT],
};

/** Status shown to users: "overdue" / "expired" are derived from the clock, never stored. */
export function displayStatus(doc: { type: string; status: string; dueDate?: Date | string; totalCents: number; amountPaidCents: number }, now = new Date()): string {
  const open = doc.type === 'invoice' ? ['sent', 'partial'] : ['sent'];
  if (doc.dueDate && open.includes(doc.status) && new Date(doc.dueDate).getTime() + DAY < now.getTime()) {
    // due dates are whole days: overdue only after the due day has fully passed
    return doc.type === 'invoice' ? 'overdue' : 'expired';
  }
  return doc.status;
}

@Injectable()
export class InvoicingService {
  constructor(
    @InjectModel(SalesDocument.name) private docModel: Model<SalesDocumentDoc>,
    @InjectModel(DocCounter.name) private counterModel: Model<DocCounterDoc>,
    @InjectModel(Product.name) private productModel: Model<ProductDoc>,
    @InjectModel(Contact.name) private contactModel: Model<ContactDocument>,
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Workspace.name) private workspaceModel: Model<WorkspaceDocument>,
    private readonly emails: EmailsService,
    private readonly bus: EventEmitter2,
  ) {}

  // ─── helpers ───

  private scope(tenantId: string, workspaceId?: string) {
    const q: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) q.workspaceId = new Types.ObjectId(workspaceId);
    return q;
  }

  private async workspaceOf(tenantId: string, workspaceId?: string) {
    if (!workspaceId) return null;
    return this.workspaceModel.findOne({ _id: workspaceId, tenantId: new Types.ObjectId(tenantId) }).lean();
  }

  private async contactOf(tenantId: string, workspaceId: string | undefined, contactId: string) {
    const contact = await this.contactModel.findOne({ _id: contactId, ...this.scope(tenantId, workspaceId) }).lean();
    if (!contact) throw new BadRequestException('Contacto no encontrado en esta empresa');
    return contact;
  }

  /** Atomic, gap-free per workspace and document type: INV-0001, INV-0002, QUO-0001... */
  private async nextNumber(tenantId: string, workspaceId: string | undefined, type: SalesDocType, prefix?: string) {
    const counter = await this.counterModel.findOneAndUpdate(
      { tenantId: new Types.ObjectId(tenantId), workspaceId: oid(workspaceId) ?? null, key: type },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    const base = (prefix || (type === SalesDocType.INVOICE ? 'INV' : 'QUO')).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8) || 'DOC';
    return { sequence: counter.seq, number: `${base}-${String(counter.seq).padStart(4, '0')}` };
  }

  private present(doc: any) {
    const plain = doc.toObject ? doc.toObject() : doc;
    return { ...plain, displayStatus: displayStatus(plain), balanceCents: plain.totalCents - plain.amountPaidCents };
  }

  private emit(payload: AutomationEventPayload) {
    this.bus.emit(AUTOMATION_EVENT, payload);
  }

  // ─── CRUD ───

  async list(tenantId: string, workspaceId: string | undefined, f: { type?: string; status?: string; contactId?: string; dealId?: string; q?: string }) {
    const q = this.scope(tenantId, workspaceId);
    if (f.type) q.type = f.type;
    if (f.contactId) q.contactId = new Types.ObjectId(f.contactId);
    if (f.dealId) q.dealId = new Types.ObjectId(f.dealId);
    if (f.q) q.number = { $regex: f.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    // overdue / expired are derived, so they are filtered after loading
    const stored = f.status && !['overdue', 'expired'].includes(f.status) ? f.status : undefined;
    if (stored) q.status = stored;

    const docs = await this.docModel.find(q).populate('contactId', 'name company email avatar').sort({ createdAt: -1 }).limit(500).exec();
    const items = docs.map((d) => this.present(d));
    return f.status && ['overdue', 'expired'].includes(f.status) ? items.filter((d) => d.displayStatus === f.status) : items;
  }

  async get(tenantId: string, id: string, workspaceId?: string) {
    const doc = await this.docModel.findOne({ _id: id, ...this.scope(tenantId, workspaceId) }).populate('contactId', 'name company email phone avatar');
    if (!doc) throw new NotFoundException('Documento no encontrado');
    return this.present(doc);
  }

  private async load(tenantId: string, id: string, workspaceId?: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Documento no encontrado');
    const doc = await this.docModel.findOne({ _id: id, ...this.scope(tenantId, workspaceId) });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    return doc;
  }

  async create(tenantId: string, userId: string, dto: CreateSalesDocDto) {
    const contact = await this.contactOf(tenantId, dto.workspaceId, dto.contactId);
    if (dto.dealId) await this.assertDeal(tenantId, dto.workspaceId, dto.dealId, dto.contactId);
    const ws: any = await this.workspaceOf(tenantId, dto.workspaceId);

    const taxRatePct = dto.taxRatePct ?? ws?.taxSettings?.taxRate ?? 0;
    const taxIncluded = dto.taxIncluded ?? ws?.taxSettings?.taxIncluded ?? false;
    const totals = computeTotals({ lines: (dto.lines || []) as any, discountPct: dto.discountPct, taxRatePct, taxIncluded });

    const isInvoice = dto.type === SalesDocType.INVOICE;
    const issueDate = dto.issueDate ? new Date(dto.issueDate) : new Date();
    const termsDays = Number.parseInt(ws?.documentSettings?.paymentDays || '', 10);
    const defaultDue = new Date(issueDate.getTime() + (Number.isFinite(termsDays) ? termsDays : isInvoice ? 15 : 30) * DAY);
    const prefix = isInvoice ? ws?.documentSettings?.invoicePrefix : ws?.documentSettings?.quotePrefix;

    // numbering is atomic, but the unique index is the last line of defence against a race
    for (let attempt = 0; attempt < 3; attempt++) {
      const { sequence, number } = await this.nextNumber(tenantId, dto.workspaceId, dto.type, prefix);
      try {
        const doc = await this.docModel.create({
          tenantId: new Types.ObjectId(tenantId),
          workspaceId: oid(dto.workspaceId),
          type: dto.type,
          number,
          sequence,
          contactId: contact._id,
          dealId: oid(dto.dealId),
          issueDate,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : defaultDue,
          currency: (dto.currency || ws?.currency || 'USD').toUpperCase(),
          language: dto.language || ws?.documentSettings?.language || 'es',
          lines: totals.lines.map((l, i) => ({ ...l, productId: oid(dto.lines?.[i]?.productId) })),
          discountPct: dto.discountPct ?? 0,
          taxRatePct,
          taxName: dto.taxName || ws?.taxSettings?.taxName || 'Sales tax',
          taxIncluded,
          subtotalCents: totals.subtotalCents,
          discountCents: totals.discountCents,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
          notes: dto.notes,
          terms: dto.terms ?? (isInvoice ? ws?.documentSettings?.invoiceTerms : ws?.documentSettings?.quoteTerms),
          createdBy: oid(userId),
        });
        return this.present(doc);
      } catch (e: any) {
        if (e?.code !== 11000) throw e;
      }
    }
    throw new ConflictException('No se pudo asignar el número del documento, intenta de nuevo');
  }

  private async assertDeal(tenantId: string, workspaceId: string | undefined, dealId: string, contactId: string) {
    const deal = await this.dealModel.findOne({ _id: dealId, ...this.scope(tenantId, workspaceId) }).lean();
    if (!deal) throw new BadRequestException('Deal no encontrado en esta empresa');
    if (String(deal.contactId) !== String(contactId)) throw new BadRequestException('El deal pertenece a otro contacto');
  }

  async update(tenantId: string, id: string, dto: UpdateSalesDocDto) {
    const doc = await this.load(tenantId, id, dto.workspaceId);
    if (doc.status === SalesDocStatus.VOID) throw new BadRequestException('Un documento anulado no se puede editar');

    // Once sent, the amounts are frozen (they were already shown to the customer)
    const frozen = doc.status !== SalesDocStatus.DRAFT;
    if (frozen && (dto.lines || dto.contactId || dto.discountPct !== undefined || dto.taxRatePct !== undefined || dto.taxIncluded !== undefined)) {
      throw new BadRequestException('Solo los borradores pueden cambiar líneas, cliente o impuestos. Anula y crea uno nuevo.');
    }

    if (dto.contactId) {
      await this.contactOf(tenantId, dto.workspaceId, dto.contactId);
      doc.contactId = new Types.ObjectId(dto.contactId);
    }
    if (dto.dealId !== undefined) {
      if (dto.dealId) await this.assertDeal(tenantId, dto.workspaceId, dto.dealId, String(doc.contactId));
      doc.dealId = oid(dto.dealId);
    }
    if (dto.issueDate) doc.issueDate = new Date(dto.issueDate);
    if (dto.dueDate) doc.dueDate = new Date(dto.dueDate);
    if (dto.currency) doc.currency = dto.currency.toUpperCase();
    if (dto.language) doc.language = dto.language;
    if (dto.taxName !== undefined) doc.taxName = dto.taxName;
    if (dto.notes !== undefined) doc.notes = dto.notes;
    if (dto.terms !== undefined) doc.terms = dto.terms;

    if (!frozen && (dto.lines || dto.discountPct !== undefined || dto.taxRatePct !== undefined || dto.taxIncluded !== undefined)) {
      const totals = computeTotals({
        lines: (dto.lines || (doc.lines as any)) as any,
        discountPct: dto.discountPct ?? doc.discountPct,
        taxRatePct: dto.taxRatePct ?? doc.taxRatePct,
        taxIncluded: dto.taxIncluded ?? doc.taxIncluded,
      });
      doc.lines = totals.lines.map((l, i) => ({ ...l, productId: dto.lines ? oid(dto.lines[i]?.productId) : (doc.lines[i] as any)?.productId })) as any;
      doc.discountPct = dto.discountPct ?? doc.discountPct;
      doc.taxRatePct = dto.taxRatePct ?? doc.taxRatePct;
      doc.taxIncluded = dto.taxIncluded ?? doc.taxIncluded;
      doc.subtotalCents = totals.subtotalCents;
      doc.discountCents = totals.discountCents;
      doc.taxCents = totals.taxCents;
      doc.totalCents = totals.totalCents;
    }
    await doc.save();
    return this.present(doc);
  }

  async remove(tenantId: string, id: string, workspaceId?: string) {
    const doc = await this.load(tenantId, id, workspaceId);
    if (doc.status !== SalesDocStatus.DRAFT) throw new BadRequestException('Solo se pueden eliminar borradores. Anula el documento en su lugar.');
    await doc.deleteOne();
    return { success: true };
  }

  // ─── status / payments ───

  async setStatus(tenantId: string, id: string, dto: SetStatusDto) {
    const doc = await this.load(tenantId, id, dto.workspaceId);
    if (doc.type === SalesDocType.INVOICE) {
      if (dto.status === SalesDocStatus.VOID) return this.voidInvoice(doc);
      if (dto.status === SalesDocStatus.SENT && doc.status === SalesDocStatus.DRAFT) return this.markSent(doc);
      throw new BadRequestException('El estado de una factura cambia al registrar pagos');
    }
    const allowed = QUOTE_TRANSITIONS[doc.status] || [];
    if (!allowed.includes(dto.status)) throw new BadRequestException(`No se puede pasar de "${doc.status}" a "${dto.status}"`);
    doc.status = dto.status;
    if (dto.status === SalesDocStatus.SENT) doc.sentAt = new Date();
    await doc.save();
    return this.present(doc);
  }

  private async markSent(doc: SalesDocumentDoc) {
    doc.status = SalesDocStatus.SENT;
    doc.sentAt = new Date();
    await doc.save();
    return this.present(doc);
  }

  private async voidInvoice(doc: SalesDocumentDoc) {
    if (doc.amountPaidCents > 0) throw new BadRequestException('Esta factura tiene pagos registrados. Elimínalos antes de anularla.');
    doc.status = SalesDocStatus.VOID;
    await doc.save();
    return this.present(doc);
  }

  /** Recomputes paid amount and status from the payment list: the list is the source of truth. */
  private settle(doc: SalesDocumentDoc) {
    doc.amountPaidCents = doc.payments.reduce((sum, p) => sum + p.amountCents, 0);
    if (doc.amountPaidCents >= doc.totalCents && doc.totalCents > 0) {
      doc.status = SalesDocStatus.PAID;
      doc.paidAt = doc.payments.reduce<Date | undefined>((latest, p) => (!latest || new Date(p.date) > latest ? new Date(p.date) : latest), undefined);
    } else if (doc.amountPaidCents > 0) {
      doc.status = SalesDocStatus.PARTIAL;
      doc.paidAt = undefined;
    } else if (doc.status === SalesDocStatus.PAID || doc.status === SalesDocStatus.PARTIAL) {
      doc.status = SalesDocStatus.SENT;
      doc.paidAt = undefined;
    }
  }

  async addPayment(tenantId: string, userId: string, id: string, dto: AddPaymentDto) {
    const doc = await this.load(tenantId, id, dto.workspaceId);
    if (doc.type !== SalesDocType.INVOICE) throw new BadRequestException('Solo las facturas reciben pagos');
    if (doc.status === SalesDocStatus.VOID) throw new BadRequestException('La factura está anulada');
    if (doc.status === SalesDocStatus.PAID) throw new BadRequestException('La factura ya está pagada');

    const balance = doc.totalCents - doc.amountPaidCents;
    if (dto.amountCents > balance) throw new BadRequestException(`El pago excede el saldo pendiente (${(balance / 100).toFixed(2)})`);

    if (doc.status === SalesDocStatus.DRAFT) {
      doc.status = SalesDocStatus.SENT;
      doc.sentAt = doc.sentAt || new Date();
    }
    doc.payments.push({
      _id: new Types.ObjectId(),
      amountCents: dto.amountCents,
      method: dto.method,
      date: dto.date ? new Date(dto.date) : new Date(),
      reference: dto.reference,
      note: dto.note,
      createdBy: oid(userId),
    });
    this.settle(doc);
    await doc.save();

    if ((doc.status as SalesDocStatus) === SalesDocStatus.PAID) await this.onPaid(doc);
    return this.present(doc);
  }

  async removePayment(tenantId: string, id: string, paymentId: string, workspaceId?: string) {
    const doc = await this.load(tenantId, id, workspaceId);
    const before = doc.payments.length;
    doc.payments = doc.payments.filter((p) => String(p._id) !== paymentId);
    if (doc.payments.length === before) throw new NotFoundException('Pago no encontrado');
    this.settle(doc);
    await doc.save();
    return this.present(doc);
  }

  /** A fully paid invoice closes its deal as won and can trigger automations. */
  private async onPaid(doc: SalesDocumentDoc) {
    if (doc.dealId) {
      await this.dealModel.updateOne(
        { _id: doc.dealId, tenantId: doc.tenantId, stage: { $nin: [DealStage.CLOSED_WON, DealStage.CLOSED_LOST] } },
        { $set: { stage: DealStage.CLOSED_WON, actualCloseDate: new Date(), probability: 100 } },
      );
    }
    this.emit({
      trigger: AutomationTrigger.INVOICE_PAID,
      tenantId: String(doc.tenantId),
      workspaceId: doc.workspaceId ? String(doc.workspaceId) : undefined,
      contactId: String(doc.contactId),
      dealId: doc.dealId ? String(doc.dealId) : undefined,
      invoiceId: String(doc._id),
    });
  }

  // ─── conversions ───

  async convertQuote(tenantId: string, userId: string, id: string, workspaceId?: string) {
    const quote = await this.load(tenantId, id, workspaceId);
    if (quote.type !== SalesDocType.QUOTE) throw new BadRequestException('Solo las cotizaciones se convierten en factura');
    if (quote.convertedToId) throw new ConflictException('Esta cotización ya se convirtió en factura');
    if (quote.status === SalesDocStatus.VOID || quote.status === SalesDocStatus.REJECTED) throw new BadRequestException('La cotización no está vigente');

    const invoice: any = await this.create(tenantId, userId, {
      type: SalesDocType.INVOICE,
      workspaceId: workspaceId || (quote.workspaceId ? String(quote.workspaceId) : undefined),
      contactId: String(quote.contactId),
      dealId: quote.dealId ? String(quote.dealId) : undefined,
      currency: quote.currency,
      language: quote.language,
      lines: quote.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        discountPct: l.discountPct,
        taxable: l.taxable,
        productId: l.productId ? String(l.productId) : undefined,
      })),
      discountPct: quote.discountPct,
      taxRatePct: quote.taxRatePct,
      taxName: quote.taxName,
      taxIncluded: quote.taxIncluded,
      notes: quote.notes,
    } as CreateSalesDocDto);

    await this.docModel.updateOne({ _id: invoice._id }, { $set: { sourceQuoteId: quote._id } });
    quote.convertedToId = invoice._id;
    quote.status = SalesDocStatus.ACCEPTED;
    await quote.save();
    return { ...invoice, sourceQuoteId: quote._id };
  }

  async fromDeal(tenantId: string, userId: string, dealId: string, type: SalesDocType, workspaceId?: string) {
    const deal = await this.dealModel.findOne({ _id: dealId, ...this.scope(tenantId, workspaceId) }).lean();
    if (!deal) throw new NotFoundException('Deal no encontrado');
    return this.create(tenantId, userId, {
      type,
      workspaceId: workspaceId || (deal.workspaceId ? String(deal.workspaceId) : undefined),
      contactId: String(deal.contactId),
      dealId: String(deal._id),
      currency: deal.currency,
      lines: [{ description: deal.title, quantity: 1, unitPriceCents: Math.round((deal.value || 0) * 100), taxable: true }],
      notes: deal.description,
    } as CreateSalesDocDto);
  }

  // ─── PDF & email ───

  private async renderPdf(tenantId: string, doc: any) {
    const ws: any = await this.workspaceOf(tenantId, doc.workspaceId ? String(doc.workspaceId) : undefined);
    const contact = await this.contactModel.findById(doc.contactId).lean();
    const a = ws?.address || {};
    const city = [a.city, [a.state, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return buildPdf({
      doc,
      contact: contact as any,
      business: {
        name: ws?.name || 'AXENTYC',
        email: ws?.businessEmail,
        phone: ws?.phone,
        website: ws?.website,
        address: [a.line1, a.line2, city, a.country].filter(Boolean),
        taxId: ws?.taxSettings?.taxId,
        footerNote: ws?.documentSettings?.footerNote,
      },
    });
  }

  async pdf(tenantId: string, id: string, workspaceId?: string) {
    const doc = await this.load(tenantId, id, workspaceId);
    const buffer = await this.renderPdf(tenantId, doc.toObject());
    return { buffer, filename: `${doc.number}.pdf` };
  }

  async send(tenantId: string, id: string, dto: SendDocDto) {
    const doc = await this.load(tenantId, id, dto.workspaceId);
    if (doc.status === SalesDocStatus.VOID) throw new BadRequestException('El documento está anulado');
    const contact: any = await this.contactModel.findById(doc.contactId).lean();
    const to = (dto.to || contact?.email || '').trim();
    if (!to) throw new BadRequestException('El contacto no tiene email. Indica un destinatario.');

    const en = doc.language === 'en';
    const isQuote = doc.type === SalesDocType.QUOTE;
    const ws: any = await this.workspaceOf(tenantId, doc.workspaceId ? String(doc.workspaceId) : undefined);
    const company = ws?.name || 'AXENTYC';
    const total = new Intl.NumberFormat('en-US', { style: 'currency', currency: doc.currency }).format(doc.totalCents / 100);
    const kind = isQuote ? (en ? 'Quote' : 'Cotización') : en ? 'Invoice' : 'Factura';
    const subject = dto.subject || `${kind} ${doc.number} - ${company}`;
    const greeting = en ? `Hello ${contact?.name || ''},` : `Hola ${contact?.name || ''},`;
    const body = dto.message || (en ? `Please find attached ${kind.toLowerCase()} ${doc.number} for ${total}.` : `Adjuntamos la ${kind.toLowerCase()} ${doc.number} por ${total}.`);
    const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

    const pdf = await this.renderPdf(tenantId, doc.toObject());
    try {
      await this.emails.sendEmail(tenantId, {
        workspaceId: dto.workspaceId || (doc.workspaceId ? String(doc.workspaceId) : undefined),
        integrationId: dto.integrationId,
        to: [{ address: to, name: contact?.name }],
        subject,
        textBody: `${greeting}\n\n${body}\n\n${company}`,
        htmlBody: `<p>${escape(greeting)}</p><p>${escape(body).replace(/\n/g, '<br>')}</p><p>${escape(company)}</p>`,
        attachments: [{ filename: `${doc.number}.pdf`, content: pdf.toString('base64'), contentType: 'application/pdf' }],
      } as any);
    } catch (e: any) {
      if (e instanceof BadRequestException && /not configured|disconnected/i.test(String(e.message))) {
        throw new BadRequestException('Conecta una cuenta de email en Integraciones para enviar documentos.');
      }
      throw e;
    }

    if (doc.status === SalesDocStatus.DRAFT) {
      doc.status = SalesDocStatus.SENT;
    }
    doc.sentAt = new Date();
    await doc.save();
    return this.present(doc);
  }

  // ─── products ───

  listProducts(tenantId: string, workspaceId?: string, includeInactive = false) {
    return this.productModel.find({ ...this.scope(tenantId, workspaceId), ...(includeInactive ? {} : { isActive: true }) }).sort({ name: 1 }).limit(1000).exec();
  }

  createProduct(tenantId: string, dto: UpsertProductDto) {
    return this.productModel.create({ ...dto, tenantId: new Types.ObjectId(tenantId), workspaceId: oid(dto.workspaceId) });
  }

  async updateProduct(tenantId: string, id: string, dto: UpsertProductDto) {
    const { workspaceId, ...rest } = dto;
    const doc = await this.productModel.findOneAndUpdate({ _id: id, ...this.scope(tenantId, workspaceId) }, { $set: rest }, { returnDocument: 'after' });
    if (!doc) throw new NotFoundException('Producto no encontrado');
    return doc;
  }

  async removeProduct(tenantId: string, id: string, workspaceId?: string) {
    // Soft delete: old documents keep their line text, but the product stops being offered
    const res = await this.productModel.updateOne({ _id: id, ...this.scope(tenantId, workspaceId) }, { $set: { isActive: false } });
    if (!res.matchedCount) throw new NotFoundException('Producto no encontrado');
    return { success: true };
  }
}
