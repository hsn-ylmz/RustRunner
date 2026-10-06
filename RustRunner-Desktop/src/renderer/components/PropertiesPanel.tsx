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
  coerceNumber,
  defaultParams,
  findTool,
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
  Icon,
  NumberField,
  Panel,
  Select,
  TextArea,
  TextField,
} from '../ui';
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
  field: IssueField;
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
}) {
  // Which sections the person opened or closed, remembered between sessions.
  const [chosen, setChosen] = useState<OpenState>(loadOpenState);
  // Fields the person has been in. A required field is not called wrong before they got to it.
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [pendingFocus, setPendingFocus] = useState<IssueField | null>(null);

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
    setSectionOpen(sectionForField(focusRequest.field), true);
    setPendingFocus(focusRequest.field);
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
  const sectionProps = (section: SectionId, extra: { fileCount?: number } = {}) => ({
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

  const hasOutput = Boolean(selectedNode.data.output);
  const outputs = declaredOutputs(selectedNode.data.output);
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
  const missingParams = catalogTool ? missingRequiredParams(catalogTool, catalogParams) : [];

  /** Changing the tool away from the catalog's package turns the node into a free-form one. */
  const handleToolChange = (value: string) => {
    if (catalogTool && value.trim() !== catalogTool.conda.package) {
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
              ? `Step ID: ${labelToId(selectedNode.data.label)}`
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
          placeholder="e.g., bash, fastqc, bowtie2"
          hint={
            catalogTool
              ? 'From the tool catalog. Changing the tool makes this a free-form step.'
              : undefined
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
          hint="CPU threads this step requests from the scheduler."
        />
      </CollapsibleSection>

      <CollapsibleSection {...sectionProps('io', { fileCount: nodeFiles?.length })}>
        <div className="field" role="group" aria-labelledby="prop-input-files-label">
          <span className="field-label" id="prop-input-files-label">
            Input files
          </span>
          <Button icon="folder" fullWidth onClick={handleFileSelection}>
            Select files for batch processing
          </Button>
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
              Pattern: <code>{generatePattern(nodeFiles, wildcardName)}</code>
              <div>Will create {nodeFiles.length} step instance(s).</div>
            </Callout>

            <div className="property-actions">
              <Button size="sm" onClick={handleClearFiles}>
                Clear selected files
              </Button>
            </div>
          </>
        )}

        <TextField
          label="Wildcard name"
          value={selectedNode.data.wildcardName ?? ''}
          data-testid="prop-wildcard-name"
          onChange={(e) => handleWildcardNameChange(e.target.value)}
          placeholder="sample"
          maxLength={MAX_WILDCARD_NAME_LENGTH}
          error={wildcardNameProblem || undefined}
          hint={
            wildcardNameProblem ? undefined : (
              <>
                Write it as <code>{`{${wildcardName}}`}</code> in the input and output patterns; each
                selected file fills it in. Leave empty for "sample".
              </>
            )
          }
        />

        <TextField
          label="Input pattern"
          value={selectedNode.data.input || ''}
          data-testid="prop-input"
          onChange={(e) => handleInputChange('input', e.target.value)}
          onBlur={() => visit('input')}
          error={errorFor('input')}
          placeholder="e.g., {sample}.fastq or data/{sample}.txt"
          hint={
            hasWildcards(selectedNode.data.input || '')
              ? 'Wildcard detected: this will process multiple files.'
              : undefined
          }
        />

        <TextField
          label="Output pattern"
          value={selectedNode.data.output || ''}
          data-testid="prop-output"
          onChange={(e) => handleInputChange('output', e.target.value)}
          onBlur={() => visit('output')}
          error={errorFor('output')}
          placeholder="e.g., output/{sample}.txt"
          hint={
            hasWildcards(selectedNode.data.output || '')
              ? 'Output will be generated for each input file.'
              : undefined
          }
        />
      </CollapsibleSection>

      {catalogTool && (
        <CollapsibleSection {...sectionProps('options')} data-testid="catalog-params">
          <div className="field-hint" data-testid="catalog-types">
            {catalogTool.description} Conda package: {catalogTool.conda.package}. File types:{' '}
            {catalogTool.inputTypes.join(', ')} {'→'} {catalogTool.outputTypes.join(', ')}.
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
              label="Retry delay mode"
              value={normalizeBackoff(selectedNode.data.retryBackoff)}
              data-testid="prop-retry-backoff"
              onChange={(e) => handleInputChange('retryBackoff', e.target.value)}
            >
              <option value="fixed">Fixed</option>
              <option value="exponential">Exponential (doubles each retry)</option>
            </Select>

            <NumberField
              label="Retry delay"
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
              hint="Wait before the first retry; exponential mode doubles it each time."
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

      <CollapsibleSection {...sectionProps('checks')}>
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
          label="Blocking: stop here if a check fails"
          checked={isBlocking(selectedNode.data.checkBlocking)}
          data-testid="prop-check-blocking"
          disabled={!hasOutput}
          onChange={(e) => handleInputChange('checkBlocking', e.target.checked)}
        />
        {isMocked && (
          <Callout tone="warning" data-testid="mock-checks-note">
            This step is mocked: non-empty and line-count checks are skipped, "must exist" still
            runs.
          </Callout>
        )}
        <div className="field-hint">
          {hasOutput
            ? 'Run after the step succeeds. Each check can cover all outputs or just one. A failed blocking check fails the step and skips everything after it; the tool is not re-run. Unchecked "Blocking" only logs a warning.'
            : "Set an output file first; checks look at the step's outputs."}
        </div>
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
          placeholder="Enter command to execute"
          hint={
            <>
              The shell command this step runs. Use <code>{'{input}'}</code> and{' '}
              <code>{'{output}'}</code> as placeholders.
            </>
          }
        />

        <Checkbox
          label="Mock (don't run the tool)"
          checked={isMocked}
          data-testid="prop-mock"
          onChange={(e) => handleInputChange('mock', e.target.checked)}
          hint="Creates the step's outputs instead of running it: empty files, and folders for paths ending in /. Use it to try the rest of the workflow without the real tool. Non-empty and line-count checks are skipped. A mocked step, and every step after it, never counts as up to date, so a real run executes them."
        />
      </CollapsibleSection>
    </Panel>
  );
}
