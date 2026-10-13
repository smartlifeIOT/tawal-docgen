import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { parseGcl } from './gcl.parser';
import { PackagesService } from '../packages/packages.service';
import { StorageService } from '../storage/storage.service';
import { UplService } from '../upl/upl.service';
import { CreateFromGclDto } from '../packages/packages.dto';
import { GclBuilderService } from './gcl-builder.service';
import { CreateGclDto, CreateGclFromProjectDto } from './gcl.dto';

@Injectable()
export class GclService {
  private readonly logger = new Logger(GclService.name);

  constructor(
    private readonly packages: PackagesService,
    private readonly storage: StorageService,
    private readonly upl: UplService,
    private readonly builder: GclBuilderService,
  ) {}

  /** Stores the uploaded signature image, if one came with the request. */
  private async storeSignature(signature?: Express.Multer.File) {
    if (!signature) return undefined;
    if (!/\.(png|jpe?g)$/i.test(signature.originalname)) {
      throw new BadRequestException('The signature must be a PNG or JPEG image.');
    }
    const stored = await this.storage.saveUpload(
      signature.buffer,
      `sig-${signature.originalname}`,
    );
    return { fileName: signature.originalname, filePath: stored.filePath };
  }

  /**
   * Same as createFromScope, but the scope sheet comes from the tracker rather
   * than from an upload. The signature still arrives with the request.
   */
  async createFromProject(
    siteId: string,
    signature: Express.Multer.File | undefined,
    dto: CreateGclFromProjectDto,
  ) {
    const saved = await this.storeSignature(signature);
    return this.builder.createFromProject(siteId, dto, saved);
  }

  /** Scope sheet -> package(s) -> GCL PDF. The signature image is optional here
   *  and can be attached later from the package screen. */
  async createFromScope(
    scope: Express.Multer.File,
    signature: Express.Multer.File | undefined,
    dto: CreateGclDto,
  ) {
    const saved = await this.storeSignature(signature);

    return this.builder.createFromScope(scope.buffer, dto, saved);
  }

  private async parse(buffer: Buffer) {
    try {
      return await parseGcl(buffer);
    } catch (e: any) {
      this.logger.warn(`GCL parse failed: ${e.message}`);
      throw new BadRequestException(e.message);
    }
  }

  /** Dry run: shows what was read and which codes are missing a price. */
  async preview(buffer: Buffer, uplVersion = 'v1') {
    const parsed = await this.parse(buffer);
    const prices = await this.upl.priceMap(
      parsed.lines.map((l) => l.itemCode),
      uplVersion,
    );

    const lines = parsed.lines.map((l) => {
      const upl = prices.get(l.itemCode.toUpperCase());
      const unitPrice = upl ? Number(upl.price) : 0;

      // What the package would cost priced against each column, so the choice
      // is made with the money visible rather than guessed at.
      const totals: Record<string, number> = {};
      for (const c of parsed.quantityColumns) {
        totals[c.key] = unitPrice * (l.quantities[c.key] ?? 0);
      }

      return { ...l, unitPrice, priceFound: !!upl, totals };
    });

    const columnTotals = parsed.quantityColumns.map((c) => ({
      ...c,
      total: lines.reduce((a, l) => a + (l.totals[c.key] ?? 0), 0),
      quantity: lines.reduce((a, l) => a + (l.quantities[c.key] ?? 0), 0),
    }));

    return {
      ...parsed,
      lines,
      quantityColumns: columnTotals,
      /** Second column on a standard GCL is As-Built, which is what Tawal bills. */
      suggestedFieldKey:
        parsed.quantityColumns[1]?.key ?? parsed.quantityColumns[0]?.key ?? null,
      unpricedItems: lines.filter((l) => !l.priceFound).map((l) => l.itemCode),
    };
  }

  async ingest(buffer: Buffer, originalName: string, dto: CreateFromGclDto) {
    const parsed = await this.parse(buffer);
    const saved = await this.storage.saveUpload(buffer, originalName);
    return this.packages.createFromGcl(parsed, dto, {
      fileName: originalName,
      filePath: saved.filePath,
    });
  }
}
