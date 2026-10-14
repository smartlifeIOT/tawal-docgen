import { ArrowLeft, ArrowRight, FileSpreadsheet, PenLine, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import QuantityFieldPicker from '../components/QuantityFieldPicker';
import SignatureInput from '../components/SignatureInput';
import { Alert, Empty, Spinner } from '../components/ui/Feedback';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHead } from '../components/ui/Card';
import { Checkbox, Field, Input, Textarea } from '../components/ui/Field';
import { api, money } from '../lib/api';
import type { Package, QuantitySource, ScopePreview, ScopeSite } from '../lib/types';

const siteKey = (s: ScopeSite) => s.siteCode ?? s.tawalSiteId ?? s.siteName ?? '';

/**
 * The scope workbook is already attached to the project's WO request in the
 * tracker, so there is nothing to upload — the file is fetched, parsed and
 * previewed as soon as the page opens.
 */
export default function CreateGclPage() {
  const [params] = useSearchParams();
  const externalSiteId = params.get('project');
  const nav = useNavigate();

  /** The preview carries the project's own region and city alongside the scope. */
  type ProjectPreview = ScopePreview & {
    sourceFileName?: string;
    region?: string | null;
    district?: string | null;
    projectTitle?: string | null;
  };

  const [preview, setPreview] = useState<ProjectPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [signature, setSignature] = useState<File | null>(null);
  const [busy, setBusy] = useState<'load' | 'create' | null>('load');
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    quantityFieldKey: '',
    quantitySource: 'AS_BUILT' as QuantitySource,
    region: '',
    district: '',
    contractorPmName: '',
    mspRepName: '',
    notes: '',
  });
  // The Work Order number is unique, which is what stops the same job being
  // billed twice. Replacing is therefore deliberate, never automatic.
  const [replaceExisting, setReplaceExisting] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!externalSiteId) return;
    setBusy('load');
    api
      .get<ProjectPreview>(`/gcl/from-project/${encodeURIComponent(externalSiteId)}/preview`)
      .then((r) => {
        setPreview(r);
        setSelected(r.sites.map(siteKey));
        // Region and district come from the tracker project, so they arrive
        // filled in rather than being retyped for every GCL. Still editable —
        // and still overridable, since what is typed here wins server-side.
        setForm((f) => ({
          ...f,
          quantityFieldKey: r.suggestedFieldKey || f.quantityFieldKey,
          region: r.region ?? f.region,
          district: r.district ?? f.district,
        }));
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(null));
  }, [externalSiteId]);

  const chosen = useMemo(
    () => (preview?.sites ?? []).filter((s) => selected.includes(siteKey(s))),
    [preview, selected],
  );

  const total = form.quantityFieldKey
    ? chosen.reduce((a, s) => a + (s.columnTotals?.[form.quantityFieldKey] ?? 0), 0)
    : chosen.reduce((a, s) => a + s.total, 0);
  const unpriced = [...new Set(chosen.flatMap((s) => s.unpricedItems))];

  async function create() {
    setBusy('create');
    setError(null);
    try {
      const fd = new FormData();
      if (signature) fd.append('signature', signature);
      fd.append('siteCodes', JSON.stringify(selected));
      Object.entries(form).forEach(([k, v]) => {
        if (v !== '' && v != null) fd.append(k, String(v));
      });
      if (replaceExisting) fd.append('overwrite', 'true');

      const { packages } = await api.uploadForm<{ packages: Package[] }>(
        `/gcl/from-project/${encodeURIComponent(externalSiteId!)}`,
        fd,
      );
      // Navigate last: this component unmounts, so nothing touches state after.
      nav(`/packages/${packages[0].id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  if (!externalSiteId) return <Navigate to="/gcl" replace />;

  return (
    <div className="space-y-6">
      <Link to="/gcl" className="inline-flex items-center gap-1 text-xs text-fg-subtle hover:text-fg">
        <ArrowLeft size={13} /> All GCLs
      </Link>

      {error && <Alert kind="error" title="Something went wrong">{error}</Alert>}

      {busy === 'load' && <Spinner label="Fetching the scope sheet from the tracker…" />}

      {preview && (
        <>
          <Card>
            <CardHead
              title="Scope sheet"
              hint="Taken straight from the project's WO request — no upload needed"
              icon={<FileSpreadsheet size={15} />}
              actions={<Badge tone="cyan">{preview.sourceFileName ?? 'attachment'}</Badge>}
            />

            {preview.warnings?.length ? (
              <div className="px-4 pt-4 sm:px-5">
                <Alert kind="warn" title="Warnings while reading the sheet">
                  <ul className="list-inside list-disc">
                    {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </Alert>
              </div>
            ) : null}

            {preview.sites.length === 0 ? (
              <Empty icon={<FileSpreadsheet size={22} />}>
                No sites were found in the attached workbook.
              </Empty>
            ) : (
              <div className="-mx-px overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr>
                      <th className="th w-12"></th>
                      <th className="th">Site</th>
                      <th className="th">Name</th>
                      <th className="th text-right">Items</th>
                      <th className="th text-right">Value</th>
                      <th className="th">Unpriced</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sites.map((s) => {
                      const key = siteKey(s);
                      const on = selected.includes(key);
                      return (
                        <tr key={key} className="row-hover">
                          <td className="td">
                            <Checkbox
                              checked={on}
                              onChange={(v) =>
                                setSelected((cur) =>
                                  v ? [...cur, key] : cur.filter((k) => k !== key),
                                )
                              }
                              label={<span className="sr-only">Include {key}</span>}
                            />
                          </td>
                          <td className="td font-mono text-xs font-semibold text-fg">{key}</td>
                          <td className="td text-fg-muted">{s.siteName ?? '—'}</td>
                          <td className="td text-right tabular-nums">{s.lines.length}</td>
                          <td className="td text-right font-semibold">
                            {money(
                              form.quantityFieldKey
                                ? (s.columnTotals?.[form.quantityFieldKey] ?? 0)
                                : s.total,
                            )}
                          </td>
                          <td className="td">
                            {s.unpricedItems.length ? (
                              <Badge tone="warn">{s.unpricedItems.length}</Badge>
                            ) : (
                              <span className="text-xs text-fg-subtle">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {preview.quantityColumns.length > 0 && (
            <Card>
              <div className="px-4 py-5 sm:px-5">
                <QuantityFieldPicker
                  columns={preview.quantityColumns.map((c) => ({
                    ...c,
                    total: chosen.reduce((a, s) => a + (s.columnTotals?.[c.key] ?? 0), 0),
                  }))}
                  value={form.quantityFieldKey}
                  onChange={(k) => set('quantityFieldKey', k)}
                  hint="Numeric columns found in the workbook. The one you pick becomes the quantity on the GCL."
                />
              </div>
            </Card>
          )}

          <Card>
            <CardHead
              title="Details"
              hint="Fields the scope sheet doesn't carry — all editable afterwards"
              icon={<PenLine size={15} />}
            />
            <div className="grid gap-4 px-4 py-5 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
              <Field
                label="Region"
                hint={preview?.region ? 'From the tracker project' : undefined}
              >
                <Input value={form.region} onChange={(e) => set('region', e.target.value)} />
              </Field>
              <Field
                label="District"
                hint={preview?.district ? 'From the tracker project' : undefined}
              >
                <Input value={form.district} onChange={(e) => set('district', e.target.value)} />
              </Field>
              <Field label="Contractor PM"><Input value={form.contractorPmName} onChange={(e) => set('contractorPmName', e.target.value)} /></Field>
              <Field label="MSP representative"><Input value={form.mspRepName} onChange={(e) => set('mspRepName', e.target.value)} /></Field>
              <Field label="Remarks" className="sm:col-span-2 lg:col-span-4">
                <Textarea
                  className="h-20"
                  value={form.notes}
                  onChange={(e) => set('notes', e.target.value)}
                />
              </Field>
            </div>

            <div className="border-t border-line/60 px-4 py-5 sm:px-5">
              <p className="label">Contractor signature</p>
              <SignatureInput onChange={setSignature} />
            </div>

            <div className="border-t border-line/60 px-4 py-4 sm:px-5">
              <Checkbox
                checked={replaceExisting}
                onChange={setReplaceExisting}
                label={
                  <span>
                    <span className="text-sm">Replace the existing package</span>
                    <span className="block text-[11px] text-fg-subtle">
                      Tick this if a package for the same Work Order already exists.
                    </span>
                  </span>
                }
              />
            </div>
          </Card>

          {unpriced.length > 0 && (
            <Alert kind="warn" title={`${unpriced.length} item(s) have no price in the UPL`}>
              {unpriced.join(', ')} — these will price at zero until they are added.
            </Alert>
          )}

          <div className="sticky bottom-0 -mx-4 border-t border-line/60 bg-canvas/85 px-4 py-3 backdrop-blur-md sm:-mx-5 sm:px-5 lg:-mx-8 lg:px-8">
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 text-xs text-fg-subtle">
                {chosen.length} site{chosen.length === 1 ? '' : 's'} · {money(total)}
              </span>
              <Button
                variant="gradient"
                onClick={create}
                disabled={chosen.length === 0}
                loading={busy === 'create'}
              >
                <Sparkles size={15} /> Create GCL <ArrowRight size={15} />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
