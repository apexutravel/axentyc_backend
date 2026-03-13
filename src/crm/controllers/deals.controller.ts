import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { DealsService } from '../services/deals.service';
import { CreateDealDto } from '../dto/create-deal.dto';
import { UpdateDealDto } from '../dto/update-deal.dto';
import { DealStage } from '../entities/deal.entity';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('deals')
@ApiBearerAuth()
@Controller('deals')
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new deal' })
  create(@CurrentUser() user: any, @Body() createDealDto: CreateDealDto) {
    return this.dealsService.create(user.tenantId, createDealDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all deals for tenant' })
  findAll(@CurrentUser() user: any) {
    return this.dealsService.findAll(user.tenantId);
  }

  @Get('pipeline/summary')
  @ApiOperation({ summary: 'Get pipeline summary with counts and values' })
  getPipelineSummary(@CurrentUser() user: any) {
    return this.dealsService.getPipelineSummary(user.tenantId);
  }

  @Get('stage/:stage')
  @ApiOperation({ summary: 'Get deals by stage' })
  @ApiQuery({ name: 'stage', enum: DealStage })
  findByStage(@CurrentUser() user: any, @Param('stage') stage: DealStage) {
    return this.dealsService.findByStage(user.tenantId, stage);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a deal by ID' })
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.dealsService.findOne(user.tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a deal' })
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() updateDealDto: UpdateDealDto,
  ) {
    return this.dealsService.update(user.tenantId, id, updateDealDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a deal' })
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.dealsService.remove(user.tenantId, id);
  }
}
