import {
  MAX_RETRIES,
  MAX_RETRY_DELAY_SECS,
  DEFAULT_RETRY_DELAY_SECS,
  generatePattern,
  hasWildcards,
  labelToId,
  isBlocking,
  declaredOutputs,
  normalizeCheckTarget,
  MAX_WILDCARD_NAME_LENGTH,
  normalizeWildcardName,
  renameWildcardInPattern,
  wildcardNameError,
  normalizeBackoff,
  normalizeMinLines,
  normalizeRetries,
  normalizeRetryDelay,
  normalizeThreads,
  normalizeTimeout,
} from '../workflowConversion';
import {
  applyParamChange,
  catalogToolName,
  coerceNumber,
  defaultParams,
  describeInstall,
  findTool,
  inputTypesOf,
  outputTypesOf,
  missingRequiredParams,
  renderCommand,
  type ParamValue,
  type ToolParam,
} from '../tools/catalog';
import {
  Button,
  Callout,
  Checkbox,
  CollapsibleSection,
  FieldGroup,
  Icon,
  NumberField,
  Panel,
  Select,
  SwatchPicker,
  TextArea,
  TextField,
} from '../ui';
import { NODE_COLORS, nodeColorVar, normalizeNodeColor } from '../nodeColors';
import type { UpstreamChoice } from '../connections';
import type { BindingOption, LinkChoice, Preview, SlotKind, SlotState } from '../slots';
import { CommandPreview, SlotFields, type BindingPromptData } from './SlotFields';
import { useEffect, useState } from 'react';
import {
  SECTION_TITLES,
  isSectionOpen,
  loadOpenState,
  saveOpenState,
  sectionForField,
  sectionSummary,
  testIdForField,
  type OpenState,
  type SectionId,
  type SummaryExtra,
} from '../panelSections';
import type { IssueField } from '../validation';

/** Checkbox state may be a boolean or, from loose data, the string 'true'. */
const checksOn = (value: unknown) => value === true || value === 'true';

/** The three check presets: which node fields hold their switch and their target. */
const CHECK_TARGET_FIELDS = ['checkExistsTarget', 'checkNonEmptyTarget', 'checkMinLinesTarget'];

/**
 * "All outputs" or one of the node's declared outputs. A target that is no
 * longer one of the outputs (the output field was edited) stays visible and is
 * flagged, instead of silently changing what the check covers.
 */
function CheckTargetSelect({
  testId,
  value,
  outputs,
  disabled,
  onChange,
}: {
  testId: string;
  value: unknown;
  outputs: string[];
  disabled: boolean;
  onChange: (target: string) => void;
}) {
  const target = normalizeCheckTarget(value) ?? '';
  const stale = target !== '' && !outputs.includes(target);
  return (
    <Select
      className="check-target-select"
      label="Which output this check applies to"
      hideLabel
      value={target}
      data-testid={testId}
      disabled={disabled}
      error={
        stale ? (
          <span data-testid={`${testId}-stale`}>
            {target} is no longer one of this step's outputs; pick another or "All outputs".
          </span>
        ) : undefined
      }
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">All outputs</option>
      {outputs.map((output) => (
        <option key={output} value={output}>
          Only {output}
        </option>
      ))}
      {stale && <option value={target}>Only {target} (no longer an output)</option>}
    </Select>
  );
}

/** Asks the panel to open the section holding `field` and put the cursor in it. */
export interface FocusRequest {
  nodeId: string;
  /** Open the section holding this field and put the cursor in it. */
  field?: IssueField;
  /** Without a field: just open this section and bring it into view. */
  section?: SectionId;
}

