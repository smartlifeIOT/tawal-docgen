import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query,
  Res, StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permissions.guard';
import { Response } from 'express';
import { MopService } from './mop.service';
import { BulkMopDto, CreateMopDto, QueryMopDto } from './mop.dto';
import { StorageService } from '../storage/storage.service';
import { CurrentUser } from '../auth/current-user.decorator';

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};

function disposition(fileName: string, inline = false) {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

@ApiTags('MOP')
@Controller('mop')
export class MopController {
  constructor(
    private readonly mop: MopService,
    private readonly storage: StorageService,
  ) {}

  @RequirePermission('mop', 'view')
  @Get()
  findAll(@Query() q: QueryMopDto) {
    return this.mop.findAll(q);
  }

  @Get('batches')
  batches(@Query('limit') limit?: string) {
    return this.mop.listBatches(limit ? Number(limit) : 25);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.mop.findOne(id);
  }

  @RequirePermission('mop', 'create')
  @Post()
  create(@Body() dto: CreateMopDto, @CurrentUser('id') userId: string) {
    return this.mop.create(dto, userId);
  }

  @RequirePermission('mop', 'edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<CreateMopDto>) {
    return this.mop.update(id, dto);
  }

  @Post(':id/regenerate')
  regenerate(@Param('id') id: string) {
    return this.mop.render(id);
  }

  @RequirePermission('mop', 'delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.mop.remove(id);
  }

  /* ------------------------------------------------------------ downloads */

  /**
   * All of one project's MOPs, in one format, as a ZIP.
   *
   * Declared before `:id/...` and kept to a literal two-segment path so Nest
   * cannot mistake it for a document ID. `siteId` is a query parameter because
   * the group of MOPs raised without a tracker project has an empty one, which
   * a path parameter cannot carry.
   */
  @RequirePermission('mop', 'view')
  @Get('download/project')
  async downloadProject(
    @Query('format') format: string,
    @Res({ passthrough: true }) res: Response,
    @Query('siteId') siteId?: string,
    @Query('mopCategoryId') mopCategoryId?: string,
    @Query('search') search?: string,
    @Query('ids') ids?: string,
  ) {
    const fmt = (format ?? '').toLowerCase();
    if (fmt !== 'pdf' && fmt !== 'docx') {
      throw new BadRequestException('Choose a format: "pdf" or "docx".');
    }
    // Hand-picked rows arrive as one comma-separated list: a repeated query
    // parameter would hit the URL length limit on a large project.
    const picked = (ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const { fileName, buffer, included, skipped } = await this.mop.zipForProject(
      siteId,
      fmt as 'pdf' | 'docx',
      { mopCategoryId, search, ids: picked },
    );
    res.set({
      'Content-Type': MIME.zip,
      'Content-Disposition': disposition(fileName),
      // Read by the UI to report what the archive actually holds.
      'X-Documents-Included': String(included),
      'X-Documents-Skipped': String(skipped),
      'Access-Control-Expose-Headers': 'X-Documents-Included, X-Documents-Skipped',
    });
    return new StreamableFile(buffer);
  }

  @Get(':id/download/:kind')
  async download(
    @Param('id') id: string,
    @Param('kind') kind: 'docx' | 'pdf',
    @Query('inline') inline: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (kind !== 'docx' && kind !== 'pdf') {
      throw new BadRequestException('Only "docx" or "pdf" can be downloaded.');
    }
    const { fileName, filePath } = await this.mop.fileFor(id, kind);
    res.set({
      'Content-Type': MIME[kind],
      // Word files always download; PDFs can preview in the browser.
      'Content-Disposition': disposition(fileName, kind === 'pdf' && inline === 'true'),
    });
    return new StreamableFile(this.storage.stream(filePath));
  }

  /* ----------------------------------------------------------------- bulk */

  @Get('bulk/template/:siteId/:mopCategoryId')
  async bulkTemplate(
    @Param('siteId') siteId: string,
    @Param('mopCategoryId') mopCategoryId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { fileName, buffer } = await this.mop.bulkTemplate(siteId, mopCategoryId);
    res.set({ 'Content-Type': MIME.xlsx, 'Content-Disposition': disposition(fileName) });
    return new StreamableFile(buffer);
  }

  @RequirePermission('mop', 'create')
  @Post('bulk')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  bulk(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: BulkMopDto,
    @CurrentUser('id') userId: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded (field name must be "file").');
    if (!/\.xlsx?$/i.test(file.originalname)) {
      throw new BadRequestException('Upload an .xlsx or .xls workbook.');
    }
    return this.mop.bulkGenerate(
      file.buffer,
      file.originalname,
      dto.externalSiteId,
      dto.mopCategoryId,
      userId,
      { requesterName: dto.requesterName, pmName: dto.pmName },
    );
  }

  @Get('bulk/:batchId/zip')
  async bulkZip(@Param('batchId') batchId: string, @Res({ passthrough: true }) res: Response) {
    const { fileName, buffer } = await this.mop.bulkZip(batchId);
    res.set({ 'Content-Type': MIME.zip, 'Content-Disposition': disposition(fileName) });
    return new StreamableFile(buffer);
  }
}
