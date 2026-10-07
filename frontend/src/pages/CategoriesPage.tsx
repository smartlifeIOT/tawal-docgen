import { FolderTree, Layers3, Link2, Plus, Trash2, Unlink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Empty, Spinner } from '../components/ui/Feedback';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHead } from '../components/ui/Card';
import { Checkbox, Field, Input, Select } from '../components/ui/Field';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MopCategory, ProjectCategory, TemplateInfo } from '../lib/types';

/**
 * One screen for both catalogs, because they only make sense together: a MOP
 * category is meaningless until it is paired with a project category and a
 * Word template.
 */
export default function CategoriesPage({ tab = 'projects' }: { tab?: 'projects' | 'mops' }) {
  const { can } = useAuth();
  const resource = tab === 'projects' ? 'projectCategories' : 'mopCategories';
  // One flag per action: a user with edit but not delete should see the edit
  // controls and no bin icon. A single "canEdit" showed both.
  const canCreate = can(resource, 'create');
  const canEdit = can(resource, 'edit');
  const canDelete = can(resource, 'delete');
  const [projectCats, setProjectCats] = useState<ProjectCategory[] | null>(null);
  const [mopCats, setMopCats] = useState<MopCategory[]>([]);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [newProject, setNewProject] = useState({ name: '', description: '', colour: '#01C2F3' });
  const [newMop, setNewMop] = useState({ name: '' });
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [link, setLink] = useState({ mopCategoryId: '', templateKey: '', defaultTcnSummary: '' });

  const load = useCallback(() => {
    api
      .get<ProjectCategory[]>('/categories/projects?includeInactive=true')
      .then(setProjectCats)
      .catch((e) => setError(e.message));
    api.get<MopCategory[]>('/categories/mops?includeInactive=true').then(setMopCats).catch(() => setMopCats([]));
  }, []);

  useEffect(() => {
    load();
    api.get<TemplateInfo[]>('/categories/templates').then(setTemplates).catch(() => setTemplates([]));
  }, [load]);

  async function act(fn: () => Promise<unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!projectCats) return <Spinner label="Loading categories…" />;

  const isProjects = tab === 'projects';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight gradient-text animate-gradient-pan">
          {isProjects ? 'Project categories' : 'MOP categories'}
        </h1>
        <p className="mt-1 text-sm text-fg-muted">
          {isProjects
            ? 'Mirrored from the tracker. Pair each with the MOP categories its projects should produce.'
            : 'The stages of work — Survey, Installation, PAT. Pair them with a project category to say which MOP format they produce.'}
        </p>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {!canCreate && !canEdit && !canDelete && (
        <Alert kind="info">You can view categories but not change them.</Alert>
      )}

      {isProjects ? (
        <>
          <Alert kind="info">
            Categories the tracker uses appear here automatically. You can add your own for work
            the tracker doesn't cover — a MOP can then be raised against it without a project.
            Pair each with the MOP categories it should produce.
          </Alert>

          {canCreate && (
            <Card>
              <CardHead title="Add a project category" icon={<Plus size={15} />} />
              <div className="flex flex-wrap items-end gap-3 px-4 py-5 sm:px-5">
                <Field label="Name" className="min-w-[220px] flex-1">
                  <Input
                    placeholder="Maintenance"
                    value={newProject.name}
                    onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                  />
                </Field>
                <Button
                  variant="gradient"
                  disabled={!newProject.name.trim()}
                  loading={busy === 'new-project'}
                  onClick={() =>
                    act(async () => {
                      await api.send('/categories/projects', 'POST', {
                        ...newProject,
                        name: newProject.name.trim(),
                      });
                      setNewProject({ name: '', description: '', colour: '#01C2F3' });
                    }, 'new-project')
                  }
                >
                  Add category
                </Button>
              </div>
              <p className="border-t border-line/60 px-5 py-3 text-[11px] text-fg-subtle">
                A custom category produces nothing until it is paired with a MOP category below.
              </p>
            </Card>
          )}

          {projectCats.length === 0 && <Empty icon={<FolderTree size={22} />}>No project categories yet.</Empty>}

          {projectCats.map((c) => (
            <Card key={c.id}>
              <CardHead
                title={
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.colour ?? '#44489D' }} />
                    {c.name}
                    {!c.isActive && <Badge tone="neutral">hidden</Badge>}
                  </span>
                }
                hint={c.description ?? `${c._count?.documents ?? 0} MOP document(s)`}
                actions={
                  (canEdit || canDelete) && (
                    <div className="flex items-center gap-3">
                      {canEdit && (
                        <Checkbox
                          checked={c.isActive}
                          onChange={(v) =>
                            act(() => api.send(`/categories/projects/${c.id}`, 'PATCH', { isActive: v }), c.id)
                          }
                          label={<span className="text-xs">Visible</span>}
                        />
                      )}
                      {canEdit && (
                        <Button variant="outline" size="sm" onClick={() => setLinkFor(linkFor === c.id ? null : c.id)}>
                          <Link2 size={13} /> Pair MOP
                        </Button>
                      )}
                      {/* Only a custom category can be deleted — a mirrored one
                          would simply reappear on the next sync. */}
                      {canDelete && !c.lastSeenAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-rose-500"
                          onClick={() =>
                            act(() => api.send(`/categories/projects/${c.id}`, 'DELETE'), c.id)
                          }
                        >
                          <Trash2 size={13} />
                        </Button>
                      )}
                    </div>
                  )
                }
              />

              {linkFor === c.id && canEdit && (
                <div className="grid gap-4 border-b border-line/60 bg-card/40 px-5 py-4 md:grid-cols-4">
                  <Field label="MOP category">
                    <Select
                      value={link.mopCategoryId}
                      onChange={(e) => setLink({ ...link, mopCategoryId: e.target.value })}
                    >
                      <option value="">Select…</option>
                      {mopCats
                        .filter((m) => !c.templates?.some((t) => t.mopCategoryId === m.id))
                        .map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                    </Select>
                  </Field>
                  <Field label="MOP format">
                    <Select
                      value={link.templateKey}
                      onChange={(e) => setLink({ ...link, templateKey: e.target.value })}
                    >
                      <option value="">Select…</option>
                      {templates.map((t) => (
                        <option key={t.key} value={t.key}>{t.label}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Default TCN Summary">
                    <Input
                      value={link.defaultTcnSummary}
                      onChange={(e) => setLink({ ...link, defaultTcnSummary: e.target.value })}
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button
                      variant="gradient"
                      className="w-full"
                      disabled={!link.mopCategoryId || !link.templateKey}
                      onClick={() =>
                        act(async () => {
                          await api.send('/categories/links', 'POST', {
                            ...link,
                            projectCategoryId: c.id,
                          });
                          setLink({ mopCategoryId: '', templateKey: '', defaultTcnSummary: '' });
                          setLinkFor(null);
                        }, c.id)
                      }
                    >
                      Pair
                    </Button>
                  </div>
                </div>
              )}

              <div className="divide-y divide-line/50">
                {(c.templates ?? []).length === 0 && (
                  <p className="px-5 py-6 text-sm text-fg-subtle">
                    No MOP categories paired — projects in this category can't produce MOPs yet.
                  </p>
                )}
                {(c.templates ?? []).map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-fg">{t.mopCategory?.name}</div>
                      <div className="text-[11px] text-fg-subtle">
                        {t.defaultTcnSummary ?? '—'} · MOP format {t.templateKey}
                      </div>
                    </div>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-rose-500"
                        onClick={() =>
                          act(
                            () => api.send(`/categories/links/${c.id}/${t.mopCategoryId}`, 'DELETE'),
                            t.id,
                          )
                        }
                      >
                        <Unlink size={13} /> Unpair
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </>
      ) : (
        <>
          {canCreate && (
            <Card>
              <CardHead title="Add a MOP category" icon={<Plus size={15} />} />
              <div className="flex flex-wrap items-end gap-4 px-5 py-5">
                <Field label="Name" className="min-w-[240px] flex-1">
                  <Input
                    placeholder="Commissioning"
                    value={newMop.name}
                    onChange={(e) => setNewMop({ name: e.target.value })}
                  />
                </Field>
                <Button
                  variant="gradient"
                  disabled={!newMop.name}
                  loading={busy === 'new-mop'}
                  onClick={() =>
                    act(async () => {
                      await api.send('/categories/mops', 'POST', newMop);
                      setNewMop({ name: '' });
                    }, 'new-mop')
                  }
                >
                  Add category
                </Button>
              </div>
              <p className="border-t border-line/60 px-5 py-3 text-[11px] text-fg-subtle">
                A new category does nothing until it is paired with a project category — do that
                from the Project categories screen.
              </p>
            </Card>
          )}

          {mopCats.length === 0 && <Empty icon={<Layers3 size={22} />}>No MOP categories yet.</Empty>}

          {mopCats.map((m) => (
            <Card key={m.id}>
              <CardHead
                title={
                  <span className="flex items-center gap-2">
                    {m.name}
                    {!m.isActive && <Badge tone="neutral">hidden</Badge>}
                  </span>
                }
                hint={`${m._count?.documents ?? 0} document(s) generated`}
                actions={
                  (canEdit || canDelete) && (
                    <div className="flex items-center gap-3">
                      {canEdit && (
                      <Checkbox
                        checked={m.isActive}
                        onChange={(v) =>
                          act(() => api.send(`/categories/mops/${m.id}`, 'PATCH', { isActive: v }), m.id)
                        }
                        label={<span className="text-xs">Visible</span>}
                      />
                      )}
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-rose-500"
                          onClick={() => act(() => api.send(`/categories/mops/${m.id}`, 'DELETE'), m.id)}
                        >
                          <Trash2 size={13} />
                        </Button>
                      )}
                    </div>
                  )
                }
              />
              <div className="flex flex-wrap gap-2 px-5 py-4">
                {(m.templates ?? []).length === 0 ? (
                  <span className="text-sm text-fg-subtle">Not paired with any project category.</span>
                ) : (
                  (m.templates ?? []).map((t) => (
                    <Badge key={t.id} tone="cyan">
                      {t.projectCategory?.name} → {t.templateKey}
                    </Badge>
                  ))
                )}
              </div>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
