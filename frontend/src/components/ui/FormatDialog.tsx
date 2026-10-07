import { AnimatePresence, motion } from 'framer-motion';
import { FileText, FileType } from 'lucide-react';
import { useState } from 'react';
import { Button } from './Button';

export type DocFormat = 'pdf' | 'docx';

interface Props {
  open: boolean;
  title: string;
  description?: string;
  /** Pre-selected when the dialog opens. */
  initial?: DocFormat;
  busy?: boolean;
  onConfirm: (format: DocFormat) => void;
  onCancel: () => void;
}

const OPTIONS: { value: DocFormat; label: string; hint: string; icon: typeof FileText }[] = [
  { value: 'pdf', label: 'PDF', hint: 'Final, for sharing and signing', icon: FileText },
  { value: 'docx', label: 'Word', hint: 'Editable .docx', icon: FileType },
];

/**
 * Asks which format a bulk download should come in.
 *
 * Animates on mount and unmount only, like ConfirmDialog — no keyed swap that
 * could leave the panel stuck invisible (see .page-enter in index.css).
 */
export default function FormatDialog({
  open,
  title,
  description,
  initial = 'pdf',
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [format, setFormat] = useState<DocFormat>(initial);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={busy ? undefined : onCancel}
          />

          <motion.div
            className="surface relative w-full max-w-md p-5 shadow-xl"
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <h2 className="text-base font-semibold text-fg">{title}</h2>
            {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {OPTIONS.map((o) => {
                const active = format === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setFormat(o.value)}
                    aria-pressed={active}
                    className={
                      'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ' +
                      (active
                        ? 'border-cyan-brand bg-cyan-brand/10'
                        : 'border-line bg-card/70 hover:border-fg-subtle/50')
                    }
                  >
                    <o.icon
                      size={17}
                      className={`mt-0.5 shrink-0 ${active ? 'text-cyan-brand' : 'text-fg-subtle'}`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-fg">{o.label}</span>
                      <span className="block text-[11px] leading-snug text-fg-subtle">{o.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button variant="gradient" loading={busy} onClick={() => onConfirm(format)}>
                Download
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
