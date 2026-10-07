import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SiteImpact } from '@prisma/client';
import archiver from 'archiver';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ExternalProjectsService } from '../external-projects/external-projects.service';
import { DocxToPdfService } from './docx-to-pdf.service';
import { fillTemplate, mopFileStem } from './mop.templates';
import { CreateMopDto, QueryMopDto } from './mop.dto';

/** "NO – No Impact" is what the source documents print; keep that wording. */
const impactLabel = (impact: SiteImpact, note?: string | null) =>
  note?.trim() || (impact === SiteImpact.YES ? 'YES – Impact expected' : 'NO – No Impact');

interface BulkRow {
  row: number;
  siteId: string;
  tcnSummary?: string;
  requesterName?: string;
  pmName?: string;
  siteImpact?: string;
  siteImpactNote?: string;
  projectSlug?: string;
  mopCategorySlug?: string;
}

@Injectable()
export class MopService {
  private readonly logger = new Logger(MopService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly pdf: DocxToPdfService,
    private readonly externalProjects: ExternalProjectsService,
  ) {}

  /* ------------------------------------------------------------- querying */

  async findAll(q: QueryMopDto) {
    const where: any = {};
    if (q.externalSiteId) where.externalSiteId = q.externalSiteId;
    if (q.mopCategoryId) where.mopCategoryId = q.mopCategoryId;
    if (q.batchId) where.batchId = q.batchId;
    if (q.search) {
      where.OR = [
        { siteId: { contains: q.search, mode: 'insensitive' } },
        { tcnSummary: { contains: q.search, mode: 'insensitive' } },
        { pmName: { contains: q.search, mode: 'insensitive' } },
      ];
    }

    const take = Math.min(q.limit ?? 25, 100);
    const skip = ((q.page ?? 1) - 1) * take;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.mopDocument.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          projectCategory: { select: { id: true, name: true, colour: true } },
          mopCategory: { select: { id: true, name: true, slug: true } },
          createdBy: { select: { id: true, name: true } },
        },
      }),
      this.prisma.mopDocument.count({ where }),
    ]);

    return { items, total, page: q.page ?? 1, limit: take };
  }

  async findOne(id: string) {
    const doc = await this.prisma.mopDocument.findUnique({
      where: { id },
      include: {
        projectCategory: { select: { id: true, name: true, colour: true } },
        mopCategory: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!doc) throw new NotFoundException('MOP document not found');
    return doc;
  }

  /* -------------------------------------------------------------- single */

  /**
   * Resolves the template from the tracker project's category.
   *
   * The project itself lives upstream, so this walks: site ID → tracker project
   * → its `category` string → the local project category → the pairing with the
   * chosen MOP category → the Word template.
   */
  /**
   * Resolves the Word template.
   *
   * With a project the chain is: site ID -> tracker project -> its `category`
   * string -> the local project category -> the pairing with the chosen MOP
   * category -> the template.
   *
   * Without one — a survey raised before the project exists, or an ad-hoc
   * request — there is no category to derive, so the caller names it directly
   * and the rest of the chain is unchanged. The format is never guessed.
   */
  private async resolve(
    siteId: string | null | undefined,
    mopCategoryId: string,
    projectCategoryId?: string | null,
  ) {
    /*
     * A site ID that the tracker knows gives us its category for free. One it
     * does not know is simply a name typed by hand — a MOP raised before the
     * project exists, or for work outside the tracker — so it is kept as the
     * site reference and the category comes from the caller instead. Rejecting
     * it would make the free-text field pointless.
     */
    const project = siteId ? await this.externalProjects.findBySiteId(siteId) : null;
    if (siteId && !project) {
      this.logger.log(`"${siteId}" is not a tracker project — treating it as a typed name.`);
    }

    let category = project
      ? await this.prisma.projectCategory.findFirst({
          where: { name: { equals: (project.category ?? '').trim(), mode: 'insensitive' } },
        })
      : projectCategoryId
        ? await this.prisma.projectCategory.findUnique({ where: { id: projectCategoryId } })
        : null;

    /*
     * Neither a project nor a category given. The MOP category still has to
     * resolve to one Word format, so look at what it is paired with: a single
     * pairing is unambiguous and is used. Several means the same MOP type is
     * produced on different forms depending on the kind of project, and only
     * the caller knows which — so ask rather than pick one.
     */
    if (!category && !project) {
      const pairings = await this.prisma.categoryTemplate.findMany({
        where: { mopCategoryId },
        include: { projectCategory: true },
      });

      if (pairings.length === 1) {
        category = pairings[0].projectCategory;
      } else if (pairings.length > 1) {
        const names = pairings.map((p: any) => p.projectCategory?.name).filter(Boolean);
        throw new BadRequestException(
          `This MOP type is paired with more than one project category ` +
            `(${names.join(', ')}), which use different forms. Choose one.`,
        );
      }
    }

    if (!category) {
      throw new BadRequestException(
        project
          ? `No project category matches "${project.category ?? 'none'}". ` +
            `Open Project categories so it can be picked up from the tracker.`
          : `This MOP type is not paired with any project category yet, so there ` +
            `is no form to produce. Pair it under Project categories.`,
      );
    }

    const link = await this.prisma.categoryTemplate.findUnique({
      where: {
        projectCategoryId_mopCategoryId: { projectCategoryId: category.id, mopCategoryId },
      },
      include: { mopCategory: true },
    });

    if (!link) {
      const mopCategory = await this.prisma.mopCategory.findUnique({ where: { id: mopCategoryId } });
      throw new BadRequestException(
        `"${category.name}" projects have no "${mopCategory?.name ?? 'that'}" MOP. ` +
          `Pair them under Project categories if they should.`,
      );
    }
    return { project, category, link };
  }

  async create(dto: CreateMopDto, userId: string) {
    const { project, category, link } = await this.resolve(
      dto.externalSiteId,
      dto.mopCategoryId,
      dto.projectCategoryId,
    );

    const impact = dto.siteImpact ?? SiteImpact.NO;
    const summary =
      dto.tcnSummary?.trim() || link.defaultTcnSummary || link.mopCategory.name;

    const doc = await this.prisma.mopDocument.create({
      data: {
        externalProjectId: project?.id ?? null,
        // Without a project this holds the site or project name typed by hand.
        externalSiteId: project?.siteId ?? dto.externalSiteId ?? null,
        externalProjectTitle: project?.title ?? dto.externalSiteId ?? null,
        externalCategory: project?.category ?? category.name,
        projectCategoryId: category.id,
        mopCategoryId: link.mopCategoryId,
        templateKey: link.templateKey,
        tcnSummary: summary,
        siteId: dto.siteId.trim().toUpperCase(),
        requesterName: dto.requesterName.trim(),
        pmName: dto.pmName.trim(),
        siteImpact: impact,
        siteImpactNote: dto.siteImpactNote?.trim() || null,
        createdById: userId,
      },
    });

    return this.render(doc.id);
  }

  /**
   * Fills the template, converts to PDF and stores both. Kept separate from
   * create() so a document can be re-rendered after an edit without being
   * recreated.
   */
  async render(id: string) {
    const doc = await this.prisma.mopDocument.findUnique({
      where: { id },
      include: { mopCategory: true, projectCategory: true },
    });
    if (!doc) throw new NotFoundException('MOP document not found');

    // Prefer the template snapshotted at creation, so re-issuing an old document
    // reproduces it even if the category has since been re-pointed.
    let templateKey = doc.templateKey;
    if (!templateKey) {
      const { link } = await this.resolve(doc.externalSiteId, doc.mopCategoryId);
      templateKey = link.templateKey;
    }

    const stem = mopFileStem(doc.siteId, doc.mopCategory.name);

    const docx = fillTemplate(templateKey, {
      tcnSummary: doc.tcnSummary,
      siteId: doc.siteId,
      requesterName: doc.requesterName,
      pmName: doc.pmName,
      siteImpact: impactLabel(doc.siteImpact, doc.siteImpactNote),
    });

    const docxSaved = await this.storage.saveDocument(`mop/${doc.id}`, `${stem}.docx`, docx);

    let pdfSaved: { filePath: string } | null = null;
    try {
      const pdf = await this.pdf.convert(docx, stem);
      pdfSaved = await this.storage.saveDocument(`mop/${doc.id}`, `${stem}.pdf`, pdf);
    } catch (e: any) {
      // The Word file is the deliverable that must exist; a PDF failure is
      // recoverable and shouldn't lose the document.
      this.logger.warn(`MOP ${doc.id}: DOCX written but PDF failed — ${e.message}`);
    }

    return this.prisma.mopDocument.update({
      where: { id },
      data: {
        docxFileName: `${stem}.docx`,
        docxPath: docxSaved.filePath,
        pdfFileName: pdfSaved ? `${stem}.pdf` : null,
        pdfPath: pdfSaved?.filePath ?? null,
      },
      include: {
        projectCategory: { select: { id: true, name: true } },
        mopCategory: { select: { id: true, name: true } },
      },
    });
  }

  async update(id: string, dto: Partial<CreateMopDto>) {
    await this.findOne(id);
    await this.prisma.mopDocument.update({
      where: { id },
      data: {
        tcnSummary: dto.tcnSummary?.trim(),
        siteId: dto.siteId?.trim().toUpperCase(),
        requesterName: dto.requesterName?.trim(),
        pmName: dto.pmName?.trim(),
        siteImpact: dto.siteImpact,
        siteImpactNote: dto.siteImpactNote?.trim(),
      },
    });
    return this.render(id); // keep the files in step with the record
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.mopDocument.delete({ where: { id } });
    return { deleted: true };
  }

  /* ---------------------------------------------------------------- bulk */

  /** Column headers accepted in the bulk workbook, lower-cased and de-spaced. */
  private static readonly BULK_ALIASES: Record<keyof BulkRow, string[]> = {
    row: [],
    siteId: ['site id', 'siteid', 'site', 'site no'],
    tcnSummary: ['tcn summary', 'tcnsummary', 'summary'],
    requesterName: ['name of requester', 'requester', 'requester name'],
    pmName: ['name of pm', 'pm', 'pm name', 'project manager'],
    siteImpact: ['site impact', 'site impact (yes/no)', 'impact'],
    siteImpactNote: ['impact note', 'site impact note', 'remark'],
    projectSlug: ['project'],
    mopCategorySlug: ['mop', 'mop category', 'category', 'activity'],
  };

  /** Template workbook people download, fill in and upload back. */
  async bulkTemplate(siteId: string, mopCategoryId: string) {
    const { project, link } = await this.resolve(siteId, mopCategoryId);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('MOP Bulk');

    ws.columns = [
      { header: 'Site ID', key: 'siteId', width: 18 },
      { header: 'TCN Summary', key: 'tcnSummary', width: 34 },
      { header: 'Name of Requester', key: 'requesterName', width: 26 },
      { header: 'Name of PM', key: 'pmName', width: 26 },
      { header: 'Site Impact', key: 'siteImpact', width: 14 },
      { header: 'Impact Note', key: 'siteImpactNote', width: 26 },
    ];

    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D174C' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    ws.getRow(1).height = 22;
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    ws.addRow({
      siteId: 'ZMS009',
      tcnSummary: link.defaultTcnSummary ?? link.mopCategory.name,
      requesterName: 'Mohammed Alhaj',
      pmName: 'Abdulrahman Balfaqih',
      siteImpact: 'NO',
      siteImpactNote: 'NO – No Impact',
    });

    // Constrain the impact column so the values stay parseable.
    for (let r = 2; r <= 500; r++) {
      ws.getCell(`E${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"NO,YES"'],
      };
    }

    const notes = wb.addWorksheet('Instructions');
    notes.getColumn(1).width = 100;
    [
      `Bulk MOP generation — ${project?.title ?? 'no project'} / ${link.mopCategory.name}`,
      '',
      'One row per site. Site ID is the only required column.',
      'Blank TCN Summary falls back to this category default:',
      `    ${link.defaultTcnSummary ?? link.mopCategory.name}`,
      'Site Impact accepts NO or YES; blank is treated as NO.',
      'Impact Note is printed verbatim in the Document Control table.',
      'Delete the sample row before uploading.',
    ].forEach((line, i) => {
      const cell = notes.getCell(`A${i + 1}`);
      cell.value = line;
      if (i === 0) cell.font = { bold: true, size: 13 };
    });

    return {
      fileName: `MOP_Bulk_Template_${project?.siteId ?? 'manual'}_${link.mopCategory.slug}.xlsx`,
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    };
  }

  private parseRows(ws: ExcelJS.Worksheet): BulkRow[] {
    const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const text = (cell: ExcelJS.Cell) => {
      const v = cell.value as any;
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') {
        if ('richText' in v) return v.richText.map((r: any) => r.text).join('');
        if ('text' in v) return String(v.text);
        if ('result' in v) return String(v.result ?? '');
      }
      return String(v);
    };

    let headerRow = 0;
    const map: Partial<Record<keyof BulkRow, number>> = {};

    for (let r = 1; r <= Math.min(20, ws.rowCount); r++) {
      const found: Partial<Record<keyof BulkRow, number>> = {};
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
        const t = norm(text(cell));
        for (const [field, aliases] of Object.entries(MopService.BULK_ALIASES)) {
          if (aliases.includes(t) && found[field as keyof BulkRow] === undefined) {
            found[field as keyof BulkRow] = col;
          }
        }
      });
      if (found.siteId !== undefined) {
        headerRow = r;
        Object.assign(map, found);
        break;
      }
    }

    if (!headerRow) {
      throw new BadRequestException(
        'Could not find a header row. The sheet needs at least a "Site ID" column.',
      );
    }

    const get = (row: ExcelJS.Row, f: keyof BulkRow) =>
      map[f] ? text(row.getCell(map[f]!)).trim() : '';

    const rows: BulkRow[] = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const siteId = get(row, 'siteId');
      if (!siteId || norm(siteId) === 'site id') continue;

      rows.push({
        row: r,
        siteId: siteId.toUpperCase(),
        tcnSummary: get(row, 'tcnSummary'),
        requesterName: get(row, 'requesterName'),
        pmName: get(row, 'pmName'),
        siteImpact: get(row, 'siteImpact'),
        siteImpactNote: get(row, 'siteImpactNote'),
        projectSlug: get(row, 'projectSlug'),
        mopCategorySlug: get(row, 'mopCategorySlug'),
      });
    }

    if (!rows.length) throw new BadRequestException('No data rows were found below the header.');
    return rows;
  }

  /**
   * Generates one MOP per row. A failing row is recorded and skipped rather than
   * aborting the batch — with fifty sites, one bad row shouldn't cost the other
   * forty-nine.
   */
  async bulkGenerate(
    buffer: Buffer,
    fileName: string,
    siteId: string,
    mopCategoryId: string,
    userId: string,
    defaults: { requesterName?: string; pmName?: string },
  ) {
    const { project, category, link } = await this.resolve(siteId, mopCategoryId);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.worksheets.find((w) => w.rowCount > 1) ?? wb.worksheets[0];
    if (!ws) throw new BadRequestException('The workbook has no worksheets.');

    const rows = this.parseRows(ws);

    const batch = await this.prisma.mopBatch.create({
      data: { fileName, total: rows.length, createdById: userId },
    });

    const errors: { row: number; siteId: string; message: string }[] = [];
    let succeeded = 0;

    for (const r of rows) {
      try {
        const requester = r.requesterName || defaults.requesterName;
        const pm = r.pmName || defaults.pmName;
        if (!requester) throw new Error('Name of Requester is missing (no column value and no default)');
        if (!pm) throw new Error('Name of PM is missing (no column value and no default)');

        const impact =
          (r.siteImpact ?? '').trim().toUpperCase().startsWith('Y')
            ? SiteImpact.YES
            : SiteImpact.NO;

        const doc = await this.prisma.mopDocument.create({
          data: {
            externalProjectId: project?.id ?? null,
            externalSiteId: project?.siteId ?? siteId ?? null,
            externalProjectTitle: project?.title ?? siteId ?? null,
            externalCategory: project?.category ?? category.name,
            projectCategoryId: category.id,
            mopCategoryId: link.mopCategoryId,
            templateKey: link.templateKey,
            tcnSummary: r.tcnSummary?.trim() || link.defaultTcnSummary || link.mopCategory.name,
            siteId: r.siteId,
            requesterName: requester,
            pmName: pm,
            siteImpact: impact,
            siteImpactNote: r.siteImpactNote?.trim() || null,
            createdById: userId,
            batchId: batch.id,
          },
        });

        await this.render(doc.id);
        succeeded++;
      } catch (e: any) {
        errors.push({ row: r.row, siteId: r.siteId, message: e.message });
        this.logger.warn(`Bulk row ${r.row} (${r.siteId}) failed: ${e.message}`);
      }
    }

    const updated = await this.prisma.mopBatch.update({
      where: { id: batch.id },
      data: {
        succeeded,
        failed: errors.length,
        errors: errors.length ? (errors as any) : undefined,
      },
      include: { documents: { select: { id: true, siteId: true, docxFileName: true } } },
    });

    return { ...updated, errors };
  }

  /** Every document in a batch, zipped, DOCX and PDF side by side. */
  async bulkZip(batchId: string) {
    const batch = await this.prisma.mopBatch.findUnique({
      where: { id: batchId },
      include: { documents: { include: { mopCategory: true } } },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    if (!batch.documents.length) throw new BadRequestException('This batch produced no documents.');

    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (c) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => {
      archive.on('end', () => resolve());
      archive.on('error', reject);
    });

    for (const doc of batch.documents) {
      for (const [p, name] of [
        [doc.docxPath, doc.docxFileName],
        [doc.pdfPath, doc.pdfFileName],
      ] as const) {
        if (p && name && (await this.storage.exists(p))) {
          archive.append(await this.storage.read(p), { name: `${doc.siteId}/${name}` });
        }
      }
    }

    await archive.finalize();
    await done;

    return {
      fileName: `MOP_Batch_${batch.id.slice(0, 8)}.zip`,
      buffer: Buffer.concat(chunks),
    };
  }

  async listBatches(limit = 25) {
    return this.prisma.mopBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { documents: true } },
      },
    });
  }

  /* ------------------------------------------------------------ download */

  async fileFor(id: string, kind: 'docx' | 'pdf') {
    const doc = await this.findOne(id);
    const filePath = kind === 'docx' ? doc.docxPath : doc.pdfPath;
    const fileName = kind === 'docx' ? doc.docxFileName : doc.pdfFileName;

    if (!filePath || !fileName) {
      throw new NotFoundException(
        kind === 'pdf'
          ? 'No PDF for this document — conversion may have failed. Regenerate it.'
          : 'No Word file for this document. Regenerate it.',
      );
    }
    if (!(await this.storage.exists(filePath))) {
      throw new NotFoundException('The file is missing from storage — regenerate the document.');
    }
    return { fileName, filePath };
  }
}
