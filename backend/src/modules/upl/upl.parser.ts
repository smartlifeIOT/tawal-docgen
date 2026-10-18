import * as ExcelJS from 'exceljs';

export interface UplRow {
  line: number | null;
  itemCode: string;
  description: string;
  categoryName: string | null;
  itemType: string | null;
  uom: string | null;
  price: number;
}

/** Header aliases, so a slightly re-titled UPL still imports. */
const COLUMN_ALIASES: Record<keyof UplRow, string[]> = {
  line: ['line', 'lineno', 'line no', 's/n', 'sn', '#'],
  itemCode: ['item', 'item code', 'itemcode', 'code', 'material code'],
  description: ['description', 'desc', 'item description', 'scope'],
  categoryName: ['category name', 'category', 'categoryname', 'wbs'],
  // Both orderings: the UPL says "Item Type", the GCL form says "Tangible Or
  // Service item", and people write it either way round.
  itemType: [
    'item type',
    'itemtype',
    'type',
    'tangible or service item',
    'tangible or service',
    'tangible/service',
    'tangible or service item?',
    'service or tangible item',
    'service or tangible',
    'service/tangible',
    'tangible',
  ],
  uom: ['uom', 'unit', 'unit of measure', 'u.o.m'],
  price: ['price', 'unit price', 'rate', 'unit rate', 'amount'],
};

/**
 * Settles on the two words the GCL prints.
 *
 * The UPL is maintained by hand, so this column arrives as "Tangible",
 * "tangible", "Service item", "S" and so on. Anything unrecognised is kept
 * verbatim rather than dropped — a wrong-looking value on the form is easier
 * to spot and correct than a silently empty cell.
 */
export function normaliseItemType(value: string | null | undefined): string | null {
  const t = String(value ?? '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower.startsWith('t')) return 'Tangible';
  if (lower.startsWith('s')) return 'Service';
  return t;
}

const norm = (v: unknown) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as any;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r: any) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return String(v.result ?? '');
  }
  return String(v);
}

function cellNumber(cell: ExcelJS.Cell): number {
  const v = cell.value as any;
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'result' in v && typeof v.result === 'number') return v.result;
  const n = Number(cellText(cell).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reads a UPL workbook. Locates the header row anywhere in the first 20 rows,
 * so leading title/blank rows are tolerated.
 */
export async function parseUplWorkbook(source: string | Buffer): Promise<UplRow[]> {
  const wb = new ExcelJS.Workbook();
  // exceljs declares its own Buffer interface, which @types/node 22 no longer
  // satisfies structurally; the runtime value is exactly what it wants.
  if (Buffer.isBuffer(source)) await wb.xlsx.load(source as any);
  else await wb.xlsx.readFile(source);

  const ws = wb.worksheets[0];
  if (!ws) throw new Error('The workbook contains no worksheets.');

  // --- locate header row ---
  let headerRow = 0;
  let map: Partial<Record<keyof UplRow, number>> = {};

  for (let r = 1; r <= Math.min(20, ws.rowCount); r++) {
    const candidate: Partial<Record<keyof UplRow, number>> = {};
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const text = norm(cellText(cell));
      for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (aliases.includes(text) && candidate[field as keyof UplRow] === undefined) {
          candidate[field as keyof UplRow] = col;
        }
      }
    });
    if (candidate.itemCode !== undefined && candidate.price !== undefined) {
      headerRow = r;
      map = candidate;
      break;
    }
  }

  if (!headerRow) {
    throw new Error(
      'Could not find a header row. The UPL needs at least an "Item" column and a "Price" column.',
    );
  }

  // --- read data ---
  const rows: UplRow[] = [];
  const seen = new Set<string>();

  // Some UPL exports repeat the header on the row beneath it (and exceljs surfaces
  // a styled-but-empty row with the header's values), so any row that still looks
  // like a header is skipped rather than imported as an item priced at zero.
  const headerWords = new Set(
    Object.values(COLUMN_ALIASES).flat().map((a) => a.replace(/\s+/g, '')),
  );
  const looksLikeHeader = (text: string) => headerWords.has(norm(text).replace(/\s+/g, ''));

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rawCode = cellText(row.getCell(map.itemCode!)).trim();
    const itemCode = rawCode.toUpperCase();
    if (!itemCode || looksLikeHeader(rawCode)) continue;

    const price = cellNumber(row.getCell(map.price!));
    const key = itemCode;
    if (seen.has(key)) continue; // first occurrence wins
    seen.add(key);

    rows.push({
      line: map.line ? Number(cellText(row.getCell(map.line)).replace(/\D/g, '')) || null : null,
      itemCode,
      description: cellText(row.getCell(map.description ?? 0)).trim(),
      categoryName: map.categoryName ? cellText(row.getCell(map.categoryName)).trim() || null : null,
      itemType: map.itemType ? normaliseItemType(cellText(row.getCell(map.itemType))) : null,
      uom: map.uom ? cellText(row.getCell(map.uom)).trim() || null : null,
      price: Math.round(price * 10000) / 10000,
    });
  }

  if (!rows.length) throw new Error('No priced items were found below the header row.');
  return rows;
}
