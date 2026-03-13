import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SocialAccount, SocialAccountDocument, SocialAccountStatus } from './entities/social-account.entity';
import { ConnectSocialDto } from './dto/connect-social.dto';

@Injectable()
export class IntegrationsService {
  constructor(
    @InjectModel(SocialAccount.name)
    private socialAccountModel: Model<SocialAccountDocument>,
  ) {}

  async connect(tenantId: string, dto: ConnectSocialDto): Promise<SocialAccount> {
    const account = new this.socialAccountModel({
      ...dto,
      tenantId: new Types.ObjectId(tenantId),
      status: dto.accessToken
        ? SocialAccountStatus.CONNECTED
        : SocialAccountStatus.DISCONNECTED,
    });
    return account.save();
  }

  async findAll(tenantId: string): Promise<SocialAccount[]> {
    return this.socialAccountModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .exec();
  }

  async findOne(tenantId: string, id: string): Promise<SocialAccount> {
    const account = await this.socialAccountModel
      .findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) })
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
