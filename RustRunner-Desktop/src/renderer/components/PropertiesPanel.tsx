import {
  MAX_RETRIES,
  MAX_RETRY_DELAY_SECS,
  DEFAULT_RETRY_DELAY_SECS,
  generatePattern,
  hasWildcards,
  labelToId,
  isBlocking,
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

/** Checkbox state may be a boolean or, from loose data, the string 'true'. */
const checksOn = (value: unknown) => value === true || value === 'true';

export function PropertiesPanel({
  selectedNode,
  onNodeUpdate,
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
  /** The name used inside {braces} for this node's batch files. */
  const wildcardName = normalizeWildcardName(selectedNode.data.wildcardName);
  const wildcardNameProblem = wildcardNameError(selectedNode.data.wildcardName);

  const handleInputChange = (field: string, value: string | boolean) => {
    onNodeUpdate(selectedNode.id, field, value);
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
          onChange={(e) => handleInputChange('tool', e.target.value)}
          placeholder="e.g., bash, fastqc, bowtie2"
        />
      </div>

      <div className="property-group">
        <label className="property-label">Command:</label>
        <textarea
          className="property-textarea"
          value={selectedNode.data.command || ''}
          data-testid="prop-command"
          onChange={(e) => handleInputChange('command', e.target.value)}
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
          onChange={(e) => handleInputChange('threads', e.target.value)}
          onBlur={(e) =>
            handleInputChange('threads', String(normalizeThreads(e.target.value)))
          }
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
        <div className="property-hint">
          {hasOutput
            ? 'Run after the step succeeds. A failed blocking check fails the step and skips everything after it; the tool is not re-run. Unchecked "Blocking" only logs a warning.'
            : 'Set an output file first; checks look at the step\'s outputs.'}
        </div>
      </div>
    </div>
  );
}
