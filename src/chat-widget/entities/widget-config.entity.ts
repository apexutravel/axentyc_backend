import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WidgetConfigDocument = WidgetConfig & Document;

@Schema({ timestamps: true })
export class WidgetConfig {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, unique: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  widgetId: string;

  @Prop({ type: Boolean, default: true })
  enabled: boolean;

  @Prop({ type: String, default: 'Hola! ¿En qué podemos ayudarte?' })
  welcomeMessage: string;

  @Prop({ type: String, default: 'Chatea con nosotros' })
  title: string;

  @Prop({ type: String, default: 'Estamos aquí para ayudarte' })
  subtitle: string;

  @Prop({ type: String, default: '#0084FF' })
  primaryColor: string;

  @Prop({ type: String, default: '#FFFFFF' })
  textColor: string;

  @Prop({ type: String, enum: ['right', 'left'], default: 'right' })
  position: string;

  @Prop({ type: String })
  avatarUrl?: string;

  @Prop({ type: [String], default: [] })
  allowedDomains: string[];

  @Prop({ type: Boolean, default: true })
  showBranding: boolean;

  @Prop({ type: Boolean, default: true })
  collectEmail: boolean;

  @Prop({ type: Boolean, default: false })
  collectPhone: boolean;

  @Prop({ type: String })
  offlineMessage?: string;

  @Prop({ type: Object })
  businessHours?: {
    enabled: boolean;
    timezone: string;
    schedule: {
      monday: { start: string; end: string; enabled: boolean };
      tuesday: { start: string; end: string; enabled: boolean };
      wednesday: { start: string; end: string; enabled: boolean };
      thursday: { start: string; end: string; enabled: boolean };
      friday: { start: string; end: string; enabled: boolean };
      saturday: { start: string; end: string; enabled: boolean };
      sunday: { start: string; end: string; enabled: boolean };
    };
  };

  @Prop({ type: Object })
  customFields?: {
    name: string;
    type: string;
    required: boolean;
    label: string;
  }[];

  @Prop({ type: String })
  customCSS?: string;
}

export const WidgetConfigSchema = SchemaFactory.createForClass(WidgetConfig);
