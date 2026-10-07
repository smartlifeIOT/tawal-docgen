import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permissions.guard';
import { UserRole } from '@prisma/client';
import { CategoriesService } from './categories.service';
import { UpsertMopCategoryDto, UpsertProjectCategoryDto, UpsertTemplateLinkDto } from './categories.dto';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

@ApiTags('Categories')
@Controller('categories')
@UseGuards(RolesGuard)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  // --- readable by anyone signed in ---

  @RequirePermission('projectCategories', 'view')
  @Get('projects')
  projectCategories(@Query('includeInactive') inc?: string) {
    return this.categories.projectCategories(inc === 'true');
  }

  @RequirePermission('mopCategories', 'view')
  @Get('mops')
  mopCategories(@Query('includeInactive') inc?: string) {
    return this.categories.mopCategories(inc === 'true');
  }

  @Get('templates')
  templates() {
    return this.categories.templates();
  }

  @Get('projects/:id/available')
  availableFor(@Param('id') id: string) {
    return this.categories.availableFor(id);
  }

  // --- changes are Admin-only ---

  @Post('projects')
  @RequirePermission('projectCategories', 'create')
  createProjectCategory(@Body() dto: UpsertProjectCategoryDto) {
    return this.categories.createProjectCategory(dto);
  }

  @Delete('projects/:id')
  @RequirePermission('projectCategories', 'delete')
  removeProjectCategory(@Param('id') id: string) {
    return this.categories.removeProjectCategory(id);
  }

  @Patch('projects/:id')
  @RequirePermission('projectCategories', 'edit')
  updateProjectCategory(@Param('id') id: string, @Body() dto: Partial<UpsertProjectCategoryDto>) {
    return this.categories.updateProjectCategory(id, dto);
  }

  @Post('mops')
  @RequirePermission('mopCategories', 'create')
  createMopCategory(@Body() dto: UpsertMopCategoryDto) {
    return this.categories.createMopCategory(dto);
  }

  @Patch('mops/:id')
  @RequirePermission('mopCategories', 'edit')
  updateMopCategory(@Param('id') id: string, @Body() dto: Partial<UpsertMopCategoryDto>) {
    return this.categories.updateMopCategory(id, dto);
  }

  @Delete('mops/:id')
  @RequirePermission('mopCategories', 'delete')
  removeMopCategory(@Param('id') id: string) {
    return this.categories.removeMopCategory(id);
  }

  @Post('links')
  @RequirePermission('projectCategories', 'edit')
  link(@Body() dto: UpsertTemplateLinkDto) {
    return this.categories.linkTemplate(dto);
  }

  @Delete('links/:projectCategoryId/:mopCategoryId')
  @RequirePermission('projectCategories', 'edit')
  unlink(
    @Param('projectCategoryId') projectCategoryId: string,
    @Param('mopCategoryId') mopCategoryId: string,
  ) {
    return this.categories.unlinkTemplate(projectCategoryId, mopCategoryId);
  }
}
