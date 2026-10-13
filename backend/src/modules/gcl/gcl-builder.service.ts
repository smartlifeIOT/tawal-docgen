import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentType, PackageOrigin, PackageStatus, Prisma, QuantitySource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { UplService } from '../upl/upl.service';
import { ExternalProjectsService } from '../external-projects/external-projects.service';
import { SiteTagsService } from '../site-tags/site-tags.service';
import { PackagesService } from '../packages/packages.service';
import { parseScopeWorkbook, ScopeSite } from './scope.parser';
import { CreateGclDto, ScopeSiteInputDto } from './gcl.dto';
import { DocumentsService } from '../documents/documents.service';

const D = (n: number | string) => new Prisma.Decimal(n as any);
const round2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

@Injectable()
export class GclBuilderService {
  private readonly logger = new Logger(GclBuilderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly upl: UplService,
    private readonly config: ConfigService,
    private readonly externalProjects: ExternalProjectsService,
    private readonly documents: DocumentsService,
    private readonly siteTags: SiteTagsService,
    private readonly packages: PackagesService,
  ) {}

  /* --------------------------------------------------------------- preview */

  /** Dry run over a scope workbook: what sites, what items, what they'd cost. */
  async previewScope(buffer: Buffer, uplVersion = 'v1') {
    let parsed;
    try {
      parsed = await parseScopeWorkbook(buffer);
    } catch (e: any) {
      throw new BadRequestException(`Scope sheet could not be read: ${e.message}`);
    }

    const allCodes = parsed.sites.flatMap((s) => s.lines.map((l) => l.itemCode));
    const prices = await this.upl.priceMap(allCodes, uplVersion);

    const sites = parsed.sites.map((site) => {
      const lines = site.lines.map((l, i) => {
        const upl = prices.get(l.itemCode);
        const unitPrice = upl ? Number(upl.price) : 0;
        const totals: Record<string, number> = {};
        for (const c of parsed.quantityColumns) {
          totals[c.key] = unitPrice * (l.quantities[c.key] ?? 0);
        }
        return { no: i + 1, ...l, unitPrice, priceFound: !!upl, totals, lineTotal: unitPrice * l.qty };
      });

      return {
        ...site,
        lines,
        total: lines.reduce((a, l) => a + l.lineTotal, 0),
        columnTotals: Object.fromEntries(
          parsed.quantityColumns.map((c) => [c.key, lines.reduce((a, l) => a + (l.totals[c.key] ?? 0), 0)]),
        ),
        unpricedItems: lines.filter((l) => !l.priceFound).map((l) => l.itemCode),
      };
    });

    return {
      sites,
      quantityColumns: parsed.quantityColumns,
      suggestedFieldKey: parsed.quantityColumns[0]?.key ?? null,
      warnings: parsed.warnings,
    };
  }

  /* ---------------------------------------------------------------- create */

  /**
   * Creates one package per site, marked SCOPE_SHEET, from which a GCL PDF can be
   * generated and then the BOQ / WO / PAC exactly as with an uploaded GCL.
   *
   * Design QTY comes from the sheet's "updated Qty". As-Built starts equal to it —
   * the crew adjusts it on the review screen once the work is actually done, which
   * is what makes the As-Built BOQ differ from the design scope.
   */
  /**
   * Preview of the workbook the tracker holds for this project.
   *
   * Same shape as the upload preview, so the UI does not need a second code
   * path — the only difference is where the bytes came from.
   */
  async previewFromProject(siteId: string) {
    const { fileName, buffer } = await this.externalProjects.fetchScopeFile(siteId);
    const preview = await this.previewScope(buffer);
    return { ...preview, sourceFileName: fileName, siteId };
  }

  /** Creates the GCL from that same workbook. */
  async createFromProject(
    siteId: string,
    dto: Omit<CreateGclDto, 'externalSiteId'>,
    signature?: { fileName: string; filePath: string },
  ) {
    const { fileName, buffer } = await this.externalProjects.fetchScopeFile(siteId);
    this.logger.log(`Building GCL for ${siteId} from tracker attachment "${fileName}"`);
    return this.createFromScope(
      buffer,
      { ...dto, externalSiteId: siteId } as CreateGclDto,
      signature,
    );
  }

