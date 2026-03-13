import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IntegrationsService } from './integrations.service';
import { ConnectSocialDto } from './dto/connect-social.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Post('connect')
  @ApiOperation({ summary: 'Connect a social media account' })
  connect(@CurrentUser() user: any, @Body() dto: ConnectSocialDto) {
    return this.integrationsService.connect(user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all connected social accounts' })
  findAll(@CurrentUser() user: any) {
    return this.integrationsService.findAll(user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a social account by ID' })
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.integrationsService.findOne(user.tenantId, id);
  }

  @Post(':id/disconnect')
  @ApiOperation({ summary: 'Disconnect a social media account' })
  disconnect(@CurrentUser() user: any, @Param('id') id: string) {
    return this.integrationsService.disconnect(user.tenantId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a social media account' })
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.integrationsService.remove(user.tenantId, id);
  }
}
