/**
 * "New from template": a gallery of ready-made pipelines, then a short setup
 * step that asks for the files the pipeline needs.
 *
 * Gallery: search and domain filter, "Ready-made templates" and "My templates"
 * (the person's own, which can be renamed or deleted). Each card shows the
 * name, one sentence, step count, level, tools and a small drawing of the
 * pipeline, and says up front when a tool needs a database.
 *
 * Setup: what the pipeline does, what it needs, what it makes, one field per
 * input with a file picker. Every input can be left empty and filled in later;
 * the steps then show what is missing. All logic is in `templates/`.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Dialog,
  Icon,
  IconButton,
  NumberField,
  Select,
  TextField,
  type ConfirmRequest,
  type Notify,
} from '../ui';
import { TemplateDag } from './TemplateDag';
import { bundledTemplates } from '../templates/registry';
import {
  DIFFICULTIES,
  adaptToCatalog,
  databaseNeeds,
  newerThanApp,
  parseTemplate,
  settingParam,
  type TemplateInput,
  type TemplateSetting,
  type WorkflowTemplate,
} from '../templates/schema';
import {
  domainLabel,
  domainsOf,
  detailParagraphs,
  filterEntries,
  readLayoutLabel,
  stepCountLabel,
  toolsLine,
  type BrokenTemplate,
  type GalleryEntry,
} from '../templates/gallery';
import {
  filesOf,
  initialSettingTexts,
  inputProblems,
  missingInputs,
  pickerExtensions,
  settingProblems,
  typeWarning,
  valuesFromText,
  type SettingTexts,
} from '../templates/instantiate';

type Stage = { kind: 'gallery' } | { kind: 'setup'; entry: GalleryEntry };

interface UserTemplates {
  entries: GalleryEntry[];
  broken: BrokenTemplate[];
  loaded: boolean;
}

/** The user's template files, checked against the tool catalog. */
export async function loadUserTemplates(): Promise<UserTemplates> {
  const stored = await window.electron.ipcRenderer.listUserTemplates();
  const entries: GalleryEntry[] = [];
  const broken: BrokenTemplate[] = [];
  for (const file of stored) {
    if (file.error !== undefined || file.raw === undefined) {
      broken.push({ id: file.id, problems: [file.error ?? 'The file cannot be read.'] });
      continue;
    }
    // A file from a newer app version: say so, rather than list what this version does not understand.
    const newer = newerThanApp(file.raw);
    if (newer) {
      broken.push({ id: file.id, problems: [newer] });
      continue;
    }
    // A file from an older version: options the tools no longer have are left out, and the setup step says so.
    const adapted = adaptToCatalog(file.raw);
    const parsed = parseTemplate(adapted.raw);
    if (parsed.ok === false) broken.push({ id: file.id, problems: parsed.errors });
    else if (parsed.template.id !== file.id) {
      broken.push({ id: file.id, problems: ['The id inside the file does not match its file name.'] });
    } else {
      entries.push({
        template: parsed.template,
        source: 'user',
        ...(adapted.notes.length > 0 ? { notes: adapted.notes } : {}),
      });
    }
  }
  return { entries, broken, loaded: true };
}

// -----------------------------------------------------------------------------
// Gallery
// -----------------------------------------------------------------------------

function TemplateCard({
  entry,
  onPick,
  actions,
}: {
  entry: GalleryEntry;
  onPick: () => void;
  actions?: ReactNode;
}) {
  const { template } = entry;
  const database = databaseNeeds(template).length > 0;
  const layout = readLayoutLabel(template);
  return (
    <li className="template-card-wrap">
      <button
        type="button"
        className="template-card"
        data-testid={`template-card-${template.id}`}
        onClick={onPick}
      >
        <TemplateDag template={template} />
        <span className="template-card-name">{template.name}</span>
        <span className="template-card-description">{template.description}</span>
        <span className="template-card-meta">
          <Badge tone="neutral" variant="outline">
            {stepCountLabel(template)}
          </Badge>
          <Badge tone="neutral" variant="outline">
            {DIFFICULTIES[template.difficulty]}
          </Badge>
          <Badge tone="neutral" variant="outline">
            {domainLabel(template.domain)}
          </Badge>
          {layout && (
            <Badge tone="neutral" variant="outline" data-testid="template-read-layout">
              {layout}
            </Badge>
          )}
          {database && (
            <Badge tone="warning" variant="subtle" icon="alert" data-testid="template-needs-database">
              Needs a database
            </Badge>
          )}
        </span>
        <span className="template-card-tools">Uses {toolsLine(template)}</span>
      </button>
      {actions}
    </li>
  );
}

