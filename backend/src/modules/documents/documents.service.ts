import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DocumentType, PackageOrigin, PackageStatus } from '@prisma/client';
import archiver from 'archiver';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { PdfRenderer } from './generators/pdf.renderer';
import { BoqExcelGenerator } from './generators/boq-excel.generator';
import { WoExcelGenerator } from './generators/wo-excel.generator';
import { fileDataUri, logos, stamp } from './generators/assets';
import { CertExcelGenerator } from './generators/cert-excel.generator';

/** Strips anything that would be awkward in a filename, keeping it readable. */
const fileSafe = (v: string | null | undefined) =>
  String(v ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

/** Reads a stored file, or null if it has gone missing. */
function readFileSafe(p: string): Buffer | null {
  try {
    return require('fs').readFileSync(p);
  } catch {
    return null;
  }
}

type BatchWithPackages = {
  id: string;
  reference: string;
  packages: PackageWithLines[];
};
import { PackageWithLines } from './documents.types';

/** Appends ".SN: xxx" unless the description already mentions the serial. */
function withSerial(description: string, serial?: string | null): string {
  const text = (description ?? '').trim();
  const sn = (serial ?? '').trim();
  if (!sn) return text;
  if (new RegExp(`S\\s*\\.?\\s*N\\s*[:.\\-]?\\s*${sn}`, 'i').test(text)) return text;
  return text ? `${text} .SN: ${sn}` : `SN: ${sn}`;
}

const WO_TABLE_ROWS = 14; // Tawal's Work Order grid is a fixed 14-row form
// See the note on CERT_ROWS: the grid holds 13 without running into the
// signature block below it.
const PAC_TABLE_ROWS = 13;

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly pdf: PdfRenderer,
    private readonly certExcel: CertExcelGenerator,
    private readonly boqExcel: BoqExcelGenerator,
    private readonly woExcel: WoExcelGenerator,
  ) {}

  private async load(packageId: string): Promise<PackageWithLines> {
    const pkg = await this.prisma.package.findUnique({
      where: { id: packageId },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!pkg) throw new NotFoundException('Package not found');
    if (!pkg.lines.length) throw new BadRequestException('This package has no BOQ lines.');
    return pkg;
  }

  /* --------------------------------------------------------- view models */

  /** The GCL is the source form: design + as-built quantities, no money on it. */
  private gclView(pkg: PackageWithLines) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const d = pkg.gclDate ? new Date(pkg.gclDate) : null;

    return {
      ...logos(),
      stamp: stamp(),
      signature: fileDataUri(pkg.signaturePath),
      tawalSiteId: pkg.tawalSiteId ?? '',
      woNumber: pkg.woNumber,
      siteNo: pkg.siteNo,
      projectName: pkg.projectName,
      region: pkg.region ?? '',
      district: pkg.district ?? '',
      poNumber: pkg.poNumber ?? '',
      // Tawal prints "16 Agu 2026" on the form; keep the same day-month-year shape.
      gclDateLabel: d ? `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '',
      contractorPmName: pkg.contractorPmName ?? '',
      mspRepName: pkg.mspRepName ?? '',
      mspSignDate: pkg.mspSignDate,
      notes: pkg.notes ?? '',
      rows: pkg.lines.map((l) => ({
        no: l.no,
        itemCode: l.itemCode,
        // Tawal's GCL prints the serial at the end of the description
        // ("… 19'' Rack SN:Y6640250028"), so append it unless the description
        // already carries one — parsed GCLs bring it along in the text.
        description: withSerial(l.description, l.serialNumber),
        unit: l.unit ?? '',
        designQty: Number(l.designQty),
        asBuiltQty: Number(l.asBuiltQty),
        itemType: l.itemType ?? '',
      })),
    };
  }

  private boqView(pkg: PackageWithLines) {
    return {
      ...logos(),
      woNumber: pkg.woNumber,
      siteNo: pkg.siteNo,
      region: pkg.region ?? '',
      district: pkg.district ?? '',
      poNumber: pkg.poNumber ?? '',
      projectName: pkg.projectName,
      contractorName: pkg.contractorName,
      contractorPmName: pkg.contractorPmName ?? '',
      mspRepName: pkg.mspRepName ?? '',
      notes: pkg.notes ?? '',
      rows: pkg.lines.map((l) => ({
        woNumber: pkg.woNumber,
        itemCode: l.itemCode,
        quantity: Number(l.quantity),
        tagNumber: l.tagNumber || 'N/A',
        serviceDate: l.serviceDate ?? pkg.serviceDate ?? pkg.endDate,
      })),
    };
  }

  /**
   * The Work Order form lists one row per SITE, not per BOQ item — the amount
   * column carries the whole site's gross. Multi-site POs simply add rows.
   */
  private woView(pkg: PackageWithLines) {
    return {
      ...logos(),
      contractorName: pkg.contractorName,
      projectName: pkg.projectName,
      poNumber: pkg.poNumber ?? '',
      poValue: pkg.poValue != null ? Number(pkg.poValue) : null,
      grossAmount: Number(pkg.grossAmount),
      discount: Number(pkg.discount),
      foc: Number(pkg.foc),
      netAmount: Number(pkg.netAmount),
      tawalPmName: pkg.tawalPmName ?? '',
      tableRows: WO_TABLE_ROWS,
      rows: [
        {
          sn: 1,
          siteId: pkg.siteNo,
          woNumber: pkg.woNumber,
          handoverDate: pkg.handoverDate,
          startDate: pkg.startDate,
          endDate: pkg.endDate,
          amount: Number(pkg.grossAmount),
        },
      ],
    };
  }

  private pacView(pkg: PackageWithLines) {
    return {
      ...logos(),
      // Carried from the GCL this certificate follows from.
      stamp: stamp(),
      signature: pkg.signaturePath ? fileDataUri(pkg.signaturePath) : null,
      projectName: pkg.projectName,
      contractorName: pkg.contractorName,
      poNumber: pkg.poNumber ?? '',
      contractorPmName: (pkg.contractorPmName ?? '').toUpperCase(),
      contractorPmId: pkg.contractorPmId ?? '',
      gclDate: pkg.contractorSignDate,
      tawalPmName: pkg.tawalPmName ?? '',
      tawalPmId: pkg.tawalPmId ?? '',
      /*
       * The date beside the contractor's signature on the GCL — not the header
       * date, and not today's.
       *
       * Deliberately no fallback: if the signing date wasn't read, the field
       * prints blank. Substituting the header date produces a plausible-looking
       * wrong date on a document Tawal relies on, which is worse than a gap
       * somebody can see and fill in.
       */
      pacDate: pkg.contractorSignDate,
      tableRows: PAC_TABLE_ROWS,
      rows: [
        {
          siteId: pkg.siteNo,
          region: pkg.region ?? '',
          district: pkg.district ?? '',
          woNumber: pkg.woNumber,
        },
      ],
    };
  }

  /* ----------------------------------------------------------- generation */

  private fileName(pkg: PackageWithLines, type: DocumentType) {
    // [Site]_[Type], e.g. ZMS009_WO.pdf. The Work Order number is long enough
    // to make a filename unreadable, and the site already identifies the job.
    const base = fileSafe(pkg.siteNo) || fileSafe(pkg.woNumber) || 'document';
    const map: Record<DocumentType, string> = {
      GCL_PDF: `${base}_GCL.pdf`,
      BOQ_XLSX: `${base}_AsBuilt_BOQ.xlsx`,
      BOQ_PDF: `${base}_AsBuilt_BOQ.pdf`,
      WO_XLSX: `${base}_WO.xlsx`,
      WO_PDF: `${base}_WO.pdf`,
      PAC_PDF: `${base}_PAC.pdf`,
      FAC_PDF: `${base}_FAC.pdf`,
      PAC_XLSX: `${base}_PAC.xlsx`,
      FAC_XLSX: `${base}_FAC.xlsx`,
      BUNDLE_ZIP: `${base}_Package.zip`,
    };
    return map[type];
  }

  private async buildOne(pkg: PackageWithLines, type: DocumentType): Promise<Buffer> {
    switch (type) {
      case DocumentType.GCL_PDF:
        return this.pdf.render('gcl', this.gclView(pkg));
      case DocumentType.BOQ_XLSX:
        return this.boqExcel.build(pkg);
      case DocumentType.BOQ_PDF:
        return this.pdf.render('boq', this.boqView(pkg));
      case DocumentType.WO_XLSX:
        return this.woExcel.build(pkg);
      case DocumentType.WO_PDF:
        return this.pdf.render('wo', this.woView(pkg));
      case DocumentType.PAC_PDF:
        return this.pdf.render('pac', this.pacView(pkg));
      case DocumentType.FAC_PDF:
        // Same data, different stage — see templates/fac.hbs.
        return this.pdf.render('fac', this.pacView(pkg));
      case DocumentType.PAC_XLSX:
        return this.certExcel.build('PAC', this.singleCertView(pkg));
      case DocumentType.FAC_XLSX:
        return this.certExcel.build('FAC', this.singleCertView(pkg));
      default:
        throw new BadRequestException(`${type} cannot be generated directly.`);
    }
  }

  private async persist(pkg: PackageWithLines, type: DocumentType, data: Buffer) {
    const fileName = this.fileName(pkg, type);
    const { filePath, sizeBytes } = await this.storage.saveDocument(pkg.id, fileName, data);

    // One current file per type per package.
    await this.prisma.generatedDocument.deleteMany({ where: { packageId: pkg.id, type } });
    return this.prisma.generatedDocument.create({
      data: { packageId: pkg.id, type, fileName, path: filePath, sizeBytes },
    });
  }

  /* ==================================================================
     Batch documents
     ================================================================== */

  /**
   * The combined view for a batch.
   *
   * The Work Order takes one row per site — its template already renders a
   * `rows` array, so a hundred sites is the same form with a hundred rows
   * rather than a hundred forms. The BOQ concatenates every line across every
   * site, with the site number carried onto each row so a line can still be
   * traced back.
   *
   * Header fields (project, PO, contractor) come from the first package: they
   * describe the engagement, which is the same for every site in a batch.
   */
  private batchView(batch: BatchWithPackages, type: DocumentType) {
    const packages = batch.packages;
    const first = packages[0];

    const gross = packages.reduce((a, p) => a + Number(p.grossAmount), 0);
    const discount = packages.reduce((a, p) => a + Number(p.discount), 0);
    const foc = packages.reduce((a, p) => a + Number(p.foc), 0);
    const net = packages.reduce((a, p) => a + Number(p.netAmount), 0);

    const common = {
      ...logos(),
      stamp: stamp(),
      batchReference: batch.reference,
      contractorName: first.contractorName,
      projectName: first.projectName,
      subProjectName: first.subProjectName ?? '',
      poNumber: first.poNumber ?? '',
      currency: first.currency,
      siteCount: packages.length,
      grossAmount: gross,
      discount,
      foc,
      netAmount: net,
      contractorPmName: first.contractorPmName ?? '',
      tawalPmName: first.tawalPmName ?? '',
      issueDate: new Date().toLocaleDateString('en-GB'),
    };

    if (type === DocumentType.WO_XLSX || type === DocumentType.WO_PDF) {
      return {
        ...common,
        poValue: first.poValue != null ? Number(first.poValue) : null,
        // One row per site, padded so a short batch still looks like the form.
        tableRows: Math.max(WO_TABLE_ROWS, packages.length),
        rows: packages.map((p, i) => ({
          sn: i + 1,
          siteId: p.siteNo,
          woNumber: p.woNumber,
          handoverDate: p.handoverDate,
          startDate: p.startDate,
          endDate: p.endDate,
          amount: Number(p.grossAmount),
        })),
      };
    }

    if (type === DocumentType.BOQ_XLSX || type === DocumentType.BOQ_PDF) {
      let n = 0;
      return {
        ...common,
        /*
         * The BOQ header identifies the job. On a multi-site batch there is no
         * single site, so the first one names it and the per-row WO number
         * keeps every line traceable.
         */
        siteNo: first.siteNo,
        region: first.region ?? '',
        district: first.district ?? '',
        woNumber: first.woNumber,
        notes: first.notes ?? '',
        rows: packages.flatMap((p) =>
          p.lines.map((l) => ({
            no: ++n,
            // Each line carries its own Work Order, which is what keeps a
            // combined BOQ traceable back to a site.
            woNumber: p.woNumber,
            siteNo: p.siteNo,
            itemCode: l.itemCode,
            // Composed the same way as the single-package GCL. No batch
            // template renders a description today, so this changes nothing
            // on the current forms — it is here so that adding a description
            // column later carries the serial instead of silently dropping it,
            // which is the bug this mirrors.
            description: withSerial(l.description, l.serialNumber),
            unit: l.unit ?? '',
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice),
            lineTotal: Number(l.lineTotal),
            tagNumber: l.tagNumber ?? '',
            serialNumber: l.serialNumber ?? '',
          })),
        ),
      };
    }

    /*
     * The certificate grids are fixed geometry: the PAC's runs from 242.5pt to
     * the signature block at 466.7pt, which is 14 rows of 14.97pt plus a
     * header. Padding beyond that pushes rows over the signatures — which is
     * what produced the stray row and the column rules through the
     * Contractor Project Manager block.
     */
    /*
     * The grid runs from 242.5pt to the signature header at 466.7pt — 224.2pt.
     * After the 13.7pt column header that leaves room for 13 rows of 14.97pt
     * once collapsed borders are counted. A fourteenth prints underneath the
     * Contractor Project Manager block, which is what showed as stray rules
     * through it.
     */
    const CERT_ROWS = 13;
    // Both certificate templates read `siteId`; `siteNo` is the column name on
    // the package. Mismatching the two is what left the PAC's Site ID blank.
    const rows = packages.map((p) => ({
      siteId: p.siteNo,
      siteNo: p.siteNo,
      region: p.region ?? '',
      district: p.district ?? '',
      woNumber: p.woNumber,
    }));
    while (rows.length < CERT_ROWS) {
      rows.push({ siteId: '', siteNo: '', region: '', district: '', woNumber: '' });
    }

    return {
      ...common,
      // The template pads with {{#padRows rows tableRows}}, so it needs to know
      // how many the grid holds.
      tableRows: CERT_ROWS,
      // The certificate is signed by the contractor's project manager, not the
      // MSP representative — the MSP signs the GCL, not what follows from it.
      contractorPmName: (first.contractorPmName ?? '').toUpperCase(),
      contractorPmId: first.contractorPmId ?? '',
      signature: first.signaturePath ? fileDataUri(first.signaturePath) : null,
      // Dated from the contractor's signature on the GCL, with no fallback —
      // see the note in pacView.
      gclDate: first.contractorSignDate,
      pacDate: first.contractorSignDate,
      rows,
    };
  }

  /** Reshapes the certificate view for the workbook generator. */
  private certView(batch: BatchWithPackages, view: any): any {
    const first = batch.packages[0];
    return {
      projectName: view.projectName,
      subProjectName: view.subProjectName,
      contractorName: view.contractorName,
      poNumber: view.poNumber,
      contractorPmName: view.contractorPmName,
      contractorPmId: view.contractorPmId,
      signedDate: first.contractorSignDate
        ? new Date(first.contractorSignDate).toLocaleDateString('en-GB')
        : '',
      rows: batch.packages.map((p) => ({
        siteNo: p.siteNo,
        region: p.region ?? '',
        district: p.district ?? '',
        woNumber: p.woNumber,
      })),
      signature: first.signaturePath ? readFileSafe(first.signaturePath) : null,
    };
  }

  private singleCertView(pkg: PackageWithLines): any {
    return {
      projectName: pkg.projectName,
      subProjectName: pkg.subProjectName ?? '',
      contractorName: pkg.contractorName,
      poNumber: pkg.poNumber ?? '',
      contractorPmName: (pkg.contractorPmName ?? '').toUpperCase(),
      contractorPmId: pkg.contractorPmId ?? '',
      signedDate: pkg.contractorSignDate
        ? new Date(pkg.contractorSignDate).toLocaleDateString('en-GB')
        : '',
      rows: [
        {
          siteNo: pkg.siteNo,
          region: pkg.region ?? '',
          district: pkg.district ?? '',
          woNumber: pkg.woNumber,
        },
      ],
      signature: pkg.signaturePath ? readFileSafe(pkg.signaturePath) : null,
    };
  }

  private async buildBatchOne(batch: BatchWithPackages, type: DocumentType): Promise<Buffer> {
    const view = this.batchView(batch, type);

    switch (type) {
      case DocumentType.BOQ_XLSX:
        return this.boqExcel.buildMany(batch.packages);
      case DocumentType.WO_XLSX:
        return this.woExcel.buildMany(batch.packages);
      case DocumentType.BOQ_PDF:
        return this.pdf.render('boq', view);
      case DocumentType.WO_PDF:
        return this.pdf.render('wo', view);
      case DocumentType.PAC_PDF:
        return this.pdf.render('pac', view);
      case DocumentType.FAC_PDF:
        return this.pdf.render('fac', view);
      case DocumentType.PAC_XLSX:
        return this.certExcel.build('PAC', this.certView(batch, view));
      case DocumentType.FAC_XLSX:
        return this.certExcel.build('FAC', this.certView(batch, view));
      default:
        throw new BadRequestException(`${type} cannot be produced for a batch.`);
    }
  }

  /**
   * Produces one document covering the given packages, stored against the
   * batch rather than any single package.
   */
  async generateCombined(batchId: string, type: DocumentType, packageIds: string[]) {
    const batch = await this.prisma.gclBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Batch not found');

    const packages = await this.prisma.package.findMany({
      where: { id: { in: packageIds } },
      include: { lines: { orderBy: { no: 'asc' } } },
      orderBy: { siteNo: 'asc' },
    });
    if (!packages.length) {
      throw new BadRequestException('No packages were given for this document.');
    }

    const data = await this.buildBatchOne({ ...batch, packages } as BatchWithPackages, type);

    const ext = type.endsWith('XLSX') ? 'xlsx' : 'pdf';
    const label = type === DocumentType.BOQ_XLSX || type === DocumentType.BOQ_PDF
      ? 'AsBuilt_BOQ'
      : type.replace(/_(PDF|XLSX)$/, '');

    /*
     * A single-site batch is named exactly like a standalone document; only a
     * genuinely multi-site one carries the site count, because there is no one
     * site or work order to name it after.
     */
    const first = packages[0];
    const base = fileSafe(first.siteNo) || fileSafe(first.woNumber) || 'document';
    const fileName =
      packages.length === 1
        ? `${base}_${label}.${ext}`
        : `${base}_and-${packages.length - 1}-more_${label}.${ext}`;

    const saved = await this.storage.saveDocument(`batches/${batch.id}`, fileName, data);

    // Regenerating replaces the previous copy rather than piling up versions.
    await this.prisma.generatedDocument.deleteMany({ where: { gclBatchId: batch.id, type } });

    return this.prisma.generatedDocument.create({
      data: {
        gclBatchId: batch.id,
        type,
        fileName,
        path: saved.filePath,
        sizeBytes: data.length,
      },
    });
  }

  async generate(packageId: string, types?: DocumentType[]) {
    const pkg = await this.load(packageId);

    const unpriced = pkg.lines.filter((l) => !l.priceFound).map((l) => l.itemCode);
    const wanted = types?.length
      ? types
      : [
          // A package built from a scope sheet has no GCL yet, so make one first.
          ...(pkg.origin === PackageOrigin.SCOPE_SHEET ? [DocumentType.GCL_PDF] : []),
          DocumentType.BOQ_XLSX,
          DocumentType.BOQ_PDF,
          DocumentType.WO_XLSX,
          DocumentType.WO_PDF,
          DocumentType.PAC_PDF,
        ];

    const documents = [];
    for (const type of wanted) {
      const buffer = await this.buildOne(pkg, type);
      documents.push(await this.persist(pkg, type, buffer));
      this.logger.log(`${pkg.woNumber}: generated ${type}`);
    }

    await this.prisma.package.update({
      where: { id: pkg.id },
      data: { status: PackageStatus.GENERATED },
    });

    return {
      packageId: pkg.id,
      documents,
      warnings: unpriced.length
        ? [`Priced at 0.00 (missing from UPL): ${unpriced.join(', ')}`]
        : [],
    };
  }

  /** Regenerates on demand and streams the bytes without touching disk state. */
  async buildInline(packageId: string, type: DocumentType) {
    const pkg = await this.load(packageId);
    return { fileName: this.fileName(pkg, type), buffer: await this.buildOne(pkg, type) };
  }

  async listDocuments(packageId: string) {
    return this.prisma.generatedDocument.findMany({
      where: { packageId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getFile(documentId: string) {
    const doc = await this.prisma.generatedDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException('Document not found');
    if (!(await this.storage.exists(doc.path))) {
      throw new NotFoundException('File is missing from storage — regenerate the package.');
    }
    return doc;
  }

  /** Zips every current document for the package. */
  async bundle(packageId: string): Promise<{ fileName: string; buffer: Buffer }> {
    const pkg = await this.load(packageId);
    let docs = await this.listDocuments(packageId);

    if (!docs.length) {
      await this.generate(packageId);
      docs = await this.listDocuments(packageId);
    }

    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (c) => chunks.push(c));

    const done = new Promise<void>((resolve, reject) => {
      archive.on('end', () => resolve());
      archive.on('error', reject);
    });

    for (const doc of docs) {
      if (doc.type === DocumentType.BUNDLE_ZIP) continue;
      if (await this.storage.exists(doc.path)) {
        archive.append(await this.storage.read(doc.path), { name: doc.fileName });
      }
    }

    if (pkg.sourceFilePath && (await this.storage.exists(pkg.sourceFilePath))) {
      archive.append(await this.storage.read(pkg.sourceFilePath), {
        name: `source/${pkg.sourceFileName ?? 'GCL.pdf'}`,
      });
    }

    await archive.finalize();
    await done;

    return { fileName: this.fileName(pkg, DocumentType.BUNDLE_ZIP), buffer: Buffer.concat(chunks) };
  }
}
