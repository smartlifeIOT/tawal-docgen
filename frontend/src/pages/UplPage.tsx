import { useEffect, useState } from 'react';
import { Search, Upload } from 'lucide-react';
import FileDrop from '../components/FileDrop';
import { Alert, Empty, Spinner } from '../components/ui/Feedback';
import { Card, CardHead } from '../components/ui/Card';
import { Field, Input } from '../components/ui/Field';
import { Badge } from '../components/ui/Badge';
import { api, money } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Paged, UplItem } from '../lib/types';

export default function UplPage() {
  const { can } = useAuth();
  const canCreate = can('priceList', 'create');
  // Individual rows aren't editable here yet; when they are, gate them on
  // can('priceList', 'edit') / can('priceList', 'delete').
  const [data, setData] = useState<Paged<UplItem> | null>(null);
  const [versions, setVersions] = useState<{ version: string; items: number }[]>([]);
  const [version, setVersion] = useState('v1');
  const [search, setSearch] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = () =>
    api
      .get<Paged<UplItem>>(`/upl?version=${version}&limit=200${search ? `&search=${encodeURIComponent(search)}` : ''}`)
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    api.get<typeof versions>('/upl/versions').then(setVersions).catch(() => undefined);
  }, []);

  useEffect(() => {
    const t = setTimeout(reload, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, version]);

  async function importFile(f: File) {
    setFile(f);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.upload<{ parsed: number; created: number; updated: number }>(
        '/upl/import', f, { version },
      );
      setNotice(`${r.parsed} rows read — ${r.created} added, ${r.updated} updated in "${version}".`);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight gradient-text animate-gradient-pan">Unit Price List</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Item codes on a GCL are priced from here. Keep old versions so historical packages stay reproducible.
        </p>
      </div>

      {/* Importing replaces prices, so it needs create — a view-only user sees
          the versions list and the table, and nothing that writes. */}
      {canCreate && (
      <div className="grid gap-4 md:grid-cols-[1fr_320px]">
        <FileDrop
          accept=".xlsx,.xls"
          file={file}
          onFile={importFile}
          hint="UPL workbook — needs at least an Item column and a Price column"
        />
        <div className="surface space-y-3 px-5 py-4">
          <div>
            <label className="label">Import into version</label>
            <Input value={version} onChange={(e) => setVersion(e.target.value)} />
          </div>
          <div className="text-xs text-fg-muted">
            {versions.length === 0
              ? 'No versions imported yet.'
              : versions.map((v) => (
                  <div key={v.version} className="flex justify-between border-b border-slate-100 py-1 last:border-0">
                    <span className="font-medium text-fg-muted">{v.version}</span>
                    <span>{v.items} items</span>
                  </div>
                ))}
          </div>
        </div>
      </div>
      )}

      {!canCreate && versions.length > 0 && (
        <div className="surface px-5 py-4">
          <p className="label">Versions</p>
          <div className="mt-1 text-xs text-fg-muted">
            {versions.map((v) => (
              <div key={v.version} className="flex justify-between border-b border-line/50 py-1 last:border-0">
                <span className="font-medium text-fg-muted">{v.version}</span>
                <span>{v.items} items</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {busy && <Spinner label="Importing…" />}
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success"><span className="inline-flex items-center gap-2"><Upload size={14} />{notice}</span></Alert>}

      <div className="relative w-full max-w-md">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <Input className="pl-9" placeholder="Search item code or description"
               value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {data && data.items.length === 0 && <Empty>No priced items in "{version}".</Empty>}

      {data && data.items.length > 0 && (
        <div className="surface overflow-x-auto">
          <div className="surface-head">
            <span className="text-sm font-semibold text-fg">{data.total} items</span>
            <span className="text-xs text-fg-subtle">version {version}</span>
          </div>
          <table className="w-full min-w-[720px]">
            <thead>
              <tr>
                <th className="th w-16">Line</th>
                <th className="th w-40">Item Code</th>
                <th className="th">Description</th>
                <th className="th w-28">Type</th>
                <th className="th w-20">UOM</th>
                <th className="th w-32 text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id} className="hover:bg-canvas">
                  <td className="td text-fg-subtle">{i.line ?? '—'}</td>
                  <td className="td font-mono text-xs font-semibold text-orchid-brand dark:text-orchid-brand">{i.itemCode}</td>
                  <td className="td max-w-xl truncate text-fg-muted" title={i.description}>{i.description}</td>
                  <td className="td">
                    {/* Blank means the UPL did not classify this code, and the
                        GCL's Tangible/Service cell will be empty for it. */}
                    {i.itemType
                      ? <Badge tone={i.itemType === 'Service' ? 'cyan' : 'neutral'}>{i.itemType}</Badge>
                      : <span className="text-xs text-fg-subtle">—</span>}
                  </td>
                  <td className="td text-xs">{i.uom ?? '—'}</td>
                  <td className="td text-right font-semibold">{money(i.price, i.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
