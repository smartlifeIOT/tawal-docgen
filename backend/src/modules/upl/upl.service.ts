import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Prisma, UplItem } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { parseUplWorkbook } from './upl.parser';
import { QueryUplDto, UpsertUplItemDto } from './upl.dto';

/** The subset of a UPL row the pricing engine actually consumes. */
/**
 * What priceMap hands back: the stored UPL row.
 *
 * Deliberately the whole record rather than a hand-listed subset — the subset
 * is why callers could not reach `itemType` without this type being widened
 * first, and the next column would have cost the same edit.
 */
export type UplPrice = UplItem;

@Injectable()
export class UplService implements OnModuleInit {
  private readonly logger = new Logger(UplService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * First boot on an empty database imports the bundled UPL automatically, so a
   * fresh `docker compose up` lands on a working price list instead of a blank
   * table and confusing 0.00 prices. Set AUTO_SEED_UPL=false to opt out.
   */
  async onModuleInit() {
    if (process.env.AUTO_SEED_UPL === 'false') return;

    const count = await this.prisma.uplItem.count();
    if (count > 0) return;

    const candidates = [
      path.join(process.cwd(), 'prisma', 'upl-reference.xlsx'),
      path.join(__dirname, '..', '..', '..', 'prisma', 'upl-reference.xlsx'),
    ];
    const file = candidates.find((c) => fs.existsSync(c));

    if (!file) {
      this.logger.warn('Price list is empty and no bundled UPL was found — import one from the UI.');
      return;
    }

    try {
      const result = await this.importWorkbook(fs.readFileSync(file), 'v1');
      this.logger.log(`Auto-seeded UPL v1 with ${result.parsed} items from ${path.basename(file)}`);
    } catch (e: any) {
      this.logger.error(`Auto-seed of the UPL failed: ${e.message}`);
    }
  }

  async list(q: QueryUplDto) {
    const where: any = { version: q.version ?? 'v1' };
    if (q.search) {
      where.OR = [
        { itemCode: { contains: q.search, mode: 'insensitive' } },
        { description: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.activeOnly) where.isActive = true;

    const take = Math.min(q.limit ?? 100, 500);
    const skip = ((q.page ?? 1) - 1) * take;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.uplItem.findMany({ where, orderBy: { itemCode: 'asc' }, take, skip }),
      this.prisma.uplItem.count({ where }),
    ]);

    return { items, total, page: q.page ?? 1, limit: take };
  }

  async versions() {
    const rows = await this.prisma.uplItem.groupBy({
      by: ['version'],
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    return rows
      .map((r) => ({ version: r.version, items: r._count._all, updatedAt: r._max.updatedAt }))
      .sort((a, b) => a.version.localeCompare(b.version));
  }

  /** Price lookup used by the pricing engine. Returns a Map for O(1) joins. */
  async priceMap(itemCodes: string[], version = 'v1'): Promise<Map<string, UplPrice>> {
    const items = await this.prisma.uplItem.findMany({
      where: { version, itemCode: { in: itemCodes.map((c) => c.toUpperCase()) }, isActive: true },
    });
    return new Map(items.map((i) => [i.itemCode.toUpperCase(), i]));
  }

  async upsert(dto: UpsertUplItemDto) {
    const version = dto.version ?? 'v1';
    return this.prisma.uplItem.upsert({
      where: { version_itemCode: { version, itemCode: dto.itemCode.toUpperCase() } },
      create: { ...dto, version, itemCode: dto.itemCode.toUpperCase() },
      update: { ...dto, itemCode: dto.itemCode.toUpperCase() },
    });
  }

  async remove(id: string) {
    const found = await this.prisma.uplItem.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('UPL item not found');
    return this.prisma.uplItem.delete({ where: { id } });
  }

  /** Bulk import from an uploaded UPL workbook. Idempotent per (version, itemCode). */
  async importWorkbook(buffer: Buffer, version = 'v1') {
    let rows;
    try {
      rows = await parseUplWorkbook(buffer);
    } catch (e: any) {
      throw new BadRequestException(`UPL import failed: ${e.message}`);
    }

    const existing = await this.prisma.uplItem.findMany({
      where: { version },
      select: { itemCode: true },
    });
    const known = new Set(existing.map((e) => e.itemCode));

    await this.prisma.$transaction(
      rows.map((row) =>
        this.prisma.uplItem.upsert({
          where: { version_itemCode: { version, itemCode: row.itemCode } },
          create: { ...row, version },
          update: { ...row },
        }),
      ),
    );

    const created = rows.filter((r) => !known.has(r.itemCode)).length;
    const typed = rows.filter((r) => r.itemType).length;
    this.logger.log(
      `UPL ${version}: ${created} created, ${rows.length - created} updated, ${typed} classified`,
    );

    /*
     * An unmatched column used to import silently as all-null, which then
     * showed up as an empty "Tangible Or Service item" column on the GCL with
     * nothing to explain it. Say so here instead.
     */
    const warnings: string[] = [];
    if (!typed) {
      warnings.push(
        'No Tangible/Service values were read — the workbook has no "Item Type" column ' +
          '(or it is empty), so that column will be blank on the GCL.',
      );
    } else if (typed < rows.length) {
      warnings.push(
        `${rows.length - typed} of ${rows.length} items have no Tangible/Service value; ` +
          'those will be blank on the GCL.',
      );
    }

    return { version, parsed: rows.length, created, updated: rows.length - created, typed, warnings };
  }
}
