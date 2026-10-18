import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, QuantitySource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UplService } from '../upl/upl.service';
import { ExternalProjectsService } from '../external-projects/external-projects.service';
import { SiteTagsService } from '../site-tags/site-tags.service';
import { StorageService } from '../storage/storage.service';
import { ParsedGcl } from '../gcl/gcl.parser';
import { CreateFromGclDto, UpdatePackageDto, QueryPackagesDto } from './packages.dto';

const D = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n as any);

/** The chosen column if the line has it, else the legacy Design/As-Built pair. */
function resolveQuantity(
  line: { quantities?: Record<string, number>; designQty: number; asBuiltQty: number },
  fieldKey: string | null,
  fallback: QuantitySource,
): number {
  if (fieldKey && line.quantities && line.quantities[fieldKey] !== undefined) {
    return line.quantities[fieldKey];
  }
  return fallback === QuantitySource.DESIGN ? line.designQty : line.asBuiltQty;
}
const round2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly upl: UplService,
    private readonly config: ConfigService,
    private readonly externalProjects: ExternalProjectsService,
    private readonly siteTags: SiteTagsService,
    private readonly storage: StorageService,
  ) {}

  /* ------------------------------------------------------------ creation */

  /**
   * Turns a parsed GCL into a priced package.
   *
   * The pricing column is whatever the user picked after reading the document —
   * the parser reports the columns it found and their printed labels, rather
   * than the code assuming a Design/As-Built pair. When nothing is chosen we
   * fall back to the second column, because Tawal's own Work Order for
   * 241-00-102R11 totals 11,216.00 (As-Built) and not 13,761.00 (Design).
   */
  async createFromGcl(
    parsed: ParsedGcl,
    dto: CreateFromGclDto,
    source?: { fileName: string; filePath: string },
  ) {
    if (!parsed.woNumber && !dto.woNumber) {
      throw new BadRequestException(
        'No Work Order number could be read from the GCL. Supply one manually.',
      );
    }

    // The tracker owns the project, so its identity is resolved before anything
    // is derived from the document.
    const tracked = await this.externalProjects.findBySiteId(dto.externalSiteId);
    if (!tracked) {
      throw new BadRequestException(
        `Project "${dto.externalSiteId}" was not found in the tracker. ` +
          `It may have changed status, or the projects service may be unreachable.`,
      );
    }
    if (tracked.patStatus?.toLowerCase() !== 'approved') {
      throw new BadRequestException(
        `Project "${tracked.siteId}" does not have an approved PAT, so a signed GCL cannot be uploaded against it.`,
      );
    }

    // The Work Order is issued by the tracker, so that number wins over
    // whatever is printed on the document.
    const woNumber = (dto.woNumber ?? tracked?.woNumber ?? parsed.woNumber)!.trim();

    // Tags and serials enrich the documents: if the service is down the
    // package still builds, with those fields blank rather than the whole
    // batch failing.
    // Whichever identifier the tag service keys on, one of these will match.
    const siteData = await this.siteTags.forSite(
      tracked?.siteId,
      tracked?.id,
      parsed.siteNo,
      dto.externalSiteId,
    );

    const existing = await this.prisma.package.findUnique({ where: { woNumber } });
    if (existing && !dto.overwrite) {
      throw new BadRequestException(
        `A package for ${woNumber} already exists. Re-upload with overwrite=true to replace it.`,
      );
    }
    if (existing) {
      await this.prisma.package.delete({ where: { id: existing.id } });
    }

    const quantitySource = dto.quantitySource ?? QuantitySource.AS_BUILT;
    const uplVersion = dto.uplVersion ?? 'v1';
    const defaults = this.config.get('defaults');

    const columns = parsed.quantityColumns ?? [];
    // Explicit choice wins; otherwise the second column, which is As-Built on a
    // standard GCL, and the first when a document only has one.
    const fieldKey =
      dto.quantityFieldKey && columns.some((c) => c.key === dto.quantityFieldKey)
        ? dto.quantityFieldKey
        : (columns[1]?.key ?? columns[0]?.key ?? null);
    const fieldLabel = columns.find((c) => c.key === fieldKey)?.label ?? null;

    const priced = await this.priceLines(parsed.lines, fieldKey, quantitySource, uplVersion);
    const warnings = [...parsed.warnings, ...priced.warnings];

    const gross = priced.lines.reduce((a, l) => a.plus(l.lineTotal), D(0));
    const discount = D(dto.discount ?? 0);
    const foc = D(dto.foc ?? 0);
    const net = round2(gross.minus(discount).minus(foc));

    const serviceDate = dto.serviceDate ?? parsed.gclDate ?? null;

    // The project is required, so a lookup failure is fatal here — better to
    // refuse than to create a package that can never be traced back.

    const pkg = await this.prisma.package.create({
      data: {
        woNumber,
        // The tracker is authoritative for who the job belongs to; the GCL is
        // authoritative for what was done. So identity comes from the project
        // where it has it, and falls back to the document.
        siteNo: dto.siteNo ?? tracked?.siteId ?? parsed.siteNo ?? 'UNKNOWN',
        tawalSiteId: parsed.tawalSiteId,
        region: dto.region ?? tracked?.region ?? this.expandRegion(parsed.region),
        district: dto.district ?? tracked?.city ?? parsed.district,
        projectName: (parsed.projectName || defaults.projectName).toUpperCase(),
        contractorName: dto.contractorName ?? defaults.contractorName,
        poNumber: parsed.poNumber,
        poValue: dto.poValue != null ? D(dto.poValue) : null,
        currency: defaults.currency,
        quantitySource,
        uplVersion,
        quantityFieldKey: fieldKey,
        quantityFieldLabel: fieldLabel,
        quantityFields: columns.length ? (columns as any) : Prisma.JsonNull,

        gclDate: parsed.gclDate,
        serviceDate,
        handoverDate: dto.handoverDate ?? null,
        startDate: dto.startDate ?? null,
        // Left empty unless chosen: the GCL's date is when it was signed, not
        // when the work order ends, and guessing puts a wrong date on the WO.
        endDate: dto.endDate ?? null,

        contractorPmName: dto.contractorPmName ?? parsed.contractorPmName,
        contractorPmId: dto.contractorPmId ?? null,
        // The date beside the contractor's signature on the GCL. This is what
        // dates the PAC and FAC — not the GCL header date.
        contractorSignDate: parsed.contractorSignDate ?? null,
        mspRepName: parsed.mspRepName,
        tawalPmName: dto.tawalPmName ?? null,
        tawalPmId: dto.tawalPmId ?? null,

        grossAmount: round2(gross),
        discount: round2(discount),
        foc: round2(foc),
        netAmount: net,

        externalProjectId: tracked.id,
        externalSiteId: tracked.siteId,
        externalProjectTitle: tracked.title,
        externalCategory: tracked.category,

        notes: parsed.notes,
        sourceFileName: source?.fileName,
        sourceFilePath: source?.filePath,
        parseWarnings: warnings.length ? (warnings as any) : Prisma.JsonNull,

        lines: {
          create: priced.lines.map((l, i) => ({
            no: l.no,
            itemCode: l.itemCode,
            description: l.description,
            unit: l.unit,
            itemType: l.itemType,
            designQty: D(l.designQty),
            asBuiltQty: D(l.asBuiltQty),
            quantity: D(l.quantity),
            quantities: (l.quantities ?? {}) as any,
            /*
             * The serial recorded against this item in the site service wins
             * over whatever the GCL prints: the site service is maintained as
             * units are installed and swapped, while the GCL is a snapshot of
             * the day it was signed. It is appended to the description as
             * ".SN: xxx" when the documents are generated.
             */
            serialNumber:
              SiteTagsService.serialFor(siteData, l.itemCode) ?? l.serialNumber,
            // The GCL carries serials but not asset tags; those live in the
            // site system. 'N/A' where none is recorded, as before.
            tagNumber: SiteTagsService.tagFor(siteData.tags, l.itemCode) ?? 'N/A',
            serviceDate,
            unitPrice: D(l.unitPrice),
            lineTotal: round2(l.lineTotal),
            priceFound: l.priceFound,
            sortOrder: i,
          })),
        },
      },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });

    this.logger.log(`Package ${woNumber} created — ${pkg.lines.length} lines, net ${net}`);
    return { ...pkg, warnings };
  }

  /** Region on the GCL is abbreviated ("West"); PAC and WO spell it out. */
  private expandRegion(region: string | null): string | null {
    if (!region) return null;
    const map: Record<string, string> = {
      west: 'Western',
      east: 'Eastern',
      north: 'Northern',
      south: 'Southern',
      central: 'Central',
    };
    return map[region.toLowerCase().trim()] ?? region;
  }

  /* ------------------------------------------------------------- pricing */

  private async priceLines(
    lines: ParsedGcl['lines'],
    fieldKey: string | null,
    quantitySource: QuantitySource,
    uplVersion: string,
  ) {
    const priceMap = await this.upl.priceMap(
      lines.map((l) => l.itemCode),
      uplVersion,
    );
    const warnings: string[] = [];

    const priced = lines.map((l) => {
      const upl = priceMap.get(l.itemCode.toUpperCase());
      const unitPrice = upl ? new Prisma.Decimal(upl.price) : D(0);

      if (!upl) {
        warnings.push(
          `${l.itemCode} is not in UPL "${uplVersion}" — priced at 0.00. Add it to the price list and re-price.`,
        );
      }

      const quantity = resolveQuantity(l, fieldKey, quantitySource);

      return {
        ...l,
        // Prefer the fuller UPL wording; fall back to whatever the GCL carried.
        description: upl?.description?.trim() || l.description,
        unit: l.unit ?? upl?.uom ?? null,
        // The UPL classifies each item code as Tangible or Service; what was
        // read off the uploaded GCL is only a fallback.
        itemType: upl?.itemType ?? l.itemType,
        unitPrice,
        quantity,
        lineTotal: unitPrice.mul(quantity),
        priceFound: !!upl,
      };
    });

    return { lines: priced, warnings };
  }

  /** Recomputes every line total and the package footer from current state. */
  async reprice(packageId: string) {
    const pkg = await this.prisma.package.findUnique({
      where: { id: packageId },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!pkg) throw new NotFoundException('Package not found');

    const priceMap = await this.upl.priceMap(
      pkg.lines.map((l) => l.itemCode),
      pkg.uplVersion,
    );

    let gross = D(0);
    const updates: Prisma.PrismaPromise<any>[] = [];

    for (const line of pkg.lines) {
      const upl = priceMap.get(line.itemCode.toUpperCase());
      const unitPrice = upl ? new Prisma.Decimal(upl.price) : line.unitPrice;

      const stored = (line.quantities ?? {}) as Record<string, number>;
      const fromField =
        pkg.quantityFieldKey && stored[pkg.quantityFieldKey] !== undefined
          ? D(stored[pkg.quantityFieldKey])
          : null;
      const quantity =
        fromField ??
        (pkg.quantitySource === QuantitySource.DESIGN ? line.designQty : line.asBuiltQty);
      const lineTotal = round2(unitPrice.mul(quantity));
      gross = gross.plus(lineTotal);

      updates.push(
        this.prisma.packageLine.update({
          where: { id: line.id },
          data: {
            unitPrice,
            quantity,
            lineTotal,
            priceFound: !!upl,
            // Re-pricing also refreshes the Tangible/Service classification, so
            // a package created before its codes were classified picks it up
            // without being rebuilt.
            itemType: upl?.itemType ?? line.itemType,
          },
        }),
      );
    }

    const net = round2(gross.minus(pkg.discount).minus(pkg.foc));
    updates.push(
      this.prisma.package.update({
        where: { id: pkg.id },
        data: { grossAmount: round2(gross), netAmount: net },
      }),
    );

    await this.prisma.$transaction(updates);
    return this.findOne(pkg.id);
  }

  /* --------------------------------------------------------------- CRUD */

  async findAll(q: QueryPackagesDto) {
    const where: any = {};
    if (q.search) {
      where.OR = [
        { woNumber: { contains: q.search, mode: 'insensitive' } },
        { siteNo: { contains: q.search, mode: 'insensitive' } },
        { poNumber: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.status) where.status = q.status;

    const take = Math.min(q.limit ?? 25, 100);
    const skip = ((q.page ?? 1) - 1) * take;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.package.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: { _count: { select: { lines: true, documents: true } } },
      }),
      this.prisma.package.count({ where }),
    ]);

    return { items, total, page: q.page ?? 1, limit: take };
  }

  async findOne(id: string) {
    const pkg = await this.prisma.package.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { sortOrder: 'asc' } },
        documents: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!pkg) throw new NotFoundException('Package not found');
    return pkg;
  }

  async update(id: string, dto: UpdatePackageDto) {
    const pkg = await this.prisma.package.findUnique({ where: { id } });
    if (!pkg) throw new NotFoundException('Package not found');

    const { lines, ...header } = dto;

    const data: Prisma.PackageUpdateInput = {
      ...header,
      poValue: header.poValue != null ? D(header.poValue) : undefined,
      discount: header.discount != null ? D(header.discount) : undefined,
      foc: header.foc != null ? D(header.foc) : undefined,
    };

    await this.prisma.package.update({ where: { id }, data });

    if (lines?.length) {
      await this.prisma.$transaction(
        lines.map((l) =>
          this.prisma.packageLine.update({
            where: { id: l.id },
            data: {
              tagNumber: l.tagNumber ?? undefined,
              serialNumber: l.serialNumber ?? undefined,
              serviceDate: l.serviceDate ?? undefined,
              designQty: l.designQty != null ? D(l.designQty) : undefined,
              asBuiltQty: l.asBuiltQty != null ? D(l.asBuiltQty) : undefined,
              description: l.description ?? undefined,
            },
          }),
        ),
      );
    }

    // Any of the above can move the money, so always settle the totals afterwards.
    return this.reprice(id);
  }

  /**
   * Deletes a package and the files it produced.
   *
   * Lines and generated-document rows cascade, but the files themselves sit on
   * disk and would otherwise accumulate with nothing pointing at them. Removal
   * is best-effort: a missing file must not block deleting the record.
   */
  async remove(id: string) {
    const pkg = await this.prisma.package.findUnique({
      where: { id },
      include: { documents: true },
    });
    if (!pkg) throw new NotFoundException('Package not found');

    for (const path of [
      ...(pkg.documents ?? []).map((d: any) => d.path),
      pkg.sourceFilePath,
      pkg.signaturePath,
    ]) {
      if (path) await this.storage.remove(path).catch(() => undefined);
    }

    this.logger.log(`Deleted package ${pkg.woNumber} (${pkg.siteNo})`);
    return this.prisma.package.delete({ where: { id } });
  }
}