export function PropertiesPanel({
  selectedNode,
  onNodeUpdate,
  onNodePatch,
  nodeFiles,
  onNodeFilesUpdate,
  addLog,
  fieldIssues = {},
  revealErrors = false,
  focusRequest = null,
  onFocusHandled,
  keepGoing = false,
  onOpenDetails,
  upstream = [],
  onConnectionChange,
  slots = [],
  slotChoices = [],
  commandPreview = null,
  onSlotFile,
  onSlotKind,
  onSlotLink,
  onSlotUnlink,
  bindingPrompt = null,
  onChooseBinding,
  onDismissBinding,
}: {
  selectedNode: any;
  onNodeUpdate: (nodeId: string, field: string, value: string | boolean) => void;
  onNodePatch: (nodeId: string, patch: Record<string, unknown>) => void;
  nodeFiles: string[];
  onNodeFilesUpdate: (nodeId: string, files: string[]) => void;
  addLog: (message: string) => void;
  /** Problems of this node by field (see validation.ts). */
  fieldIssues?: Partial<Record<IssueField, string>>;
  /** Show every problem now (the person tried to run), not only those on fields already visited. */
  revealErrors?: boolean;
  focusRequest?: FocusRequest | null;
  onFocusHandled?: () => void;
  /** The workflow-wide keep-going setting, shown in Reliability. */
  keepGoing?: boolean;
  onOpenDetails?: () => void;
  /** The other steps, for the "Runs after" list (see connections.ts). */
  upstream?: UpstreamChoice[];
  /** Connects (or disconnects) `sourceId` into the selected step. */
  onConnectionChange?: (sourceId: string, connected: boolean) => void;
  /** The files the command names with `{placeholders}` (see slots.ts). */
  slots?: SlotState[];
  /** Outputs of the steps before this one that a slot can be linked to by hand. */
  slotChoices?: LinkChoice[];
  /** The command with its files filled in. */
  commandPreview?: Preview | null;
  onSlotFile?: (slotId: string, value: string) => void;
  onSlotKind?: (slotId: string, kind: SlotKind) => void;
  onSlotLink?: (slotId: string, nodeId: string, outputKey: string) => void;
  onSlotUnlink?: (slotId: string, fromNodeId?: string) => void;
  /** A connection that fits several slots: the person picks one. */
  bindingPrompt?: BindingPromptData | null;
  onChooseBinding?: (option: BindingOption) => void;
  onDismissBinding?: () => void;
}) {
  // Which sections the person opened or closed, remembered between sessions.
  const [chosen, setChosen] = useState<OpenState>(loadOpenState);
  // Fields the person has been in. A required field is not called wrong before they got to it.
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [pendingFocus, setPendingFocus] = useState<IssueField | null>(null);
  const [pendingSection, setPendingSection] = useState<SectionId | null>(null);

  const nodeId: string | undefined = selectedNode?.id;

  const setSectionOpen = (section: SectionId, open: boolean) => {
    setChosen((prev) => {
      const next = { ...prev, [section]: open };
      saveOpenState(next);
      return next;
    });
  };

  // A jump from the problem list: open the section, then focus the field once it exists.
  useEffect(() => {
    if (!focusRequest || !selectedNode || focusRequest.nodeId !== nodeId) return;
    if (focusRequest.field) {
      setSectionOpen(sectionForField(focusRequest.field), true);
      setPendingFocus(focusRequest.field);
    } else if (focusRequest.section) {
      setSectionOpen(focusRequest.section, true);
      setPendingSection(focusRequest.section);
    }
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  useEffect(() => {
    if (!pendingFocus) return;
    const el = document.querySelector<HTMLElement>(`[data-testid="${testIdForField(pendingFocus)}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: 'nearest' });
    el.focus();
    setPendingFocus(null);
  }, [pendingFocus, chosen]);

  useEffect(() => {
    if (!pendingSection) return;
    const el = document.querySelector<HTMLElement>(`[data-testid="section-${pendingSection}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: 'start' });
    setPendingSection(null);
  }, [pendingSection, chosen]);

  if (!selectedNode) {
    return (
      <Panel className="properties-panel" title="Properties">
        <p className="no-selection">Select a node to edit its properties</p>
      </Panel>
    );
  }

  const data = selectedNode.data;
  const visit = (field: string) =>
    setVisited((prev) => (prev.has(`${nodeId}:${field}`) ? prev : new Set(prev).add(`${nodeId}:${field}`)));
  /** The problem to show on a field: always for the name, otherwise once visited or after a run attempt. */
  const errorFor = (field: IssueField): string | undefined => {
    const message = fieldIssues[field];
    if (!message) return undefined;
    return field === 'label' || revealErrors || visited.has(`${nodeId}:${field}`) ? message : undefined;
  };
  const problemCount = (section: SectionId) =>
    (Object.keys(fieldIssues) as IssueField[]).filter(
      (f) => sectionForField(f) === section && errorFor(f)
    ).length;
  const sectionProps = (
    section: SectionId,
    extra: SummaryExtra = {}
  ) => ({
    title: SECTION_TITLES[section],
    open: isSectionOpen(section, chosen, data),
    onToggle: (open: boolean) => setSectionOpen(section, open),
    summary: sectionSummary(section, data, extra),
    attention:
      problemCount(section) > 0
        ? problemCount(section) === 1
          ? '1 problem'
          : `${problemCount(section)} problems`
        : undefined,
    'data-testid': `section-${section}`,
  });

  // Checks look at the main output and at the files of named outputs.
  const namedOutputs = slots.filter((s) => s.def.kind === 'output').flatMap((s) => s.files);
  const outputs = [...declaredOutputs(selectedNode.data.output), ...namedOutputs];
  const hasOutput = Boolean(selectedNode.data.output) || namedOutputs.length > 0;
  const isMocked = checksOn(selectedNode.data.mock);
  /** The name used inside {braces} for this node's batch files. */
  const wildcardName = normalizeWildcardName(selectedNode.data.wildcardName);
  const wildcardNameProblem = wildcardNameError(selectedNode.data.wildcardName);

  const handleInputChange = (field: string, value: string | boolean) => {
    onNodeUpdate(selectedNode.id, field, value);
  };

  // A node made from the tool catalog shows its parameter form; the command is
  // rendered from the parameters until the user edits the command by hand.
  const catalogTool = findTool(selectedNode.data.catalogId);
  const catalogParams: Record<string, ParamValue> = catalogTool
    ? { ...defaultParams(catalogTool), ...(selectedNode.data.catalogParams ?? {}) }
    : {};
  const commandIsCustom = selectedNode.data.catalogCommandCustom === true;
  /** A catalog step names every file in a slot; the single Input and Output fields are for free-form steps and hand-edited commands. */
  const showMainFiles = !catalogTool || commandIsCustom;
  const missingParams = catalogTool ? missingRequiredParams(catalogTool, catalogParams) : [];

  /** Changing the tool away from the catalog's package turns the node into a free-form one. */
  const handleToolChange = (value: string) => {
    if (catalogTool && value.trim() !== catalogToolName(catalogTool)) {
      onNodePatch(selectedNode.id, {
        tool: value,
        catalogId: undefined,
        catalogParams: undefined,
        catalogCommandCustom: undefined,
      });
      return;
    }
    handleInputChange('tool', value);
  };

  /** Typing in the command box takes it over from the parameter form. */
  const handleCommandChange = (value: string) => {
    if (catalogTool) {
      onNodePatch(selectedNode.id, { command: value, catalogCommandCustom: true });
      return;
    }
    handleInputChange('command', value);
  };

  const handleParamChange = (param: ToolParam, value: ParamValue) => {
    if (!catalogTool) return;
    onNodePatch(
      selectedNode.id,
      applyParamChange(catalogTool, selectedNode.data, {
        params: { ...catalogParams, [param.id]: value },
      })
    );
  };

  /** The thread count also appears in a catalog command, so it re-renders it. */
  const handleThreadsChange = (value: string) => {
    if (!catalogTool) {
      handleInputChange('threads', value);
      return;
    }
    onNodePatch(selectedNode.id, {
      threads: value,
      ...applyParamChange(catalogTool, selectedNode.data, { threads: value }),
    });
  };

  const handleRegenerateCommand = () => {
    if (!catalogTool) return;
    onNodePatch(selectedNode.id, {
      command: renderCommand(catalogTool, catalogParams, selectedNode.data.threads),
      catalogCommandCustom: false,
    });
  };

  /**
   * Renames the wildcard. Patterns already on the node follow the new name, so
   * `{sample}` in the input and output becomes `{lane}` without retyping.
   */
  const handleWildcardNameChange = (value: string) => {
    // Only characters a wildcard name can contain are accepted at all.
    if (!/^[A-Za-z0-9_]*$/.test(value) || value.length > MAX_WILDCARD_NAME_LENGTH) return;

    const next = normalizeWildcardName(value);
    handleInputChange('wildcardName', value);
    if (wildcardNameError(value) === null && next !== wildcardName) {
      handleInputChange('input', renameWildcardInPattern(selectedNode.data.input || '', wildcardName, next));
      handleInputChange('output', renameWildcardInPattern(selectedNode.data.output || '', wildcardName, next));
      // A check aimed at one output follows the renamed pattern too.
      for (const field of CHECK_TARGET_FIELDS) {
        const target = selectedNode.data[field];
        if (typeof target === 'string' && target !== '') {
          handleInputChange(field, renameWildcardInPattern(target, wildcardName, next));
        }
      }
    }
  };

  const handleFileSelection = async () => {
    try {
      const files = await window.electron.ipcRenderer.selectFiles();
      if (files && files.length > 0) {
        // Generate pattern automatically
        const pattern = generatePattern(files, wildcardName);
        handleInputChange('input', pattern);
        
        // Store files for this node
        onNodeFilesUpdate(selectedNode.id, files);
        
        // Log success
        addLog(`Selected ${files.length} file(s) for ${selectedNode.data.label}`);
        
        // Auto-suggest output pattern if not set
        if (!selectedNode.data.output || selectedNode.data.output === '') {
          const outputPattern = pattern.replace(`{${wildcardName}}`, `output/{${wildcardName}}`);
          handleInputChange('output', outputPattern);
        }
      }
    } catch (error) {
      console.error('File selection error:', error);
      addLog('Failed to select files');
    }
  };

  const handleClearFiles = () => {
    onNodeFilesUpdate(selectedNode.id, []);
    handleInputChange('input', '');
    addLog(`Cleared files for ${selectedNode.data.label}`);
  };

  return (
    <Panel
      className="properties-panel"
      data-testid="properties-panel"
      title="Node properties"
      aria-label="Node properties"
    >
      <CollapsibleSection {...sectionProps('basics')}>
        <TextField
          label="Node name"
          value={selectedNode.data.label || ''}
          data-testid="prop-label"
          onChange={(e) => handleInputChange('label', e.target.value)}
          onBlur={() => visit('label')}
          error={errorFor('label')}
          hint={
            selectedNode.data.label && !errorFor('label')
              ? `Its results and log lines are marked "${labelToId(selectedNode.data.label)}".`
              : undefined
          }
        />

        <TextField
          label="Tool"
          value={selectedNode.data.tool || ''}
          data-testid="prop-tool"
          onChange={(e) => handleToolChange(e.target.value)}
          onBlur={() => visit('tool')}
          error={errorFor('tool')}
          placeholder="e.g. bash, fastqc, bowtie2"
          hint={
            catalogTool
              ? 'From the tool catalog. Changing the tool makes this a free-form step.'
              : 'The program this step runs. It is installed with conda when the workflow first runs.'
          }
        />

        <NumberField
          label="Threads"
          min={1}
          step={1}
          value={selectedNode.data.threads ?? 1}
          data-testid="prop-threads"
          onChange={(e) => handleThreadsChange(e.target.value)}
          onBlur={(e) => handleThreadsChange(String(normalizeThreads(e.target.value)))}
          hint="How many processor cores this step may use."
        />

        <div className="field">
          <span className="field-label" id="prop-color-label">
            Colour
          </span>
          <SwatchPicker
            label="Node colour"
            swatches={NODE_COLORS.map((c) => ({ ...c, color: nodeColorVar(c.id) }))}
            value={normalizeNodeColor(selectedNode.data.color)}
            onChange={(color) => handleInputChange('color', color)}
            data-testid="prop-color"
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        {...sectionProps('io', {
          fileCount: nodeFiles?.length,
          upstreamCount: upstream.filter((u) => u.connected).length,
          slotCount: slots.length,
          slotsToFill: slots.filter(
            (s) =>
              s.files.length === 0 &&
              !s.def.derived &&
              (s.def.kind === 'output' || s.def.required || s.links.length > 0)
          ).length,
        })}
      >
        {upstream.length > 0 && (
          <FieldGroup
            label="Runs after"
            data-testid="prop-upstream"
            hint="Ticked steps finish before this one starts, and their outputs can be its inputs. The same as drawing a connection on the canvas."
          >
            {upstream.map((choice) => (
              <Checkbox
                key={choice.nodeId}
                label={choice.wouldLoop ? `${choice.label} (runs after this step)` : choice.label}
                checked={choice.connected}
                disabled={choice.wouldLoop || !onConnectionChange}
                data-testid={`prop-upstream-${choice.nodeId}`}
                onChange={(e) => onConnectionChange?.(choice.nodeId, e.target.checked)}
              />
            ))}
          </FieldGroup>
        )}

        <div className="field" role="group" aria-labelledby="prop-input-files-label">
          <span className="field-label" id="prop-input-files-label">
            Run once per file
          </span>
          <Button icon="folder" fullWidth onClick={handleFileSelection} data-testid="prop-choose-files">
            Choose input files…
          </Button>
          <div className="field-hint">
            Optional. Pick several files and this step runs once for each of them.
          </div>
        </div>

        {nodeFiles && nodeFiles.length > 0 && (
          <>
            <div className="file-list">
              <div className="file-list-header">
                <Icon name="check" size={12} />
                Selected {nodeFiles.length} file(s)
              </div>
              {nodeFiles.slice(0, 5).map((file: string, i: number) => (
                <div key={i} className="file-item">
                  <Icon name="file" size={12} />
                  {file.split('/').pop()}
                </div>
              ))}
              {nodeFiles.length > 5 && (
                <div className="file-item file-item-more">... and {nodeFiles.length - 5} more</div>
              )}
            </div>

            <Callout tone="info">
              Input: <code>{generatePattern(nodeFiles, wildcardName)}</code>
              <div>
                The step runs {nodeFiles.length} time{nodeFiles.length === 1 ? '' : 's'}, once per file.
              </div>
            </Callout>

            <div className="property-actions">
              <Button size="sm" onClick={handleClearFiles}>
                Clear selected files
              </Button>
            </div>
          </>
        )}

        <TextField
          label="Name for each file"
          value={selectedNode.data.wildcardName ?? ''}
          data-testid="prop-wildcard-name"
          onChange={(e) => handleWildcardNameChange(e.target.value)}
          placeholder="sample"
          maxLength={MAX_WILDCARD_NAME_LENGTH}
          error={wildcardNameProblem || undefined}
          hint={
            wildcardNameProblem ? undefined : (
              <>
                <code>{`{${wildcardName}}`}</code> in a file name below stands for each
                chosen file, e.g. <code>{`out/{${wildcardName}}.bam`}</code>. Empty means "sample".
              </>
            )
          }
        />

        {showMainFiles && (
          <>
            <TextField
              label="Input file"
              value={selectedNode.data.input || ''}
              data-testid="prop-input"
              onChange={(e) => handleInputChange('input', e.target.value)}
              onBlur={() => visit('input')}
              error={errorFor('input')}
              placeholder="e.g. reads.fastq or data/{sample}.fastq"
              hint={
                hasWildcards(selectedNode.data.input || '')
                  ? 'Has a {name}: the step runs once for each matching file.'
                  : 'What the command reads, written as {input} in it. Separate several with commas.'
              }
            />

            <TextField
              label="Output file"
              value={selectedNode.data.output || ''}
              data-testid="prop-output"
              onChange={(e) => handleInputChange('output', e.target.value)}
              onBlur={() => visit('output')}
              error={errorFor('output')}
              placeholder="e.g. results/counts.tsv"
              hint={
                hasWildcards(selectedNode.data.output || '')
                  ? 'One output is made for each input file.'
                  : 'What the command writes, written as {output} in it. Later steps can read it.'
              }
            />
          </>
        )}

        <SlotFields
          slots={slots}
          choices={slotChoices}
          prompt={bindingPrompt}
          errorFor={(slot) => errorFor(`slot:${slot}`)}
          onVisit={(slot) => visit(`slot:${slot}`)}
          onFile={(slot, value) => onSlotFile?.(slot, value)}
          onKind={(slot, kind) => onSlotKind?.(slot, kind)}
          onLink={(slot, choice) => onSlotLink?.(slot, choice.nodeId, choice.outputKey)}
          onUnlink={(slot, fromNodeId) => onSlotUnlink?.(slot, fromNodeId)}
          onChoose={(option) => onChooseBinding?.(option)}
          onDismiss={() => onDismissBinding?.()}
        />
      </CollapsibleSection>

      {catalogTool && (
        <CollapsibleSection {...sectionProps('options')} data-testid="catalog-params">
          <div className="field-hint" data-testid="catalog-types">
            {catalogTool.description} {describeInstall(catalogTool.install)} File types:{' '}
            {inputTypesOf(catalogTool).join(', ')} {'→'} {outputTypesOf(catalogTool).join(', ')}.
          </div>

          {catalogTool.needs_database && (
            <Callout tone="info" data-testid="catalog-needs-database">
              <strong>Needs {catalogTool.needs_database.label}.</strong>{' '}
              {catalogTool.needs_database.hint}
            </Callout>
          )}

          <div className="property-actions">
            <Button
              size="sm"
              icon="link"
              data-testid="catalog-docs"
              onClick={() => void window.electron.ipcRenderer.openDocs(catalogTool.docs)}
            >
              Open the {catalogTool.name} documentation
            </Button>
          </div>

          {catalogTool.params.map((param) => {
            const testId = `catalog-param-${param.id}`;
            const value = catalogParams[param.id];
            const paramError = errorFor(`param:${param.id}`);
            if (param.type === 'boolean') {
              return (
                <Checkbox
                  key={param.id}
                  label={param.label}
                  hint={param.description}
                  checked={value === true || value === 'true'}
                  data-testid={testId}
                  onChange={(e) => handleParamChange(param, e.target.checked)}
                />
              );
            }
            if (param.type === 'select') {
              return (
                <Select
                  key={param.id}
                  label={param.label}
                  required={param.required}
                  hint={param.description}
                  value={String(value)}
                  data-testid={testId}
                  onChange={(e) => handleParamChange(param, e.target.value)}
                >
                  {param.options?.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              );
            }
            if (param.type === 'number') {
              return (
                <NumberField
                  key={param.id}
                  label={param.label}
                  required={param.required}
                  hint={param.description}
                  min={param.min}
                  max={param.max}
                  step={1}
                  value={String(value ?? '')}
                  data-testid={testId}
                  error={paramError}
                  onChange={(e) => handleParamChange(param, e.target.value)}
                  onBlur={(e) => {
                    visit(`param:${param.id}`);
                    handleParamChange(param, coerceNumber(param, e.target.value));
                  }}
                />
              );
            }
            return (
              <TextField
                key={param.id}
                label={param.label}
                required={param.required}
                hint={param.description}
                value={String(value ?? '')}
                data-testid={testId}
                error={paramError}
                placeholder={param.required ? 'Required' : undefined}
                onChange={(e) => handleParamChange(param, e.target.value)}
                onBlur={() => visit(`param:${param.id}`)}
              />
            );
          })}

          {missingParams.length > 0 && !commandIsCustom && (
            <Callout tone="warning" data-testid="catalog-missing">
              Fill in:{' '}
              {missingParams
                .map((id) => catalogTool.params.find((p) => p.id === id)?.label ?? id)
                .join(', ')}
            </Callout>
          )}

          {commandIsCustom && (
            <Callout tone="info" data-testid="catalog-custom-note">
              The command was edited by hand, so these options no longer change it.
              <div>
                <Button
                  size="sm"
                  onClick={handleRegenerateCommand}
                  data-testid="catalog-regenerate"
                >
                  Rebuild command from options
                </Button>
              </div>
            </Callout>
          )}
        </CollapsibleSection>
      )}

      <CollapsibleSection {...sectionProps('reliability')}>
        <NumberField
          label="Retries"
          min={0}
          max={MAX_RETRIES}
          step={1}
          value={selectedNode.data.retries ?? 0}
          data-testid="prop-retries"
          onChange={(e) => handleInputChange('retries', e.target.value)}
          onBlur={(e) => handleInputChange('retries', String(normalizeRetries(e.target.value)))}
          hint="Extra attempts after a failure or timeout. 0 runs the step once."
        />

        {normalizeRetries(selectedNode.data.retries) > 0 && (
          <>
            <Select
              label="Wait between retries"
              value={normalizeBackoff(selectedNode.data.retryBackoff)}
              data-testid="prop-retry-backoff"
              onChange={(e) => handleInputChange('retryBackoff', e.target.value)}
            >
              <option value="fixed">The same each time</option>
              <option value="exponential">Doubles each time</option>
            </Select>

            <NumberField
              label="First wait"
              unit="seconds"
              min={0}
              max={MAX_RETRY_DELAY_SECS}
              step={1}
              value={selectedNode.data.retryDelaySecs ?? DEFAULT_RETRY_DELAY_SECS}
              data-testid="prop-retry-delay"
              onChange={(e) => handleInputChange('retryDelaySecs', e.target.value)}
              onBlur={(e) =>
                handleInputChange('retryDelaySecs', String(normalizeRetryDelay(e.target.value)))
              }
              hint="How long to wait before the first retry."
            />
          </>
        )}

        <NumberField
          label="Timeout"
          unit="seconds"
          min={1}
          step={1}
          value={selectedNode.data.timeoutSecs ?? ''}
          data-testid="prop-timeout"
          onChange={(e) => handleInputChange('timeoutSecs', e.target.value)}
          onBlur={(e) =>
            handleInputChange('timeoutSecs', String(normalizeTimeout(e.target.value) ?? ''))
          }
          placeholder="No limit"
          hint="Each attempt is killed if it runs longer than this. Leave empty for no limit."
        />

        <div className="field-hint" data-testid="keep-going-hint">
          Keep going after a failure is a setting of the whole workflow, and is{' '}
          <strong>{keepGoing ? 'on' : 'off'}</strong>.{' '}
          {keepGoing
            ? 'Steps that do not depend on a failed step still run.'
            : 'When a step fails, the steps after it do not run.'}
          {onOpenDetails && (
            <div>
              <Button size="sm" onClick={onOpenDetails} data-testid="open-keep-going">
                Change in workflow details
              </Button>
            </div>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection {...sectionProps('checks', { hasOutput })}>
        <div className="field-hint" data-testid="checks-hint">
          {hasOutput
            ? 'Checked after the step succeeds. Each check can cover all outputs or just one.'
            : 'Set an output file first (in Inputs and outputs): checks look at what the step writes.'}
        </div>
        <Checkbox
          label="Outputs must exist"
          checked={checksOn(selectedNode.data.checkExists)}
          data-testid="prop-check-exists"
          disabled={!hasOutput}
          onChange={(e) => handleInputChange('checkExists', e.target.checked)}
        />
        {checksOn(selectedNode.data.checkExists) && (
          <CheckTargetSelect
            testId="prop-check-exists-target"
            value={selectedNode.data.checkExistsTarget}
            outputs={outputs}
            disabled={!hasOutput}
            onChange={(target) => handleInputChange('checkExistsTarget', target)}
          />
        )}
        <Checkbox
          label="Outputs must be non-empty"
          checked={checksOn(selectedNode.data.checkNonEmpty)}
          data-testid="prop-check-non-empty"
          disabled={!hasOutput}
          onChange={(e) => handleInputChange('checkNonEmpty', e.target.checked)}
        />
        {checksOn(selectedNode.data.checkNonEmpty) && (
          <CheckTargetSelect
            testId="prop-check-non-empty-target"
            value={selectedNode.data.checkNonEmptyTarget}
            outputs={outputs}
            disabled={!hasOutput}
            onChange={(target) => handleInputChange('checkNonEmptyTarget', target)}
          />
        )}
        <Checkbox
          label="At least N lines"
          checked={checksOn(selectedNode.data.checkMinLinesEnabled)}
          data-testid="prop-check-min-lines-enabled"
          disabled={!hasOutput}
          onChange={(e) => handleInputChange('checkMinLinesEnabled', e.target.checked)}
        />
        {checksOn(selectedNode.data.checkMinLinesEnabled) && (
          <NumberField
            label="Minimum lines"
            min={1}
            step={1}
            value={selectedNode.data.checkMinLines ?? ''}
            data-testid="prop-check-min-lines"
            disabled={!hasOutput}
            onChange={(e) => handleInputChange('checkMinLines', e.target.value)}
            onBlur={(e) =>
              handleInputChange('checkMinLines', String(normalizeMinLines(e.target.value) ?? ''))
            }
            placeholder="e.g. 10"
          />
        )}
        {checksOn(selectedNode.data.checkMinLinesEnabled) && (
          <CheckTargetSelect
            testId="prop-check-min-lines-target"
            value={selectedNode.data.checkMinLinesTarget}
            outputs={outputs}
            disabled={!hasOutput}
            onChange={(target) => handleInputChange('checkMinLinesTarget', target)}
          />
        )}
        <Checkbox
          label="Stop the run if a check fails"
          checked={isBlocking(selectedNode.data.checkBlocking)}
          data-testid="prop-check-blocking"
          disabled={!hasOutput}
          onChange={(e) => handleInputChange('checkBlocking', e.target.checked)}
          hint={
            hasOutput
              ? 'On: the step fails and the steps after it do not run (the tool is not re-run). Off: a failed check is only a warning.'
              : undefined
          }
        />
        {isMocked && (
          <Callout tone="warning" data-testid="mock-checks-note">
            This step is mocked: non-empty and line-count checks are skipped, "must exist" still
            runs.
          </Callout>
        )}
      </CollapsibleSection>

      <CollapsibleSection {...sectionProps('advanced')}>
        <TextArea
          label="Command"
          mono
          rows={4}
          value={selectedNode.data.command || ''}
          data-testid="prop-command"
          onChange={(e) => handleCommandChange(e.target.value)}
          onBlur={() => visit('command')}
          error={errorFor('command')}
          placeholder="e.g. fastqc {input} -o results"
          hint={
            <>
              The shell command this step runs. Use <code>{'{input}'}</code> and{' '}
              <code>{'{output}'}</code> as placeholders, or name other files in braces, such as{' '}
              <code>{'{ref}'}</code>: each one gets a file field under Inputs and outputs.
            </>
          }
        />

        {commandPreview && <CommandPreview preview={commandPreview} />}

        <Checkbox
          label="Test run: skip the tool, make empty outputs"
          checked={isMocked}
          data-testid="prop-mock"
          onChange={(e) => handleInputChange('mock', e.target.checked)}
          hint="Tries the rest of the workflow without this tool: empty files (folders for paths ending in /) stand in for its outputs. Non-empty and line-count checks are skipped, and a later real run executes this step and every step after it."
        />
      </CollapsibleSection>
    </Panel>
  );
}