  async createFromScope(
    buffer: Buffer,
    dto: CreateGclDto,
    signature?: { fileName: string; filePath: string },
  ) {
    const parsed = await parseScopeWorkbook(buffer).catch((e) => {
      throw new BadRequestException(`Scope sheet could not be read: ${e.message}`);
    });

    const tracked = await this.externalProjects.findBySiteId(dto.externalSiteId);
    if (!tracked) {
      throw new BadRequestException(
        `Project "${dto.externalSiteId}" was not found in the tracker. ` +
          `It may have changed status, or the projects service may be unreachable.`,
      );
    }
    if (tracked.patTcnStatus?.toLowerCase() !== 'approved') {
      throw new BadRequestException(
        `Project "${tracked.siteId}" does not have an approved PAT TCN, so a GCL cannot be created against it.`,
      );
    }

    const selected = dto.siteCodes?.length
      ? parsed.sites.filter((s) => dto.siteCodes!.includes(s.siteCode ?? s.tawalSiteId ?? ''))
      : parsed.sites;

    if (!selected.length) {
      throw new BadRequestException('None of the requested site codes are present in the sheet.');
    }

    const overrides = new Map(
      (dto.sites ?? []).map((s) => [s.siteCode, s] as [string, ScopeSiteInputDto]),
    );

    const created = [];
    for (const site of selected) {
      const pkg = await this.createOne(
        site, dto, overrides, signature, parsed.quantityColumns, tracked,
      );

      // Creating a GCL produces the GCL and nothing else — the BOQ, Work Order
      // and PAC come later, once the as-built quantities and TAG numbers are in.
      await this.documents
        .generate(pkg.id, [DocumentType.GCL_PDF])
        .catch((e) => this.logger.warn(`GCL render failed for ${pkg.woNumber}: ${e.message}`));

      created.push(pkg);
    }

    return { packages: created, warnings: parsed.warnings };
  }

