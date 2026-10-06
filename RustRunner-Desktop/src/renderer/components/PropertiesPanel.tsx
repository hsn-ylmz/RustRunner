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
    <div className="check-target">
      <select
        className="property-input check-target-select"
        value={target}
        data-testid={testId}
        disabled={disabled}
        aria-label="Which output this check applies to"
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All outputs</option>
        {outputs.map((output) => (
          <option key={output} value={output}>
            Only {output}
          </option>
        ))}
        {stale && <option value={target}>Only {target} (no longer an output)</option>}
      </select>
      {stale && (
        <div className="property-error" data-testid={`${testId}-stale`}>
          ⚠ {target} is no longer one of this step's outputs; pick another or "All outputs".
        </div>
      )}
    </div>
  );
}

export function PropertiesPanel({
  selectedNode,
  onNodeUpdate,
  onNodePatch,
  nodeFiles,
  onNodeFilesUpdate,
  addLog,
  invalidReason,
}: any) {
  if (!selectedNode) {
    return (
      <div className="properties-panel">
        <h3>Properties</h3>
        <p className="no-selection">Select a node to edit its properties</p>
      </div>
    );
  }

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
    <div className="properties-panel" data-testid="properties-panel">
      <h3>Node Properties</h3>

      <div className="property-group">
        <label className="property-label">Node Name:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.label || ''}
          data-testid="prop-label"
          onChange={(e) => handleInputChange('label', e.target.value)}
        />
        {selectedNode.data.label && !invalidReason && (
          <div className="property-hint">
            Step ID: {labelToId(selectedNode.data.label)}
          </div>
        )}
        {invalidReason && (
          <div className="property-error">⚠ {invalidReason}</div>
        )}
      </div>

      <div className="property-group">
        <label className="property-label">Tool:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.tool || ''}
          data-testid="prop-tool"
          onChange={(e) => handleToolChange(e.target.value)}
          placeholder="e.g., bash, fastqc, bowtie2"
        />
        {catalogTool && (
          <div className="property-hint">
            From the tool catalog. Changing the tool makes this a free-form step.
          </div>
        )}
      </div>

      {catalogTool && (
        <div className="property-group catalog-section" data-testid="catalog-params">
          <label className="property-label">{catalogTool.name} options:</label>
          <div className="property-hint" data-testid="catalog-types">
            {catalogTool.description} Conda package: {catalogTool.conda.package}. File types:{' '}
            {catalogTool.inputTypes.join(', ')} {'→'} {catalogTool.outputTypes.join(', ')}.
          </div>

          {catalogTool.params.map((param) => {
            const testId = `catalog-param-${param.id}`;
            const value = catalogParams[param.id];
            if (param.type === 'boolean') {
              return (
                <div key={param.id} className="catalog-param">
                  <label className="property-checkbox">
                    <input
                      type="checkbox"
                      checked={value === true || value === 'true'}
                      data-testid={testId}
                      onChange={(e) => handleParamChange(param, e.target.checked)}
                    />{' '}
                    {param.label}
                  </label>
                  <div className="property-hint">{param.description}</div>
                </div>
              );
            }
            return (
              <div key={param.id} className="catalog-param">
                <label className="property-label catalog-param-label">
                  {param.label}
                  {param.required ? ' (required)' : ''}:
                </label>
                {param.type === 'select' ? (
                  <select
                    className="property-input"
                    value={String(value)}
                    data-testid={testId}
                    onChange={(e) => handleParamChange(param, e.target.value)}
                  >
                    {param.options?.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : param.type === 'number' ? (
                  <input
                    type="number"
                    className="property-input"
                    min={param.min}
                    max={param.max}
                    step={1}
                    value={String(value ?? '')}
                    data-testid={testId}
                    onChange={(e) => handleParamChange(param, e.target.value)}
                    onBlur={(e) => handleParamChange(param, coerceNumber(param, e.target.value))}
                  />
                ) : (
                  <input
                    type="text"
                    className="property-input"
                    value={String(value ?? '')}
                    data-testid={testId}
                    placeholder={param.required ? 'Required' : undefined}
                    onChange={(e) => handleParamChange(param, e.target.value)}
                  />
                )}
                <div className="property-hint">{param.description}</div>
              </div>
            );
          })}

          {missingParams.length > 0 && !commandIsCustom && (
            <div className="property-error" data-testid="catalog-missing">
              ⚠ Fill in:{' '}
              {missingParams
                .map((id) => catalogTool.params.find((p) => p.id === id)?.label ?? id)
                .join(', ')}
            </div>
          )}

          {commandIsCustom && (
            <div className="property-hint" data-testid="catalog-custom-note">
              The command was edited by hand, so these options no longer change it.{' '}
              <button
                className="property-button property-button-secondary"
                onClick={handleRegenerateCommand}
                data-testid="catalog-regenerate"
              >
                Rebuild command from options
              </button>
            </div>
          )}
        </div>
      )}

      <div className="property-group">
        <label className="property-label">Command:</label>
        <textarea
          className="property-textarea"
          value={selectedNode.data.command || ''}
          data-testid="prop-command"
          onChange={(e) => handleCommandChange(e.target.value)}
          placeholder="Enter command to execute"
          rows={4}
        />
        <div className="property-hint">
          Use {'{input}'} and {'{output}'} as placeholders
        </div>
      </div>

      {/* WILDCARDS FEATURE: File Selection */}
      <div className="property-group">
        <label className="property-label">Input Files:</label>
        <button 
          className="property-button" 
          onClick={handleFileSelection}
        >
          📁 Select Files for Batch Processing...
        </button>
        
        {nodeFiles && nodeFiles.length > 0 && (
          <>
            <div className="file-list">
              <div className="file-list-header">
                ✓ Selected {nodeFiles.length} file(s):
              </div>
              {nodeFiles.slice(0, 5).map((file: string, i: number) => (
                <div key={i} className="file-item">
                  {file.split('/').pop()}
                </div>
              ))}
              {nodeFiles.length > 5 && (
                <div className="file-item file-item-more">
                  ... and {nodeFiles.length - 5} more
                </div>
              )}
            </div>
            
            <div className="wildcard-info">
              <div className="property-hint">
                🔄 Pattern: <code>{generatePattern(nodeFiles, wildcardName)}</code>
              </div>
              <div className="property-hint">
                ⚡ Will create {nodeFiles.length} step instance(s)
              </div>
            </div>
            
            <button 
              className="property-button property-button-secondary" 
              onClick={handleClearFiles}
            >
              Clear Selected Files
            </button>
          </>
        )}
      </div>

      <div className="property-group">
        <label className="property-label">Wildcard Name:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.wildcardName ?? ''}
          data-testid="prop-wildcard-name"
          onChange={(e) => handleWildcardNameChange(e.target.value)}
          placeholder="sample"
          maxLength={MAX_WILDCARD_NAME_LENGTH}
        />
        {wildcardNameProblem ? (
          <div className="property-error">⚠ {wildcardNameProblem}</div>
        ) : (
          <div className="property-hint">
            Write it as <code>{`{${wildcardName}}`}</code> in the input and output patterns; each
            selected file fills it in. Leave empty for "sample".
          </div>
        )}
      </div>

      <div className="property-group">
        <label className="property-label">Input Pattern:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.input || ''}
          data-testid="prop-input"
          onChange={(e) => handleInputChange('input', e.target.value)}
          placeholder="e.g., {sample}.fastq or data/{sample}.txt"
        />
        {hasWildcards(selectedNode.data.input || '') && (
          <div className="property-hint">
            🎯 Wildcard detected - this will process multiple files
          </div>
        )}
      </div>

      <div className="property-group">
        <label className="property-label">Output Pattern:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.output || ''}
          data-testid="prop-output"
          onChange={(e) => handleInputChange('output', e.target.value)}
          placeholder="e.g., output/{sample}.txt"
        />
        {hasWildcards(selectedNode.data.output || '') && (
          <div className="property-hint">
            💾 Output will be generated for each input file
          </div>
        )}
      </div>

      <div className="property-group">
        <label className="property-label">Threads:</label>
        <input
          type="number"
          min={1}
          step={1}
          className="property-input"
          value={selectedNode.data.threads ?? 1}
          data-testid="prop-threads"
          onChange={(e) => handleThreadsChange(e.target.value)}
          onBlur={(e) => handleThreadsChange(String(normalizeThreads(e.target.value)))}
        />
        <div className="property-hint">
          CPU threads this step requests from the scheduler.
        </div>
      </div>

      <div className="property-group">
        <label className="property-label">Retries:</label>
        <input
          type="number"
          min={0}
          max={MAX_RETRIES}
          step={1}
          className="property-input"
          value={selectedNode.data.retries ?? 0}
          data-testid="prop-retries"
          onChange={(e) => handleInputChange('retries', e.target.value)}
          onBlur={(e) =>
            handleInputChange('retries', String(normalizeRetries(e.target.value)))
          }
        />
        <div className="property-hint">
          Extra attempts after a failure or timeout. 0 runs the step once.
        </div>
      </div>

      {normalizeRetries(selectedNode.data.retries) > 0 && (
        <>
          <div className="property-group">
            <label className="property-label">Retry Delay Mode:</label>
            <select
              className="property-input"
              value={normalizeBackoff(selectedNode.data.retryBackoff)}
          data-testid="prop-retry-backoff"
              onChange={(e) => handleInputChange('retryBackoff', e.target.value)}
            >
              <option value="fixed">Fixed</option>
              <option value="exponential">Exponential (doubles each retry)</option>
            </select>
          </div>

          <div className="property-group">
            <label className="property-label">Retry Delay (seconds):</label>
            <input
              type="number"
              min={0}
              max={MAX_RETRY_DELAY_SECS}
              step={1}
              className="property-input"
              value={selectedNode.data.retryDelaySecs ?? DEFAULT_RETRY_DELAY_SECS}
          data-testid="prop-retry-delay"
              onChange={(e) => handleInputChange('retryDelaySecs', e.target.value)}
              onBlur={(e) =>
                handleInputChange('retryDelaySecs', String(normalizeRetryDelay(e.target.value)))
              }
            />
            <div className="property-hint">
              Wait before the first retry; exponential mode doubles it each time.
            </div>
          </div>
        </>
      )}

      <div className="property-group">
        <label className="property-label">Timeout (seconds):</label>
        <input
          type="number"
          min={1}
          step={1}
          className="property-input"
          value={selectedNode.data.timeoutSecs ?? ''}
          data-testid="prop-timeout"
          onChange={(e) => handleInputChange('timeoutSecs', e.target.value)}
          onBlur={(e) =>
            handleInputChange('timeoutSecs', String(normalizeTimeout(e.target.value) ?? ''))
          }
          placeholder="No limit"
        />
        <div className="property-hint">
          Each attempt is killed if it runs longer than this. Leave empty for no limit.
        </div>
      </div>
      <div className="property-group">
        <label className="property-checkbox">
          <input
            type="checkbox"
            checked={isMocked}
            data-testid="prop-mock"
            onChange={(e) => handleInputChange('mock', e.target.checked)}
          />{' '}
          Mock (don't run the tool)
        </label>
        <div className="property-hint">
          Creates the step's outputs instead of running it: empty files, and folders for
          paths ending in /. Use it to try the rest of the workflow without the real tool.
          Non-empty and line-count checks are skipped, and a mocked step never counts as up
          to date, so a real run executes it.
        </div>
      </div>

      <div className="property-group">
        <label className="property-label">Output Checks:</label>
        <label className="property-checkbox">
          <input
            type="checkbox"
            checked={checksOn(selectedNode.data.checkExists)}
          data-testid="prop-check-exists"
            disabled={!hasOutput}
            onChange={(e) => handleInputChange('checkExists', e.target.checked)}
          />{' '}
          Outputs must exist
        </label>
        {checksOn(selectedNode.data.checkExists) && (
          <CheckTargetSelect
            testId="prop-check-exists-target"
            value={selectedNode.data.checkExistsTarget}
            outputs={outputs}
            disabled={!hasOutput}
            onChange={(target) => handleInputChange('checkExistsTarget', target)}
          />
        )}
        <label className="property-checkbox">
          <input
            type="checkbox"
            checked={checksOn(selectedNode.data.checkNonEmpty)}
          data-testid="prop-check-non-empty"
            disabled={!hasOutput}
            onChange={(e) => handleInputChange('checkNonEmpty', e.target.checked)}
          />{' '}
          Outputs must be non-empty
        </label>
        {checksOn(selectedNode.data.checkNonEmpty) && (
          <CheckTargetSelect
            testId="prop-check-non-empty-target"
            value={selectedNode.data.checkNonEmptyTarget}
            outputs={outputs}
            disabled={!hasOutput}
            onChange={(target) => handleInputChange('checkNonEmptyTarget', target)}
          />
        )}
        <label className="property-checkbox">
          <input
            type="checkbox"
            checked={checksOn(selectedNode.data.checkMinLinesEnabled)}
          data-testid="prop-check-min-lines-enabled"
            disabled={!hasOutput}
            onChange={(e) => handleInputChange('checkMinLinesEnabled', e.target.checked)}
          />{' '}
          At least N lines
        </label>
        {checksOn(selectedNode.data.checkMinLinesEnabled) && (
          <input
            type="number"
            min={1}
            step={1}
            className="property-input"
            value={selectedNode.data.checkMinLines ?? ''}
          data-testid="prop-check-min-lines"
            disabled={!hasOutput}
            onChange={(e) => handleInputChange('checkMinLines', e.target.value)}
            onBlur={(e) =>
              handleInputChange('checkMinLines', String(normalizeMinLines(e.target.value) ?? ''))
            }
            placeholder="Minimum lines, e.g. 10"
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
        <label className="property-checkbox">
          <input
            type="checkbox"
            checked={isBlocking(selectedNode.data.checkBlocking)}
          data-testid="prop-check-blocking"
            disabled={!hasOutput}
            onChange={(e) => handleInputChange('checkBlocking', e.target.checked)}
          />{' '}
          Blocking
        </label>
        {isMocked && (
          <div className="property-hint" data-testid="mock-checks-note">
            This step is mocked: non-empty and line-count checks are skipped, "must exist" still runs.
          </div>
        )}
        <div className="property-hint">
          {hasOutput
            ? 'Run after the step succeeds. Each check can cover all outputs or just one. A failed blocking check fails the step and skips everything after it; the tool is not re-run. Unchecked "Blocking" only logs a warning.'
            : 'Set an output file first; checks look at the step\'s outputs.'}
        </div>
      </div>
    </div>
  );
}
