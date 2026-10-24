import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SalesDocumentDoc = SalesDocument & Document;

export enum SalesDocType {
  QUOTE = 'quote',
  INVOICE = 'invoice',
}

export enum SalesDocStatus {
  DRAFT = 'draft',
  SENT = 'sent',
  /** quotes only */
  ACCEPTED = 'accepted',
  /** quotes only */
  REJECTED = 'rejected',
  /** invoices only */
  PARTIAL = 'partial',
  PAID = 'paid',
  VOID = 'void',
}

export interface SalesLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  /** 0-100 */
  discountPct?: number;
  taxable: boolean;
  productId?: Types.ObjectId;
  /** computed: quantity * unitPrice - discount (before document discount and tax) */
  amountCents: number;
}

export interface SalesPayment {
  _id?: Types.ObjectId;
  amountCents: number;
  method: string;
  date: Date;
  reference?: string;
  note?: string;
  createdBy?: Types.ObjectId;
}

/** Quotes and invoices share one shape; `type` tells them apart. All money is stored in integer cents. */
@Schema({ timestamps: true })
export class SalesDocument {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Workspace', index: true })
  workspaceId?: Types.ObjectId;

  @Prop({ type: String, enum: SalesDocType, required: true })
  type: SalesDocType;

  @Prop({ required: true })
  number: string;

  @Prop({ type: Number, required: true })
  sequence: number;

  @Prop({ type: Types.ObjectId, ref: 'Contact', required: true })
  contactId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Deal' })
  dealId?: Types.ObjectId;

  /** quote -> invoice link, in both directions */
  @Prop({ type: Types.ObjectId, ref: 'SalesDocument' })
  sourceQuoteId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'SalesDocument' })
  convertedToId?: Types.ObjectId;

  @Prop({ type: String, enum: SalesDocStatus, default: SalesDocStatus.DRAFT })
  status: SalesDocStatus;

  @Prop({ type: Date, default: Date.now })
  issueDate: Date;

  /** invoice due date / quote validity */
  @Prop({ type: Date })
  dueDate?: Date;

  @Prop({ type: String, default: 'USD' })
  currency: string;

  @Prop({ type: String, enum: ['es', 'en'], default: 'es' })
  language: 'es' | 'en';

  @Prop({ type: [Object], default: [] })
  lines: SalesLine[];

  @Prop({ type: Number, default: 0 })
  discountPct: number;

  @Prop({ type: Number, default: 0 })
  taxRatePct: number;

  @Prop({ type: String })
  taxName?: string;

  @Prop({ type: Boolean, default: false })
  taxIncluded: boolean;

  @Prop({ type: Number, default: 0 })
  subtotalCents: number;

  @Prop({ type: Number, default: 0 })
  discountCents: number;

  @Prop({ type: Number, default: 0 })
  taxCents: number;

  @Prop({ type: Number, default: 0 })
  totalCents: number;

  @Prop({ type: Number, default: 0 })
  amountPaidCents: number;

  @Prop({ type: [Object], default: [] })
  payments: SalesPayment[];

  @Prop({ type: String })
  notes?: string;

  @Prop({ type: String })
  terms?: string;

  @Prop({ type: Date })
  sentAt?: Date;

  @Prop({ type: Date })
  paidAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;
}

export const SalesDocumentSchema = SchemaFactory.createForClass(SalesDocument);

SalesDocumentSchema.index({ tenantId: 1, workspaceId: 1, type: 1, sequence: -1 });
SalesDocumentSchema.index({ tenantId: 1, workspaceId: 1, type: 1, number: 1 }, { unique: true });
SalesDocumentSchema.index({ tenantId: 1, contactId: 1 });
SalesDocumentSchema.index({ tenantId: 1, dealId: 1 });

@Schema()
export class DocCounter {
  @Prop({ type: Types.ObjectId, required: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  workspaceId?: Types.ObjectId;

  @Prop({ required: true })
  key: string;

  @Prop({ type: Number, default: 0 })
  seq: number;
}
export type DocCounterDoc = DocCounter & Document;
export const DocCounterSchema = SchemaFactory.createForClass(DocCounter);
DocCounterSchema.index({ tenantId: 1, workspaceId: 1, key: 1 }, { unique: true });

@Schema({ timestamps: true })
export class Product {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Workspace', index: true })
  workspaceId?: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ type: String })
  sku?: string;

  @Prop({ type: Number, required: true, min: 0 })
  unitPriceCents: number;

  @Prop({ type: Boolean, default: true })
  taxable: boolean;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;
}
export type ProductDoc = Product & Document;
export const ProductSchema = SchemaFactory.createForClass(Product);
ProductSchema.index({ tenantId: 1, workspaceId: 1, name: 1 });
