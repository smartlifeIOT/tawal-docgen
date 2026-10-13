import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Projects come from the Tawal-side tracker, not from this database.
 *
 * Two rules decide which projects are offered where:
 *   Create GCL  →  closeout.patTcn.status === 'Approved', plus an issued WO
 *                  and an attached scope sheet (see readyForGcl)
 *   Upload GCL  →  closeout.patStatus.status === 'Approved', plus the signed
 *                  GCL attached (see readyForUpload)
 *
 * The upstream service is outside our control, so a failure must never take a
 * screen down: the caller gets `available: false` and the UI shows N/A rather
 * than an error page.
 */

/**
 * create → an approved PAT TCN, an approved WO issuance, a WO request still at
 *          "Requested", and a scope file attached. That combination is what
 *          says "the scope is agreed and here it is" — so the GCL can be built
 *          straight from the attachment.
 * upload  → PAT approved; a signed GCL is coming back in.
 */
export type GclStage = 'create' | 'upload';

export interface ExternalProject {
  id: string;
  siteId: string;
  tawalId: string | null;
  title: string;
  description: string | null;
  category: string | null;
  status: string | null;
  priority: string | null;
  teamLead: string | null;
  region: string | null;
  city: string | null;
  startDate: string | null;
  endDate: string | null;
  patTcnStatus: string | null;
  patStatus: string | null;
  woNumber: string | null;
  tcnNumber: string | null;

  woRequestStatus: string | null;
  woIssuanceStatus: string | null;
  /** Path to the scope workbook on the tracker, relative to its origin. */
  scopeFileUrl: string | null;
  scopeFileName: string | null;

  /** The signed GCL, attached to the PAT sign-off. */
  gclFileUrl: string | null;
  gclFileName: string | null;

  /** True when a GCL can be built from the WO request's scope sheet. */
  readyForGcl: boolean;
  /** True when a signed GCL is attached and can be processed. */
  readyForUpload: boolean;
}

export interface ExternalProjectsResult {
  available: boolean;
  items: ExternalProject[];
  total: number;
  /** Left out because the tracker has no site ID for them. */
  skippedWithoutSiteId?: number;
  /** Present when the upstream call failed — shown as a hint, not an error. */
  message?: string;
  fetchedAt: string;
}

/**
 * A project is ready for a GCL when the WO has been issued and approved, the WO
 * request is still sitting at "Requested", and a scope file is attached — all
 * three, because without the attachment there is nothing to build from.
 */
/**
 * A site ID identifies the job on every document Tawal receives, so a project
 * without one cannot produce a usable GCL. Such projects are filtered out of
 * the list rather than surfaced and then rejected — being offered a choice that
 * fails on the next screen is worse than not being offered it.
 */
function hasSiteId(row: any): boolean {
  return Boolean(String(row?.siteId ?? '').trim());
}

/**
 * Ready to process a signed GCL: the PAT is approved and the signed document is
 * attached to that sign-off. Without the file there is nothing to read.
 */
function readyForUpload(closeout: any): boolean {
  return (
    eq(closeout?.patStatus?.status, 'approved') &&
    Boolean(String(closeout?.patStatus?.fileUrl ?? '').trim())
  );
}

/**
 * Ready for a GCL when all four hold:
 *   - the PAT TCN is approved — GclBuilderService refuses to build without it,
 *     so a project missing this must not be offered in the first place;
 *   - the Work Order has been issued and approved;
 *   - the WO request is still at "Requested";
 *   - a scope sheet is attached to that request, since the file is what the
 *     GCL is built from.
 *
 * Keep this in step with the guard in GclBuilderService.createFromScope: a
 * project listed here and then rejected on the next screen is worse than one
 * that was never offered.
 */
function readyForGcl(mapping: any, closeout: any): boolean {
  return (
    eq(closeout?.patTcn?.status, 'approved') &&
    eq(mapping?.woIssuance?.status, 'approved') &&
    eq(mapping?.woRequest?.status, 'requested') &&
    Boolean(String(mapping?.woRequest?.fileUrl ?? '').trim())
  );
}

