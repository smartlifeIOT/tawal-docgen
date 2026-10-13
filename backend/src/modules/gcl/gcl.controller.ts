import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  Get,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/permissions.guard';
import { GclService } from './gcl.service';
import { GclBuilderService } from './gcl-builder.service';
import { GclBulkService } from './gcl-bulk.service';
import { CreateFromGclDto } from '../packages/packages.dto';
import { CreateGclDto, CreateGclFromProjectDto } from './gcl.dto';

@ApiTags('GCL')
@Controller('gcl')
export class GclController {
  constructor(
    private readonly gcl: GclService,
    private readonly builder: GclBuilderService,
    private readonly bulk: GclBulkService,
  ) {}

  /** Parse only — a dry run used by the upload screen to preview before committing. */
  @Post('preview')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  preview(@UploadedFile() file: Express.Multer.File) {
    this.assertPdf(file);
    return this.gcl.preview(file.buffer);
  }

  /** Parse, price against the UPL and persist as a package. */
  @RequirePermission('gcl', 'create')
  @Post('upload')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  upload(@UploadedFile() file: Express.Multer.File, @Body() dto: CreateFromGclDto) {
    this.assertPdf(file);
    return this.gcl.ingest(file.buffer, file.originalname, dto);
  }

  /* ---------------- creating a GCL from a scope-of-work sheet ---------------- */

  /** Dry run over a scope sheet (e.g. ZMS008.xlsx): sites, items and pricing. */
  @Post('scope/preview')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  previewScope(@UploadedFile() file: Express.Multer.File, @Body('uplVersion') uplVersion?: string) {
    this.assertWorkbook(file);
    return this.builder.previewScope(file.buffer, uplVersion || 'v1');
  }

  /**
   * Creates a package per site from the scope sheet, ready for GCL_PDF generation.
   * Two file fields: `file` (the scope workbook) and optional `signature` (PNG/JPEG).
   */
  /**
   * Builds a GCL straight from the workbook the tracker already holds against
   * the project's WO request — no upload step, because the file exists upstream.
   */
  /* ------------------------------------------------------------ bulk --- */

  /**
   * Reads the signed GCL attached to each selected project. Saves nothing.
   *
   * There is no upload: the documents already live on the tracker against each
   * project's PAT sign-off.
   */
  @RequirePermission('gcl', 'view')
  @Post('bulk/preview')
  bulkPreview(@Body() body: { siteIds?: string[]; uplVersion?: string }) {
    return this.bulk.preview(body.siteIds ?? [], body.uplVersion || 'v1');
  }

  /** Commits the batch and produces the combined documents. */
  @RequirePermission('gcl', 'create')
  @Post('bulk/commit')
  bulkCommit(@Body() body: any, @CurrentUser('id') userId: string) {
    return this.bulk.commit(body, userId);
  }

  @RequirePermission('gcl', 'view')
  @Get('bulk')
  listBatches(@Query('limit') limit?: string) {
    return this.bulk.list(limit ? Number(limit) : 25);
  }

  @RequirePermission('gcl', 'view')
  @Get('bulk/:batchId')
  batch(@Param('batchId') batchId: string) {
    return this.bulk.findOne(batchId);
  }

  @RequirePermission('gcl', 'edit')
  @Post('bulk/:batchId/regenerate')
  regenerateBatch(@Param('batchId') batchId: string) {
    return this.bulk.generateCombined(batchId);
  }

  @RequirePermission('gcl', 'view')
  @Get('bulk/:batchId/zip')
  async batchZip(@Param('batchId') batchId: string, @Res({ passthrough: true }) res: Response) {
    const { fileName, buffer } = await this.bulk.zip(batchId);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });
    return new StreamableFile(buffer);
  }

  /* ---------------------------------------------------------- single --- */

  /** Reads the signed GCL attached to one project's PAT sign-off. */
  @RequirePermission('gcl', 'view')
  @Get('signed/:siteId/preview')
  previewSigned(@Param('siteId') siteId: string) {
    return this.bulk.previewOne(siteId);
  }

  /**
   * Processes that one signed GCL: package, documents, and the certificate
   * that follows from the acceptance — FAC without oil, PAC with.
   */
  @RequirePermission('gcl', 'create')
  @Post('signed/:siteId')
  commitSigned(
    @Param('siteId') siteId: string,
    @Body() body: any,
    @CurrentUser('id') userId: string,
  ) {
    return this.bulk.commit(
      {
        ...body,
        siteIds: [siteId],
        acceptanceByProject: { [siteId]: body.acceptance },
      },
      userId,
    );
  }

  /**
   * Builds the GCL from the scope sheet attached to the tracker project.
   *
   * The screen posts multipart (it carries the signature image), so this needs
   * a file interceptor like every other upload route here — without one
   * nothing parses the body and every field, `overwrite` included, arrives
   * empty.
   */
  @RequirePermission('gcl', 'create')
  @Post('from-project/:siteId')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'signature', maxCount: 1 }], {
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  fromProject(
    @Param('siteId') siteId: string,
    @UploadedFiles() files: { signature?: Express.Multer.File[] },
    @Body() dto: CreateGclFromProjectDto,
  ) {
    return this.gcl.createFromProject(siteId, files?.signature?.[0], dto);
  }

  /** Preview what the tracker's attachment contains before committing. */
  @RequirePermission('gcl', 'view')
  @Get('from-project/:siteId/preview')
  previewProject(@Param('siteId') siteId: string) {
    return this.builder.previewFromProject(siteId);
  }

  @RequirePermission('gcl', 'create')
  @Post('scope/create')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'signature', maxCount: 1 },
      ],
      { limits: { fileSize: 25 * 1024 * 1024 } },
    ),
  )
  createFromScope(
    @UploadedFiles() files: { file?: Express.Multer.File[]; signature?: Express.Multer.File[] },
    @Body() dto: CreateGclDto,
  ) {
    const scope = files?.file?.[0];
    this.assertWorkbook(scope);
    return this.gcl.createFromScope(scope, files?.signature?.[0], dto);
  }

  private assertWorkbook(file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No scope sheet uploaded (field name must be "file").');
    if (!/\.xlsx?$/i.test(file.originalname)) {
      throw new BadRequestException('The scope of work must be an .xlsx or .xls workbook.');
    }
  }

  private assertPdf(file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded (field name must be "file").');
    if (!/\.pdf$/i.test(file.originalname) && file.mimetype !== 'application/pdf') {
      throw new BadRequestException('The GCL must be a PDF.');
    }
  }
}
