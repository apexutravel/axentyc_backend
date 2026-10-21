import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SocialAccount, SocialAccountDocument, SocialAccountStatus } from './entities/social-account.entity';
import { ConnectSocialDto } from './dto/connect-social.dto';
import { BillingService } from '../billing/billing.service';

const SENSITIVE_FIELDS = '-accessToken -refreshToken -webhookSecret';

function stripSecrets<T>(doc: T): T {
  const obj: any = (doc as any)?.toObject ? (doc as any).toObject() : { ...(doc as any) };
  delete obj.accessToken;
  delete obj.refreshToken;
  delete obj.webhookSecret;
  return obj;
}

@Injectable()
export class IntegrationsService {
  constructor(
    @InjectModel(SocialAccount.name)
    private socialAccountModel: Model<SocialAccountDocument>,
    private billingService: BillingService,
  ) {}

  async connect(tenantId: string, dto: ConnectSocialDto): Promise<SocialAccount> {
    await this.billingService.assertCanConnectSocial(tenantId, dto.workspaceId);

    const account = new this.socialAccountModel({
      ...dto,
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: dto.workspaceId ? new Types.ObjectId(dto.workspaceId) : undefined,
      status: dto.accessToken
        ? SocialAccountStatus.CONNECTED
        : SocialAccountStatus.DISCONNECTED,
    });
    return stripSecrets(await account.save());
  }

  async findAll(tenantId: string, workspaceId?: string): Promise<SocialAccount[]> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    return this.socialAccountModel
      .find(query)
      .select(SENSITIVE_FIELDS)
      .exec();
  }

  async findOne(tenantId: string, id: string): Promise<SocialAccount> {
    const account = await this.socialAccountModel
      .findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) })
      .select(SENSITIVE_FIELDS)
      .exec();
    if (!account) {
      throw new NotFoundException(`Social account with ID ${id} not found`);
    }
    return account;
  }

  async disconnect(tenantId: string, id: string): Promise<SocialAccount> {
    const account = await this.socialAccountModel
      .findOneAndUpdate(
        { _id: id, tenantId: new Types.ObjectId(tenantId) },
        {
          status: SocialAccountStatus.DISCONNECTED,
          accessToken: null,
          refreshToken: null,
        },
        { returnDocument: 'after' },
      )
      .select(SENSITIVE_FIELDS)
      .exec();
    if (!account) {
      throw new NotFoundException(`Social account with ID ${id} not found`);
    }
    return account;
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const result = await this.socialAccountModel
      .findOneAndDelete({ _id: id, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!result) {
      throw new NotFoundException(`Social account with ID ${id} not found`);
    }
  }
}
