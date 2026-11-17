import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Perm } from '../../common/decorators';
import { ImportService } from './import.service';

@Controller('api/v1/imports')
export class ImportController {
  constructor(private svc: ImportService) {}

  @Get(':domain/template')
  @Perm('master.view')
  template(@Param('domain') domain: string, @CurrentUser() user: AuthUser) {
    return this.svc.template(user, domain);
  }

  @Get()
  @Perm('master.import')
  list(@Query() query: any) {
    return this.svc.list(query);
  }

  @Post(':domain/validate')
  @Perm('master.import')
  validate(@Param('domain') domain: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.validate(user, domain, dto);
  }

  @Get(':batchId')
  @Perm('master.import')
  batch(@Param('batchId', ParseIntPipe) batchId: number) {
    return this.svc.batch(batchId);
  }

  @Post(':batchId/commit')
  @Perm('master.import')
  commit(@Param('batchId', ParseIntPipe) batchId: number, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.commit(user, batchId, dto);
  }
}
