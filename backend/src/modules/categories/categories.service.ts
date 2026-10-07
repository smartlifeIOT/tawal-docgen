import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { listTemplates } from '../mop/mop.templates';
import { ExternalProjectsService } from '../external-projects/external-projects.service';
import { UpsertMopCategoryDto, UpsertProjectCategoryDto, UpsertTemplateLinkDto } from './categories.dto';

const slugify = (v: string) =>
  v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * Starting catalog. Projects are NOT seeded — you create those yourself — but the
 * categories and their template pairings are, so the first MOP can be made
 * without configuring anything. All of it is editable afterwards.
 */
/** Colours handed out to tracker categories as they appear. */
const PALETTE = ['#01C2F3', '#C36BA9', '#F59042', '#44489D', '#1D174C', '#2BB673'];

const SEED_MOP_CATEGORIES = [
  { name: 'Survey', sortOrder: 0 },
  { name: 'Installation', sortOrder: 1 },
  { name: 'PAT', sortOrder: 2 },
];


@Injectable()
export class CategoriesService implements OnModuleInit {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly externalProjects: ExternalProjectsService,
  ) {}

  async onModuleInit() {
    // Only the MOP categories are seeded. Project categories come from the
    // tracker, so seeding them would invent kinds of project nobody uses.
    if (await this.prisma.mopCategory.count()) return;

    const mopCats = new Map<string, string>();
    for (const c of SEED_MOP_CATEGORIES) {
      const created = await this.prisma.mopCategory.create({
        data: { ...c, slug: slugify(c.name) },
      });
      mopCats.set(c.name, created.id);
    }

    this.logger.log(`Seeded ${SEED_MOP_CATEGORIES.length} MOP categories`);
  }

  /**
   * Mirrors the distinct `category` values the tracker is currently using.
   *
   * Called before every read, so a category that appears upstream is usable
   * immediately — without it, projects in a new category could not produce any
   * MOP and the reason would not be obvious. Categories are never deleted: MOPs
   * already generated under one still reference it.
   */
  async syncFromTracker() {
    const { available, items } = await this.externalProjects.list();
    if (!available) return;

    const seen = new Map<string, string>();
    for (const p of items) {
      const name = (p.category ?? '').trim();
      if (name) seen.set(name.toLowerCase(), name);
    }
    if (!seen.size) return;

    const existing = await this.prisma.projectCategory.findMany();
    const known = new Map<string, { id: string; name: string }>(
      existing.map((c: any) => [c.name.toLowerCase(), c]),
    );

    let order = existing.length;
    for (const [key, name] of seen) {
      const row = known.get(key);
      if (row) {
        await this.prisma.projectCategory.update({
          where: { id: row.id },
          data: { lastSeenAt: new Date() },
        });
      } else {
        await this.prisma.projectCategory.create({
          data: {
            name,
            slug: slugify(name),
            colour: PALETTE[order % PALETTE.length],
            sortOrder: order++,
            lastSeenAt: new Date(),
          },
        });
        this.logger.log(`New project category from the tracker: "${name}"`);
      }
    }
  }

  /* ------------------------------------------------- project categories */

  async projectCategories(includeInactive = false) {
    await this.syncFromTracker().catch((e) =>
      this.logger.warn(`Category sync skipped: ${e.message}`),
    );

    return this.prisma.projectCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        templates: { include: { mopCategory: true } },
        _count: { select: { documents: true } },
      },
    });
  }

  /**
   * Creates a category the tracker does not have.
   *
   * Categories normally mirror the tracker, but MOPs can be raised for work
   * outside it, and those need a category of their own to pair MOP formats
   * against. A custom one has no `lastSeenAt`, which is how it stays
   * distinguishable from a mirrored one.
   */
  async createProjectCategory(dto: UpsertProjectCategoryDto) {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('A category name is required.');

    const existing = await this.prisma.projectCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) {
      throw new BadRequestException(`A project category called "${name}" already exists.`);
    }

    const count = await this.prisma.projectCategory.count();
    return this.prisma.projectCategory.create({
      data: {
        ...dto,
        name,
        slug: slugify(name),
        colour: dto.colour ?? PALETTE[count % PALETTE.length],
        sortOrder: dto.sortOrder ?? count,
      },
    });
  }

  /**
   * Removes a category. Refused when documents were generated under it — those
   * records would lose what form they were built from.
   */
  async removeProjectCategory(id: string) {
    const category = await this.getProjectCategory(id);

    const documents = await this.prisma.mopDocument.count({
      where: { projectCategoryId: id },
    });
    if (documents) {
      throw new BadRequestException(
        `"${category.name}" has ${documents} document(s) generated under it, so it cannot be deleted. ` +
          `Hide it instead by unticking Visible.`,
      );
    }

    await this.prisma.categoryTemplate.deleteMany({ where: { projectCategoryId: id } });
    return this.prisma.projectCategory.delete({ where: { id } });
  }

  /** Only presentation is editable on a mirrored category. */
  async updateProjectCategory(id: string, dto: Partial<UpsertProjectCategoryDto>) {
    await this.getProjectCategory(id);
    // The name is editable on a custom category; on a mirrored one the tracker
    // owns it and a sync would overwrite the change anyway.
    const current = await this.prisma.projectCategory.findUnique({ where: { id } });
    const { slug, name, ...rest } = dto;
    const renameable = current && !current.lastSeenAt && name?.trim();

    return this.prisma.projectCategory.update({
      where: { id },
      data: renameable ? { ...rest, name: name.trim(), slug: slugify(name) } : rest,
    });
  }

  /** Resolves a tracker category string to its local row. */
  async resolveByName(name: string | null | undefined) {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return null;
    return this.prisma.projectCategory.findFirst({
      where: { name: { equals: trimmed, mode: 'insensitive' } },
      include: { templates: { include: { mopCategory: true } } },
    });
  }

  private async getProjectCategory(id: string) {
    const cat = await this.prisma.projectCategory.findUnique({ where: { id } });
    if (!cat) throw new NotFoundException('Project category not found');
    return cat;
  }

  /* ----------------------------------------------------- MOP categories */

  mopCategories(includeInactive = false) {
    return this.prisma.mopCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        templates: { include: { projectCategory: true } },
        _count: { select: { documents: true } },
      },
    });
  }

  async createMopCategory(dto: UpsertMopCategoryDto) {
    const slug = slugify(dto.slug || dto.name);
    if (await this.prisma.mopCategory.findUnique({ where: { slug } })) {
      throw new ConflictException(`A MOP category "${dto.name}" already exists`);
    }
    return this.prisma.mopCategory.create({
      data: { ...dto, slug, sortOrder: dto.sortOrder ?? 99 },
    });
  }

  async updateMopCategory(id: string, dto: Partial<UpsertMopCategoryDto>) {
    const cat = await this.prisma.mopCategory.findUnique({ where: { id } });
    if (!cat) throw new NotFoundException('MOP category not found');
    const { slug, ...rest } = dto;
    return this.prisma.mopCategory.update({ where: { id }, data: rest });
  }

  async removeMopCategory(id: string) {
    const cat = await this.prisma.mopCategory.findUnique({
      where: { id },
      include: { _count: { select: { documents: true } } },
    });
    if (!cat) throw new NotFoundException('MOP category not found');
    if (cat._count.documents > 0) {
      throw new BadRequestException(
        `${cat._count.documents} document(s) were generated in this category. Hide it instead of deleting.`,
      );
    }
    await this.prisma.mopCategory.delete({ where: { id } });
    return { deleted: true };
  }

  /* --------------------------------------------------------- pairings */

  templates() {
    return listTemplates();
  }

  /** Which MOP categories a given project category offers. */
  async availableFor(projectCategoryId: string) {
    return this.prisma.categoryTemplate.findMany({
      where: { projectCategoryId, mopCategory: { isActive: true } },
      include: { mopCategory: true },
      orderBy: { mopCategory: { sortOrder: 'asc' } },
    });
  }

  async linkTemplate(dto: UpsertTemplateLinkDto) {
    const available = listTemplates().map((t) => t.key);
    if (!available.includes(dto.templateKey)) {
      throw new BadRequestException(
        `Unknown MOP format "${dto.templateKey}". Available: ${available.join(', ')}`,
      );
    }
    return this.prisma.categoryTemplate.upsert({
      where: {
        projectCategoryId_mopCategoryId: {
          projectCategoryId: dto.projectCategoryId,
          mopCategoryId: dto.mopCategoryId,
        },
      },
      create: dto,
      update: { templateKey: dto.templateKey, defaultTcnSummary: dto.defaultTcnSummary },
      include: { mopCategory: true, projectCategory: true },
    });
  }

  async unlinkTemplate(projectCategoryId: string, mopCategoryId: string) {
    await this.prisma.categoryTemplate.deleteMany({
      where: { projectCategoryId, mopCategoryId },
    });
    return { unlinked: true };
  }
}