const eq = (v: unknown, expected: string) =>
  String(v ?? '').trim().toLowerCase() === expected;

/** Anything absent upstream is reported as N/A rather than an empty cell. */
const NA = 'N/A';
const text = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s.length ? s : null;
};

interface CacheEntry {
  at: number;
  payload: any;
}

@Injectable()
export class ExternalProjectsService {
  private readonly logger = new Logger(ExternalProjectsService.name);
  private cache: CacheEntry | null = null;

  /** Short TTL: the UI polls every 45s, so this mainly stops several components
   *  on one page from each hitting the third-party service. */
  private readonly ttlMs = 20_000;

  constructor(private readonly config: ConfigService) {}

  private get url(): string {
    return (
      this.config.get<string>('externalProjects.url') ||
      'http://147.79.114.76:5003/api/projects/public/projects'
    );
  }

  private async fetchRaw(): Promise<any> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return this.cache.payload;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    try {
      const res = await fetch(this.url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`upstream returned ${res.status}`);

      const payload = await res.json();
      this.cache = { at: Date.now(), payload };
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  private map(row: any): ExternalProject {
    const closeout = row?.closeout ?? {};
    const mapping = row?.mapping ?? {};
    const installation = row?.installation ?? {};

    return {
      id: text(row?._id) ?? text(row?.siteId) ?? crypto.randomUUID(),
      siteId: text(row?.siteId) ?? NA,
      tawalId: text(row?.tawalId),
      title: text(row?.title) ?? text(row?.siteId) ?? NA,
      description: text(row?.description),
      category: text(row?.category),
      status: text(row?.status),
      priority: text(row?.priority),
      teamLead: text(row?.teamLead),
      region: text(row?.region),
      city: text(row?.city),
      startDate: text(row?.startDate),
      endDate: text(row?.endDate),
      patTcnStatus: text(closeout?.patTcn?.status),
      patStatus: text(closeout?.patStatus?.status),
      woNumber: text(mapping?.woIssuance?.woNumber),
      tcnNumber: text(installation?.tcnRequest?.tcnNumber),

      woRequestStatus: text(mapping?.woRequest?.status),
      woIssuanceStatus: text(mapping?.woIssuance?.status),
      scopeFileUrl: text(mapping?.woRequest?.fileUrl),
      scopeFileName: text(mapping?.woRequest?.fileName),
      gclFileUrl: text(closeout?.patStatus?.fileUrl),
      gclFileName: text(closeout?.patStatus?.fileName),
      readyForGcl: readyForGcl(mapping, closeout),
      readyForUpload: readyForUpload(closeout),
    };
  }

  /** Projects eligible for the given stage. */
  async list(stage?: GclStage): Promise<ExternalProjectsResult> {
    const fetchedAt = new Date().toISOString();

    let payload: any;
    try {
      payload = await this.fetchRaw();
    } catch (e: any) {
      const message =
        e?.name === 'AbortError'
          ? 'The projects service did not respond in time.'
          : `Could not reach the projects service (${e.message}).`;
      this.logger.warn(`External projects unavailable: ${message}`);
      return { available: false, items: [], total: 0, message, fetchedAt };
    }

    const rows: any[] = Array.isArray(payload?.data) ? payload.data : [];
    const withSiteId = rows.filter(hasSiteId);
    const skipped = rows.length - withSiteId.length;
    if (skipped) {
      this.logger.warn(`${skipped} tracker project(s) have no site ID and were left out.`);
    }

    let items = withSiteId.map((r) => this.map(r));

    if (stage === 'create') {
      items = items.filter((p) => p.readyForGcl);
    } else if (stage === 'upload') {
      // An approved PAT alone isn't enough — the signed GCL has to be attached,
      // because that document is what everything downstream is built from.
      items = items.filter((p) => p.readyForUpload);
    }

    items.sort((a, b) => a.siteId.localeCompare(b.siteId));

    return {
      available: true,
      items,
      total: Number(payload?.meta?.total ?? rows.length),
      /** Projects the tracker returned but which have no site ID. */
      skippedWithoutSiteId: skipped,
      fetchedAt,
    };
  }

  /** Used when a GCL is saved, to snapshot what the tracker said at the time. */
  async findBySiteId(siteId: string): Promise<ExternalProject | null> {
    const { items } = await this.list();
    return items.find((p) => p.siteId.toUpperCase() === siteId.toUpperCase()) ?? null;
  }

  /** Forces the next call to re-fetch — used by the refresh button. */
  invalidate() {
    this.cache = null;
  }

  /** Origin of the tracker, so a relative fileUrl can be resolved. */
  private get origin(): string {
    try {
      return new URL(this.url).origin;
    } catch {
      return '';
    }
  }

  /**
   * Pulls the scope workbook attached to the project's WO request.
   *
   * The tracker returns a path like "/uploads/UPL___reference-….xlsx", which is
   * resolved against the tracker's own host — the point is that nobody has to
   * re-upload a file that already exists upstream.
   */
  /** The signed GCL attached to the project's PAT sign-off. */
  async fetchGclFile(siteId: string): Promise<{ fileName: string; buffer: Buffer }> {
    const project = await this.findBySiteId(siteId);
    if (!project) {
      throw new NotFoundException(`Project "${siteId}" was not found in the tracker.`);
    }
    if (!project.gclFileUrl) {
      throw new BadRequestException(
        `Project "${siteId}" has no signed GCL attached to its PAT sign-off.`,
      );
    }
    return this.download(
      project.gclFileUrl,
      project.gclFileName ?? `${siteId}-GCL.pdf`,
      siteId,
      'signed GCL',
    );
  }

  /** Shared downloader — the tracker returns paths relative to its own host. */
  private async download(
    fileUrl: string,
    fallbackName: string,
    siteId: string,
    what: string,
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const href = /^https?:\/\//i.test(fileUrl)
      ? fileUrl
      : `${this.origin}${fileUrl.startsWith('/') ? '' : '/'}${fileUrl}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(href, { signal: controller.signal });
      if (!res.ok) {
        throw new BadRequestException(
          `The tracker returned ${res.status} for the ${what} of "${siteId}".`,
        );
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) {
        throw new BadRequestException(`The ${what} for "${siteId}" is empty.`);
      }

      const fileName = fallbackName || decodeURIComponent(href.split('/').pop() || 'file');
      this.logger.log(
        `Fetched ${what} for ${siteId}: ${fileName} (${(buffer.length / 1024).toFixed(0)} KB)`,
      );
      return { fileName, buffer };
    } catch (e: any) {
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      const reason = e?.name === 'AbortError' ? 'the download timed out' : e.message;
      throw new BadRequestException(
        `Could not download the ${what} for "${siteId}" — ${reason}.`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchScopeFile(siteId: string): Promise<{ fileName: string; buffer: Buffer }> {
    const project = await this.findBySiteId(siteId);
    if (!project) {
      throw new NotFoundException(`Project "${siteId}" was not found in the tracker.`);
    }
    if (!project.scopeFileUrl) {
      throw new BadRequestException(
        `Project "${siteId}" has no scope file attached to its WO request.`,
      );
    }

    const href = /^https?:\/\//i.test(project.scopeFileUrl)
      ? project.scopeFileUrl
      : `${this.origin}${project.scopeFileUrl.startsWith('/') ? '' : '/'}${project.scopeFileUrl}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(href, { signal: controller.signal });
      if (!res.ok) {
        throw new BadRequestException(
          `The tracker returned ${res.status} for the scope file of "${siteId}".`,
        );
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) {
        throw new BadRequestException(`The scope file for "${siteId}" is empty.`);
      }

      const fileName =
        project.scopeFileName ||
        decodeURIComponent(href.split('/').pop() || 'scope-sheet.xlsx');

      this.logger.log(
        `Fetched scope file for ${siteId}: ${fileName} (${(buffer.length / 1024).toFixed(0)} KB)`,
      );
      return { fileName, buffer };
    } catch (e: any) {
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      const reason = e?.name === 'AbortError' ? 'the download timed out' : e.message;
      throw new BadRequestException(
        `Could not download the scope file for "${siteId}" — ${reason}.`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
