import { ChevronDown, Download, FileSignature, FileText, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Empty, Spinner } from '../components/ui/Feedback';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Checkbox, Input, Select } from '../components/ui/Field';
import FormatDialog, { type DocFormat } from '../components/ui/FormatDialog';
import { api, shortDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MopCategory, MopDocument, Paged, Project, ProjectsResult } from '../lib/types';

/** Every MOP produced, grouped by project — the library view. */
export default function MopListPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [docs, setDocs] = useState<MopDocument[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [categories, setCategories] = useState<MopCategory[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  /** The project group whose download format is being chosen, if any. */
  const [zipFor, setZipFor] = useState<{
    key: string;
    label: string;
    count: number;
    /** Empty means the whole group; otherwise the hand-picked document IDs. */
    ids: string[];
  } | null>(null);
  const [zipping, setZipping] = useState(false);

  /** Hand-picked rows, by document ID, across every group. */
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleMany = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });

  const projectId = params.get('project') ?? '';
  const mopCategoryId = params.get('category') ?? '';

  const load = useCallback(() => {
    const q = new URLSearchParams({ limit: '200' });
    if (projectId) q.set('externalSiteId', projectId);
    if (mopCategoryId) q.set('mopCategoryId', mopCategoryId);
    if (search) q.set('search', search);

    api
      .get<Paged<MopDocument>>(`/mop?${q}`)
      .then((r) => setDocs(r.items))
      .catch((e) => setError(e.message));
  }, [projectId, mopCategoryId, search]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    api
      .get<ProjectsResult>('/projects')
      .then((r) => setProjects(r.items))
      .catch(() => setProjects([]));
    api.get<MopCategory[]>('/categories/mops').then(setCategories).catch(() => setCategories([]));
  }, []);

  // A row that filtering took off the page should not stay silently selected.
  useEffect(() => {
    if (!docs) return;
    const visible = new Set(docs.map((d) => d.id));
    setPicked((prev) => {
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [docs]);

  const grouped = useMemo(() => {
    const map = new Map<string, { title: string; siteId: string; colour: string; items: MopDocument[] }>();
    for (const d of docs ?? []) {
      const key = d.externalSiteId || 'unknown';
      if (!map.has(key)) {
        map.set(key, {
          siteId: key,
          title: d.externalProjectTitle || d.externalCategory || '',
          colour: d.projectCategory?.colour ?? '#44489D',
          items: [],
        });
      }
      map.get(key)!.items.push(d);
    }
    return [...map.entries()].sort((a, b) => b[1].items.length - a[1].items.length);
  }, [docs]);

  /** Every MOP in one project group, as a ZIP in the chosen format. */
  const downloadGroup = async (format: DocFormat) => {
    if (!zipFor) return;
    setZipping(true);
    setError(null);
    setNotice(null);
    try {
      // Carry the page's filters so the archive holds exactly the rows shown.
      const q = new URLSearchParams({ format });
      if (zipFor.key !== 'unknown') q.set('siteId', zipFor.key);
      if (mopCategoryId) q.set('mopCategoryId', mopCategoryId);
      if (search) q.set('search', search);
      // Only for a partial pick: whole-group downloads keep the URL short.
      if (zipFor.ids.length) q.set('ids', zipFor.ids.join(','));

      const r = await api.download(`/mop/download/project?${q}`, `${zipFor.key}_MOPs.zip`);
      setZipFor(null);
      setNotice(
        r.skipped
          ? `Downloaded ${r.included} of ${zipFor.count} documents as ${format.toUpperCase()} — ` +
            `${r.skipped} had no ${format === 'docx' ? 'Word file' : 'PDF'} yet (listed in MISSING.txt).`
          : `Downloaded ${r.included ?? zipFor.count} documents as ${format.toUpperCase()}.`,
      );
    } catch (e) {
      setError((e as Error).message);
      setZipFor(null);
    } finally {
      setZipping(false);
    }
  };

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight gradient-text animate-gradient-pan">
            MOP documents
          </h1>
          <p className="mt-1 text-sm text-fg-muted">
            Method of Procedure documents, grouped by project.
          </p>
        </div>

        {can('mop', 'create') && (
          <Link to="/mop/new">
            <Button variant="gradient">
              <Plus size={15} /> New MOP
            </Button>
          </Link>
        )}
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      {/* filters */}
      <Card>
        <div className="flex flex-wrap items-end gap-3 px-5 py-4">
          <div className="relative min-w-[220px] flex-1">
            <label className="label">Search</label>
            <Search size={15} className="absolute left-3 top-[34px] text-fg-subtle" />
            <Input
              className="pl-9"
              placeholder="Site ID, summary or PM"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="min-w-[180px]">
            <label className="label">Project</label>
            <Select value={projectId} onChange={(e) => setParam('project', e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.siteId} value={p.siteId}>
                  {p.siteId} — {p.title}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-[180px]">
            <label className="label">MOP category</label>
            <Select value={mopCategoryId} onChange={(e) => setParam('category', e.target.value)}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      {!docs && <Spinner label="Loading documents…" />}

      {docs && docs.length === 0 && (
        <Empty icon={<FileSignature size={22} />}>
          No MOP documents match. <Link to="/mop/new" className="font-medium text-cyan-brand">Create one</Link>.
        </Empty>
      )}

      {grouped.map(([key, group]) => {
        const isCollapsed = collapsed[key];
        const ids = group.items.map((d) => d.id);
        const chosen = ids.filter((id) => picked.has(id));
        const allChosen = chosen.length === ids.length;
        // A full selection is the same request as "download all", so send no
        // ID list for it — that keeps the URL short on a large project.
        const zipIds = chosen.length && !allChosen ? chosen : [];
        return (
          <Card key={key}>
            {/* A row, not a single button: the select-all box and download
                control sit beside the collapse toggle, and neither a checkbox
                nor a button can nest inside a button. */}
            <div className="flex items-center gap-3 px-5 py-4">
              <Checkbox
                checked={allChosen && ids.length > 0}
                indeterminate={chosen.length > 0 && !allChosen}
                onChange={(on) => toggleMany(ids, on)}
                title={allChosen ? 'Clear selection' : 'Select every site in this project'}
              />
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-expanded={!isCollapsed}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: group.colour }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-sm font-semibold text-fg">
                    {key === 'unknown' ? 'No project' : group.siteId}
                  </span>
                  <span className="block truncate text-[11px] text-fg-subtle">{group.title}</span>
                </span>
                <Badge tone="neutral">{group.items.length}</Badge>
                <ChevronDown
                  size={16}
                  className={`shrink-0 text-fg-subtle transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                />
              </button>

              <Button
                variant={chosen.length ? 'gradient' : 'outline'}
                size="sm"
                className="shrink-0"
                title={
                  chosen.length && !allChosen
                    ? `Download the ${chosen.length} selected as a ZIP`
                    : `Download all ${group.items.length} documents as a ZIP`
                }
                onClick={() =>
                  setZipFor({
                    key,
                    label: key === 'unknown' ? 'No project' : group.siteId,
                    count: chosen.length || group.items.length,
                    ids: zipIds,
                  })
                }
              >
                <Download size={13} />
                {chosen.length && !allChosen ? `Download ${chosen.length}` : 'Download all'}
              </Button>
            </div>

            {!isCollapsed && (
              <div className="overflow-x-auto border-t border-line/60">
                <table className="w-full min-w-[760px]">
                  <thead>
                    <tr>
                      {/* Select-all lives in the group header, where it works
                          whether this group is open or collapsed. */}
                      <th className="th w-10" aria-label="Select" />
                      <th className="th">Site ID</th>
                      <th className="th">Category</th>
                      <th className="th">TCN Summary</th>
                      <th className="th">PM</th>
                      <th className="th">Requester</th>
                      <th className="th w-24">Impact</th>
                      <th className="th">Created</th>
                      <th className="th text-right">Files</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((d) => (
                      <tr
                        key={d.id}
                        className={`row-hover ${picked.has(d.id) ? 'bg-cyan-brand/[.06]' : ''}`}
                      >
                        <td className="td">
                          <Checkbox
                            checked={picked.has(d.id)}
                            onChange={() => toggle(d.id)}
                            title={`Select ${d.siteId}`}
                          />
                        </td>
                        <td className="td font-mono text-xs font-semibold text-fg">{d.siteId}</td>
                        <td className="td text-xs">{d.mopCategory?.name}</td>
                        <td className="td max-w-xs truncate text-fg-muted" title={d.tcnSummary}>
                          {d.tcnSummary}
                        </td>
                        <td className="td text-xs">{d.pmName}</td>
                        <td className="td text-xs">{d.requesterName}</td>
                        <td className="td">
                          <Badge tone={d.siteImpact === 'YES' ? 'warn' : 'neutral'}>{d.siteImpact}</Badge>
                        </td>
                        <td className="td text-xs text-fg-subtle">{shortDate(d.createdAt)}</td>
                        <td className="td">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                api.download(`/mop/${d.id}/download/docx`, d.docxFileName ?? 'mop.docx')
                              }
                            >
                              <Download size={13} /> DOCX
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!d.pdfFileName}
                              onClick={() => api.openInline(`/mop/${d.id}/download/pdf?inline=true`)}
                            >
                              <FileText size={13} /> PDF
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}

      <FormatDialog
        open={Boolean(zipFor)}
        busy={zipping}
        title="Download all documents"
        description={
          zipFor
            ? `${zipFor.ids.length ? `${zipFor.count} selected` : zipFor.count} MOP ` +
              `${zipFor.count === 1 ? 'document' : 'documents'} for ${zipFor.label}. ` +
              'Choose a format — they arrive as a single ZIP.'
            : undefined
        }
        onConfirm={downloadGroup}
        onCancel={() => setZipFor(null)}
      />
    </div>
  );
}