  private async createOne(
    site: ScopeSite,
    dto: CreateGclDto,
    overrides: Map<string, ScopeSiteInputDto>,
    signature?: { fileName: string; filePath: string },
    parsedColumns: { key: string; label: string }[] = [],
    tracked?: {
      id: string;
      siteId: string;
      title: string;
      category: string | null;
      woNumber?: string | null;
    } | null,
  ) {
    const defaults = this.config.get('defaults');
    const key = site.siteCode ?? site.tawalSiteId ?? '';
    const o = overrides.get(key);

    const siteNo = o?.siteNo ?? site.siteCode ?? site.tawalSiteId ?? 'UNKNOWN';

    /*
     * Tags and serials live in the site service. Enrichment, not a
     * prerequisite: if it cannot be reached the GCL still builds with those
     * fields blank. Several identifiers are tried because the site service
     * keys on its own site names.
     */
    const siteData = await this.siteTags.forSite(
      tracked?.siteId,
      siteNo,
      site.tawalSiteId,
      tracked?.id,
    );
    /*
     * The Work Order number belongs to the project, not to us. The tracker
     * issues it (mapping.woIssuance.woNumber) and Tawal references that number
     * on every downstream document — inventing one would mean the GCL and the
     * tracker disagree about the same job. A generated number is only a
     * fallback for the rare case where the WO is issued without one recorded.
     */
    const woNumber =
      o?.woNumber ??
      tracked?.woNumber ??
      this.buildWoNumber(siteNo, site.poNumber, dto.woSequence);

    if (!o?.woNumber && !tracked?.woNumber) {
      this.logger.warn(
        `${siteNo}: the tracker has no WO number for this project — falling back to a generated one.`,
      );
    }

    const existing = await this.prisma.package.findUnique({ where: { woNumber } });
    if (existing) {
      if (!dto.overwrite) {
        throw new BadRequestException(
          // Names the site as well as the WO: with a hundred similar numbers,
          // the site is what tells you which job this is.
          `A package for ${siteNo} (Work Order ${woNumber}) already exists. ` +
            `Tick "Replace the existing package" to rebuild it.`,
        );
      }
      // Through the service, not prisma.delete: the document rows cascade but
      // the generated files do not, and a replaced package would leave its
      // GCL, BOQ, Work Order and certificates behind on disk every re-run.
      await this.packages.remove(existing.id);
    }

    const uplVersion = dto.uplVersion ?? 'v1';
    const prices = await this.upl.priceMap(site.lines.map((l) => l.itemCode), uplVersion);
    const quantitySource = dto.quantitySource ?? QuantitySource.AS_BUILT;
    const fieldKey = dto.quantityFieldKey ?? null;

    let gross = D(0);
    const lines = site.lines.map((l, i) => {
      const upl = prices.get(l.itemCode);
      const unitPrice = upl ? new Prisma.Decimal(upl.price) : D(0);
      const base = fieldKey && l.quantities?.[fieldKey] !== undefined ? l.quantities[fieldKey] : l.qty;
      const designQty = D(base);
      const asBuiltQty = D(base); // adjusted after the handover visit
      const quantity = designQty;
      const lineTotal = round2(unitPrice.mul(quantity));
      gross = gross.plus(lineTotal);

      return {
        no: i + 1,
        itemCode: l.itemCode,
        description: upl?.description?.trim() || l.description,
        unit: l.unit ?? upl?.uom ?? null,
        itemType: l.itemType,
        workType: l.workType,
        designQty,
        asBuiltQty,
        quantity,
        quantities: (l.quantities ?? {}) as any,
        /*
         * Tags and serials come from the site service, not the scope sheet —
         * the sheet is a plan of what to install and carries neither. The
         * serial is appended to the description as ".SN: xxx" when the
         * documents are generated.
         */
        serialNumber: SiteTagsService.serialFor(siteData, l.itemCode),
        tagNumber: SiteTagsService.tagFor(siteData.tags, l.itemCode) ?? 'N/A',
        serviceDate: dto.gclDate ?? null,
        unitPrice,
        lineTotal,
        priceFound: !!upl,
        sortOrder: i,
      };
    });

    const discount = D(dto.discount ?? 0);
    const foc = D(dto.foc ?? 0);

    const pkg = await this.prisma.package.create({
      data: {
        origin: PackageOrigin.SCOPE_SHEET,
        status: PackageStatus.DRAFT,
        quantitySource,
        uplVersion,
        quantityFieldKey: fieldKey,
        quantityFieldLabel:
          parsedColumns.find((c) => c.key === fieldKey)?.label ?? null,
        quantityFields: parsedColumns.length ? (parsedColumns as any) : undefined,

        woNumber,
        siteNo,
        tawalSiteId: site.tawalSiteId,
        siteName: site.siteName,
        budget: site.budget,
        subProjectName: site.subProjectName,
        region: o?.region ?? dto.region ?? null,
        district: o?.district ?? dto.district ?? null,
        projectName: (site.budget || defaults.projectName).toUpperCase(),
        contractorName: dto.contractorName ?? site.contractor ?? defaults.contractorName,
        poNumber: site.poNumber,
        poValue: dto.poValue != null ? D(dto.poValue) : null,
        currency: defaults.currency,

        gclDate: dto.gclDate ?? new Date(),
        serviceDate: dto.gclDate ?? new Date(),
        handoverDate: dto.handoverDate ?? null,
        startDate: dto.startDate ?? null,
        endDate: dto.endDate ?? dto.gclDate ?? null,

        contractorPmName: dto.contractorPmName ?? null,
        contractorPmId: dto.contractorPmId ?? null,
        mspRepName: dto.mspRepName ?? null,
        mspSignDate: dto.mspSignDate ?? null,
        tawalPmName: dto.tawalPmName ?? null,
        tawalPmId: dto.tawalPmId ?? null,

        signatureFileName: signature?.fileName ?? null,
        signaturePath: signature?.filePath ?? null,

        grossAmount: round2(gross),
        discount: round2(discount),
        foc: round2(foc),
        netAmount: round2(gross.minus(discount).minus(foc)),

        externalProjectId: tracked?.id ?? null,
        externalSiteId: tracked?.siteId ?? dto.externalSiteId,
        externalProjectTitle: tracked?.title ?? null,
        externalCategory: tracked?.category ?? null,

        notes: dto.notes ?? null,
        lines: { create: lines },
      },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });

    this.logger.log(`GCL package ${woNumber} created from scope sheet — ${lines.length} lines`);
    return pkg;
  }

  /**
   * Mirrors Tawal's own format:
   *   WO-SLife-IMP-241-00-102R11-10990-SmartTower-18731
   *   WO-<contractor>-IMP-<site>-<po tail>-SmartTower-<sequence>
   * A caller who already has the real WO number should pass it in instead.
   */
  private buildWoNumber(siteNo: string, poNumber: string | null, sequence?: string) {
    const poTail = poNumber ? poNumber.slice(-5) : '00000';
    const seq = sequence ?? String(Date.now()).slice(-5);
    return `WO-SLife-IMP-${siteNo}-${poTail}-SmartTower-${seq}`;
  }

  /* ------------------------------------------------------------- signature */

  /** Attaches or replaces the contractor signature on an existing package. */
  async setSignature(packageId: string, file: Express.Multer.File) {
    if (!/\.(png|jpe?g)$/i.test(file.originalname)) {
      throw new BadRequestException('The signature must be a PNG or JPEG image.');
    }

    const pkg = await this.prisma.package.findUnique({ where: { id: packageId } });
    if (!pkg) throw new BadRequestException('Package not found');

    const saved = await this.storage.saveUpload(file.buffer, `sig-${file.originalname}`);

    return this.prisma.package.update({
      where: { id: packageId },
      data: { signatureFileName: file.originalname, signaturePath: saved.filePath },
      select: { id: true, signatureFileName: true },
    });
  }
}
