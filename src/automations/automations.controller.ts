import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AutomationsService } from './automations.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('automations')
@ApiBearerAuth()
@Controller('automations')
export class AutomationsController {
  constructor(private readonly automationsService: AutomationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new automation' })
  create(@CurrentUser() user: any, @Body() dto: CreateAutomationDto) {
    return this.automationsService.create(user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all automations for tenant' })
  findAll(@CurrentUser() user: any) {
    return this.automationsService.findAll(user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an automation by ID' })
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.automationsService.findOne(user.tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an automation' })
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateAutomationDto,
  ) {
    return this.automationsService.update(user.tenantId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an automation' })
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.automationsService.remove(user.tenantId, id);
  }
}
