import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permissions.guard';
import { PackagesService } from './packages.service';
import { QueryPackagesDto, UpdatePackageDto } from './packages.dto';

@ApiTags('Packages')
@Controller('packages')
export class PackagesController {
  constructor(private readonly packages: PackagesService) {}

  @RequirePermission('gcl', 'view')
  @Get()
  findAll(@Query() q: QueryPackagesDto) {
    return this.packages.findAll(q);
  }

  @RequirePermission('gcl', 'view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.packages.findOne(id);
  }

  @RequirePermission('gcl', 'edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePackageDto) {
    return this.packages.update(id, dto);
  }

  /** Refreshes prices and the Tangible/Service classification from the UPL. */
  @RequirePermission('gcl', 'edit')
  @Post(':id/reprice')
  reprice(@Param('id') id: string) {
    return this.packages.reprice(id);
  }

  @RequirePermission('gcl', 'delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.packages.remove(id);
  }
}