function Gallery({
  bundled,
  user,
  onPick,
  onReload,
  onConfirm,
  notify,
}: {
  bundled: GalleryEntry[];
  user: UserTemplates;
  onPick: (entry: GalleryEntry) => void;
  onReload: () => Promise<void>;
  onConfirm: (request: ConfirmRequest) => Promise<boolean>;
  notify: Notify;
}) {
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const all = useMemo(() => [...bundled, ...user.entries], [bundled, user.entries]);
  const shownBundled = filterEntries(bundled, query, domain);
  const shownUser = filterEntries(user.entries, query, domain);
  const searching = query.trim() !== '' || domain !== '';

  const doRename = async () => {
    if (!renaming) return;
    const result = await window.electron.ipcRenderer.renameUserTemplate(renaming.id, renaming.name);
    if (result.ok === true) {
      setRenaming(null);
      await onReload();
      notify('success', 'Template renamed.');
    } else notify('danger', result.error);
  };

  const doDelete = async (id: string, name: string) => {
    const ok = await onConfirm({
      title: 'Delete this template?',
      message: `"${name}" is removed from this computer. Workflows already made from it are not affected.`,
      confirmLabel: 'Delete template',
    });
    if (!ok) return;
    const result = await window.electron.ipcRenderer.deleteUserTemplate(id);
    if (result.ok === true) {
      await onReload();
      notify('success', 'Template deleted.');
    } else notify('danger', result.error);
  };

  const bundledSection = (
    <section aria-labelledby="templates-bundled-title" className="template-section">
      <h4 className="template-section-title" id="templates-bundled-title">
        Ready-made templates
      </h4>
      {shownBundled.length > 0 ? (
        <ul className="template-grid" data-testid="template-grid-bundled">
          {shownBundled.map((entry) => (
            <TemplateCard key={entry.template.id} entry={entry} onPick={() => onPick(entry)} />
          ))}
        </ul>
      ) : (
        <p className="template-empty" data-testid="template-empty">
          {searching ? 'No ready-made template matches. Try fewer words or another topic.' : 'No templates yet.'}
        </p>
      )}
    </section>
  );

  const userSection = (
    <section aria-labelledby="templates-user-title" className="template-section" data-testid="my-templates">
      <h4 className="template-section-title" id="templates-user-title">
        My templates
      </h4>
      {shownUser.length > 0 && (
        <ul className="template-grid" data-testid="template-grid-user">
          {shownUser.map((entry) => {
            const { template } = entry;
            const editing = renaming?.id === template.id;
            return (
              <TemplateCard
                key={template.id}
                entry={entry}
                onPick={() => onPick(entry)}
                actions={
                  editing ? (
                    <div className="template-card-edit">
                      <TextField
                        label="Template name"
                        value={renaming.name}
                        data-testid="template-rename-input"
                        autoFocus
                        onChange={(e) => setRenaming({ id: template.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void doRename();
                          if (e.key === 'Escape') {
                            e.stopPropagation();
                            setRenaming(null);
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        variant="primary"
                        data-testid="template-rename-save"
                        disabledReason={renaming.name.trim() ? undefined : 'Give the template a name'}
                        onClick={() => void doRename()}
                      >
                        Save name
                      </Button>
                      <Button size="sm" onClick={() => setRenaming(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="template-card-actions">
                      <IconButton
                        icon="pencil"
                        size="sm"
                        label={`Rename ${template.name}`}
                        data-testid={`template-rename-${template.id}`}
                        onClick={() => setRenaming({ id: template.id, name: template.name })}
                      />
                      <IconButton
                        icon="trash"
                        size="sm"
                        label={`Delete ${template.name}`}
                        data-testid={`template-delete-${template.id}`}
                        onClick={() => void doDelete(template.id, template.name)}
                      />
                    </div>
                  )
                }
              />
            );
          })}
        </ul>
      )}
      {user.entries.length === 0 && user.loaded && (
        <p className="template-empty" data-testid="my-templates-empty">
          Templates you save from a workflow appear here. Build a workflow, then choose Save as template.
        </p>
      )}
      {user.entries.length > 0 && shownUser.length === 0 && (
        <p className="template-empty">None of your templates match the search.</p>
      )}
      {user.broken.length > 0 && (
        <ul className="template-broken" data-testid="template-broken">
          {user.broken.map((b) => (
            <li key={b.id}>
              <Icon name="alert" size={14} />
              <span className="template-broken-text">
                <strong>{b.id}.json cannot be used.</strong> {b.problems[0]}
                {b.problems.length > 1 &&
                  ` (${b.problems.length - 1} more ${b.problems.length === 2 ? 'problem' : 'problems'})`}
              </span>
              <Button size="sm" onClick={() => void doDelete(b.id, `${b.id}.json`)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <>
      <div className="template-filters">
        <TextField
          label="Search templates"
          hideLabel
          type="search"
          placeholder="Search by name, tool or topic"
          value={query}
          data-testid="template-search"
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          label="Topic"
          hideLabel
          value={domain}
          data-testid="template-domain"
          onChange={(e) => setDomain(e.target.value)}
        >
          <option value="">All topics</option>
          {domainsOf(all).map((d) => (
            <option key={d} value={d}>
              {domainLabel(d)}
            </option>
          ))}
        </Select>
      </div>

      {/* The person's own templates lead once there are any; until then their hint waits below the ready-made ones. */}
      {user.entries.length > 0 ? (
        <>
          {userSection}
          {bundledSection}
        </>
      ) : (
        <>
          {bundledSection}
          {userSection}
        </>
      )}
    </>
  );
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

function InputField({
  input,
  value,
  error,
  onChange,
  autoFocus,
}: {
  input: TemplateInput;
  value: string;
  error?: string;
  onChange: (text: string) => void;
  autoFocus?: boolean;
}) {
  const warning = typeWarning(input, filesOf(input, value));
  const choose = async () => {
    const picked = await window.electron.ipcRenderer.selectFiles({
      title: input.label,
      multiple: input.multiple,
      extensions: pickerExtensions(input),
      typeName: input.types.join(' or ').toUpperCase(),
    });
    if (picked && picked.length > 0) onChange(input.multiple ? picked.join(', ') : picked[0]);
  };
  return (
    <div className="template-input" data-testid={`template-input-${input.id}`}>
      <div className="template-input-row">
        <TextField
          label={input.label}
          required={input.required}
          optional={!input.required}
          hint={
            error ? undefined : warning ? (
              <span className="template-input-warning" data-testid={`template-input-warning-${input.id}`}>
                <Icon name="alert" size={14} />
                <span>{warning}</span>
              </span>
            ) : (
              input.hint
            )
          }
          error={error}
          placeholder={input.example}
          value={value}
          autoFocus={autoFocus}
          data-testid={`template-input-field-${input.id}`}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          icon="folder"
          data-testid={`template-input-choose-${input.id}`}
          onClick={() => void choose()}
          tooltip={input.multiple ? 'Choose one or more files' : 'Choose a file'}
        >
          {input.multiple ? 'Choose files' : 'Choose file'}
        </Button>
      </div>
    </div>
  );
}

function SettingField({
  template,
  setting,
  value,
  error,
  onChange,
}: {
  template: WorkflowTemplate;
  setting: TemplateSetting;
  value: string | number | boolean | undefined;
  error?: string;
  onChange: (value: string | boolean) => void;
}) {
  const param = settingParam(template, setting);
  if (!param) return null;
  const testId = `template-setting-${setting.id}`;
  if (param.type === 'boolean') {
    return (
      <Checkbox
        label={setting.label}
        hint={setting.hint}
        checked={value === true || value === 'true'}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (param.type === 'select') {
    return (
      <Select
        label={setting.label}
        hint={setting.hint}
        error={error}
        value={String(value ?? '')}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      >
        {param.options?.map((option) => (
          <option key={option} value={option}>
            {param.option_labels?.[option] ?? option}
          </option>
        ))}
      </Select>
    );
  }
  if (param.type === 'number') {
    return (
      <NumberField
        label={setting.label}
        hint={setting.hint}
        error={error}
        min={param.min}
        max={param.max}
        step={param.step ?? 1}
        value={String(value ?? '')}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <TextField
      label={setting.label}
      hint={setting.hint}
      error={error}
      required={param.required}
      value={String(value ?? '')}
      data-testid={testId}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Setup({
  entry,
  name,
  texts,
  settings,
  onName,
  onText,
  onSetting,
  onOpenDocs,
}: {
  entry: GalleryEntry;
  name: string;
  texts: Record<string, string>;
  settings: SettingTexts;
  onName: (name: string) => void;
  onText: (id: string, text: string) => void;
  onSetting: (id: string, value: string | boolean) => void;
  onOpenDocs: (url: string) => void;
}) {
  const { template } = entry;
  const settingErrors = settingProblems(template, settings);
  const layout = readLayoutLabel(template);
  const needs = databaseNeeds(template);
  const problems = inputProblems(template, valuesFromText(template, texts));
  const missing = missingInputs(template, valuesFromText(template, texts));
  return (
    <div className="template-setup" data-testid="template-setup">
      <div className="template-setup-main">
        <div className="template-details-body">
          {detailParagraphs(template.details).map((paragraph) => (
            <p key={paragraph} className="template-details">
              {paragraph}
            </p>
          ))}
        </div>

        {entry.notes && entry.notes.length > 0 && (
          <Callout tone="info" data-testid="template-adapted-note">
            <strong>Made with an older version of the tool list.</strong> These options were changed to fit:
            <ul className="template-list">
              {entry.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Callout>
        )}

        {needs.map((need) => (
          <Callout key={need.tool} tone="warning" data-testid="template-database-note">
            <strong>
              {need.tool} needs {need.label}.
            </strong>{' '}
            {need.hint}
            {need.link && (
              <>
                {' '}
                <button type="button" className="link-button" onClick={() => onOpenDocs(need.link!.url)}>
                  {need.link.label}
                </button>
              </>
            )}{' '}
            Set it up first, or the step will stop with a message saying what is missing.
          </Callout>
        ))}

        <TextField
          label="Workflow name"
          value={name}
          data-testid="template-workflow-name"
          onChange={(e) => onName(e.target.value)}
          error={name.trim() ? undefined : 'Give the workflow a name.'}
        />

        <h4 className="template-section-title">Your files</h4>
        {template.inputs.length === 0 ? (
          <p className="template-hint">This pipeline needs no files from you. It is ready to create.</p>
        ) : (
          <>
            <p className="template-hint">
              Choose the files to start from. You can skip this and fill them in later: each step that still needs a file will say so.
            </p>
            {template.inputs.map((input, i) => (
              <InputField
                key={input.id}
                input={input}
                value={texts[input.id] ?? ''}
                error={problems[input.id]}
                autoFocus={i === 0}
                onChange={(text) => onText(input.id, text)}
              />
            ))}
            {missing.length > 0 && (
              <Callout tone="info" data-testid="template-missing-note">
                {missing.length === 1
                  ? `${missing[0].label} is not chosen yet. The workflow is created and shows what is missing.`
                  : `${missing.length} files are not chosen yet. The workflow is created and shows what is missing.`}
              </Callout>
            )}
          </>
        )}

        {(template.settings ?? []).length > 0 && (
          <section className="template-settings" aria-labelledby="template-settings-title" data-testid="template-settings">
            <h4 className="template-section-title" id="template-settings-title">
              Check these settings
            </h4>
            <p className="template-hint">
              They depend on your organism or library, so check them before you create the workflow. Every other option
              keeps its usual value and can be changed in its step later.
            </p>
            {(template.settings ?? []).map((setting) => (
              <SettingField
                key={setting.id}
                template={template}
                setting={setting}
                value={settings[setting.id]}
                error={settingErrors[setting.id]}
                onChange={(value) => onSetting(setting.id, value)}
              />
            ))}
          </section>
        )}
      </div>

      <aside className="template-setup-side" aria-label="About this template">
        <TemplateDag template={template} className="template-dag-large" />
        <p className="template-side-meta">
          {stepCountLabel(template)}, {DIFFICULTIES[template.difficulty].toLowerCase()}
          {layout ? `, ${layout.toLowerCase()}` : ''}. Uses {toolsLine(template)}.
        </p>
        {template.outputs.length > 0 && (
          <>
            <h4 className="template-section-title">What you get</h4>
            <ul className="template-list" data-testid="template-outputs">
              {template.outputs.map((o) => (
                <li key={`${o.step}-${o.slot}`}>
                  <strong>{o.label}.</strong> {o.hint}
                </li>
              ))}
            </ul>
          </>
        )}
        {template.references.length > 0 && (
          <>
            <h4 className="template-section-title">References</h4>
            <ul className="template-list" data-testid="template-references">
              {template.references.map((r) => (
                <li key={r.label}>
                  {r.url ? (
                    <button type="button" className="link-button" onClick={() => onOpenDocs(r.url!)}>
                      {r.label}
                    </button>
                  ) : (
                    r.label
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Dialog
// -----------------------------------------------------------------------------

export function TemplateGallery({
  onClose,
  onCreate,
  onSaveCurrent,
  saveBlockedReason,
  onConfirm,
  notify,
}: {
  onClose: () => void;
  /** Builds the workflow. Resolves false when the person declined to discard their work. */
  onCreate: (
    template: WorkflowTemplate,
    texts: Record<string, string>,
    name: string,
    settings: SettingTexts
  ) => Promise<boolean>;
  onSaveCurrent: () => void;
  /** Why "Save current workflow as a template" is unavailable, or undefined. */
  saveBlockedReason?: string;
  onConfirm: (request: ConfirmRequest) => Promise<boolean>;
  notify: Notify;
}) {
  const bundled = useMemo<GalleryEntry[]>(
    () => bundledTemplates().map((template) => ({ template, source: 'bundled' as const })),
    []
  );
  const [user, setUser] = useState<UserTemplates>({ entries: [], broken: [], loaded: false });
  const [stage, setStage] = useState<Stage>({ kind: 'gallery' });
  const [name, setName] = useState('');
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<SettingTexts>({});
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setUser(await loadUserTemplates());
    } catch {
      setUser({ entries: [], broken: [], loaded: true });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const pick = (entry: GalleryEntry) => {
    setName(entry.template.name);
    setTexts({});
    setSettings(initialSettingTexts(entry.template));
    setStage({ kind: 'setup', entry });
  };

  const openDocs = (url: string) => void window.electron.ipcRenderer.openDocs(url);

  if (stage.kind === 'setup') {
    const { template } = stage.entry;
    const values = valuesFromText(template, texts);
    const blocked =
      name.trim() === ''
        ? 'Give the workflow a name'
        : Object.keys(inputProblems(template, values)).length > 0
          ? 'Fix the file fields marked above'
          : Object.keys(settingProblems(template, settings)).length > 0
            ? 'Fix the settings marked above'
            : undefined;
    const create = async () => {
      setBusy(true);
      try {
        if (await onCreate(template, texts, name.trim(), settings)) onClose();
      } finally {
        setBusy(false);
      }
    };
    return (
      <Dialog
        title={template.name}
        size="lg"
        testId="template-dialog"
        onClose={onClose}
        dirty={Object.values(texts).some((t) => t.trim() !== '')}
        footer={
          <>
            <Button data-testid="template-back" onClick={() => setStage({ kind: 'gallery' })}>
              Back to templates
            </Button>
            <Button
              variant="primary"
              icon="plus"
              loading={busy}
              data-testid="template-create"
              disabledReason={blocked}
              onClick={() => void create()}
            >
              Create workflow
            </Button>
          </>
        }
      >
        <Setup
          entry={stage.entry}
          name={name}
          texts={texts}
          settings={settings}
          onName={setName}
          onText={(id, text) => setTexts((t) => ({ ...t, [id]: text }))}
          onSetting={(id, value) => setSettings((v) => ({ ...v, [id]: value }))}
          onOpenDocs={openDocs}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      title="New from template"
      size="lg"
      testId="template-dialog"
      onClose={onClose}
      footer={
        <>
          <Button
            icon="plus"
            data-testid="template-save-current"
            disabledReason={saveBlockedReason}
            onClick={onSaveCurrent}
          >
            Save current workflow as a template
          </Button>
          <Button data-testid="template-close" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <Gallery bundled={bundled} user={user} onPick={pick} onReload={reload} onConfirm={onConfirm} notify={notify} />
    </Dialog>
  );
}
