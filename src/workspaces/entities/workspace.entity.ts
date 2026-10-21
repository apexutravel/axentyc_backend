import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WorkspaceDocument = Workspace & Document;

export enum WorkspaceType {
  DEFAULT = 'default',
  BRAND = 'brand',
  CLIENT = 'client',
  BRANCH = 'branch',
}

@Schema({ timestamps: true })
export class Workspace {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  slug: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ type: String })
  color?: string;

  @Prop({ type: String })
  icon?: string;

  @Prop({ type: String })
  logoUrl?: string;

  @Prop({ type: String })
  businessEmail?: string;

  @Prop({ type: String })
  phone?: string;

  @Prop({ type: String })
  website?: string;

  @Prop({ type: String })
  industry?: string;

  @Prop({ type: String, default: 'USD' })
  currency?: string;

  @Prop({ type: String, default: 'America/New_York' })
  timezone?: string;

  @Prop({ type: Object })
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };

  @Prop({ type: Object })
  taxSettings?: {
    taxId?: string;
    taxName?: string;
    taxRate?: number;
    taxIncluded?: boolean;
  };

  @Prop({ type: Object })
  documentSettings?: {
    quoteTerms?: string;
    invoiceTerms?: string;
    paymentTerms?: string;
    footerNote?: string;
  };

  @Prop({ type: Object })
  businessHours?: {
    enabled?: boolean;
    timezone?: string;
    schedule?: Record<string, { start: string; end: string; closed?: boolean }>;
  };

  @Prop({ type: String, enum: WorkspaceType, default: WorkspaceType.DEFAULT })
  type: WorkspaceType;

  @Prop({ default: true })
  isActive: boolean;
}

export const WorkspaceSchema = SchemaFactory.createForClass(Workspace);

WorkspaceSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
WorkspaceSchema.index({ tenantId: 1, isActive: 1 });
