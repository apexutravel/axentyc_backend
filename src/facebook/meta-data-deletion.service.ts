import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { SocialAccount, SocialAccountDocument, SocialPlatform } from '../integrations/entities/social-account.entity';
import { FacebookService } from './facebook.service';
import { parseSignedRequest } from './meta-data-deletion';

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class DeletionRequest {
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ required: true })
  fbUserId: string;

  @Prop({ type: Number, default: 0 })
  disconnectedAccounts: number;

  @Prop({ type: String, enum: ['completed', 'failed'], default: 'completed' })
  status: 'completed' | 'failed';
}
export type DeletionRequestDocument = DeletionRequest & Document;
export const DeletionRequestSchema = SchemaFactory.createForClass(DeletionRequest);

@Injectable()
export class MetaDataDeletionService {
  private readonly logger = new Logger(MetaDataDeletionService.name);

  constructor(
    @InjectModel(SocialAccount.name) private socialAccountModel: Model<SocialAccountDocument>,
    @InjectModel(DeletionRequest.name) private requestModel: Model<DeletionRequestDocument>,
    private readonly facebook: FacebookService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Meta "Data Deletion Request Callback": a person removed the app (or asked Meta to delete their data).
   * We revoke every connection made by that Facebook user: tokens are erased and webhooks unsubscribed.
   * Customer conversations belong to the business that owns them and are handled through the business.
   */
  async handleCallback(signedRequest: string): Promise<{ url: string; confirmation_code: string }> {
    const secret = this.config.get<string>('FACEBOOK_APP_SECRET') || '';
    const { user_id } = parseSignedRequest(signedRequest, secret);
    const fbUserId = String(user_id || '');

    const accounts = fbUserId
      ? await this.socialAccountModel.find({
          platform: { $in: [SocialPlatform.FACEBOOK, SocialPlatform.INSTAGRAM] },
          'metadata.fbUserId': fbUserId,
          isActive: true,
        })
      : [];

    let disconnected = 0;
    let failed = false;
    for (const account of accounts) {
      try {
        await this.facebook.disconnect(String(account.tenantId), String(account._id));
        disconnected++;
      } catch (e: any) {
        failed = true;
        this.logger.error(`Data deletion: could not disconnect ${account._id}: ${e?.message || e}`);
      }
    }

    const code = randomBytes(12).toString('hex');
    await this.requestModel.create({ code, fbUserId, disconnectedAccounts: disconnected, status: failed ? 'failed' : 'completed' });
    this.logger.log(`Data deletion request ${code}: ${disconnected} account(s) disconnected`);

    const base = (this.config.get<string>('FRONTEND_URL') || this.config.get<string>('CORS_ORIGIN') || '').replace(/\/+$/, '');
    return { url: `${base}/data-deletion?code=${code}`, confirmation_code: code };
  }

  async status(code: string): Promise<{ found: boolean; status?: string; requestedAt?: Date }> {
    if (!/^[a-f0-9]{24}$/.test(code || '')) return { found: false };
    const r: any = await this.requestModel.findOne({ code }).lean();
    return r ? { found: true, status: r.status, requestedAt: r.createdAt } : { found: false };
  }
}
