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
import { LeadsService } from '../services/leads.service';
import { CreateLeadDto } from '../dto/create-lead.dto';
import { UpdateLeadDto } from '../dto/update-lead.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new lead' })
  create(@CurrentUser() user: any, @Body() createLeadDto: CreateLeadDto) {
    return this.leadsService.create(user.tenantId, createLeadDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all leads for tenant' })
  findAll(@CurrentUser() user: any) {
    return this.leadsService.findAll(user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a lead by ID' })
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.leadsService.findOne(user.tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a lead' })
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() updateLeadDto: UpdateLeadDto,
  ) {
    return this.leadsService.update(user.tenantId, id, updateLeadDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a lead' })
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.leadsService.remove(user.tenantId, id);
  }
}
