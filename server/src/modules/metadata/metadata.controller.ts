import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { MetadataService } from './metadata.service';
import { AuthUser, CurrentUser, Perm } from '../../common/decorators';

@Controller('api/v1')
export class MetadataController {
  constructor(private svc: MetadataService) {}

  @Get('domains')
  domains(@CurrentUser() user: AuthUser) {
    return this.svc.domains(user);
  }

  /** 新建数据域（建域即对管理员/数据管理员授权可见范围） */
  @Post('domains')
  @Perm('model.manage')
  createDomain(@Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.saveDomain(dto, user);
  }

  @Get('models')
  @Perm('model.view')
  models() {
    return this.svc.models();
  }

  @Get('models/:id')
  @Perm('model.view')
  model(@Param('id', ParseIntPipe) id: number) {
    return this.svc.model(id);
  }

  @Post('models')
  @Perm('model.manage')
  create(@Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.createModel(dto, user);
  }

  @Put('models/:id')
  @Perm('model.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.updateModel(id, dto, user);
  }

  @Post('models/:id/fields')
  @Perm('model.manage')
  saveField(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.saveField(id, dto, user);
  }

  @Delete('models/:id/fields/:fieldId')
  @Perm('model.manage')
  deleteField(
    @Param('id', ParseIntPipe) id: number,
    @Param('fieldId', ParseIntPipe) fieldId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.deleteField(id, fieldId, user);
  }

  @Get('models/:id/compat')
  @Perm('model.view')
  compat(@Param('id', ParseIntPipe) id: number) {
    return this.svc.compat(id);
  }

  @Post('models/:id/publish')
  @Perm('model.manage')
  publish(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.publish(id, dto, user);
  }

  @Get('dicts')
  @Perm('dict.view')
  dicts() {
    return this.svc.dicts();
  }

  @Post('dicts')
  @Perm('dict.manage')
  createDict(@Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.createDict(dto, user);
  }

  /** M5：编辑码表（名称/说明/树形开关） */
  @Put('dicts/:code')
  @Perm('dict.manage')
  updateDict(@Param('code') code: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.updateDict(code, dto, user);
  }

  @Get('dicts/:code/items')
  @Perm('dict.view')
  dictItems(@Param('code') code: string) {
    return this.svc.dictItems(code);
  }

  @Post('dicts/:code/items')
  @Perm('dict.manage')
  saveItem(@Param('code') code: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.saveDictItem(code, dto, user);
  }

  @Delete('dicts/:code/items/:id')
  @Perm('dict.manage')
  deleteItem(@Param('code') code: string, @Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.svc.deleteDictItem(code, id, user);
  }

  @Get('code-rules')
  @Perm('model.view')
  codeRules() {
    return this.svc.codeRules();
  }

  @Put('code-rules/:domain')
  @Perm('model.manage')
  updateRule(@Param('domain') domain: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.updateCodeRule(domain, dto, user);
  }

  @Post('code-rules/:domain/preview')
  @Perm('model.view')
  preview(@Param('domain') domain: string) {
    return this.svc.previewCode(domain);
  }
}
