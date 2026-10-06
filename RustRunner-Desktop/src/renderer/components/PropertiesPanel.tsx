import {
  MAX_RETRIES,
  MAX_RETRY_DELAY_SECS,
  DEFAULT_RETRY_DELAY_SECS,
  generatePattern,
  hasWildcards,
  labelToId,
  normalizeBackoff,
  normalizeRetries,
  normalizeRetryDelay,
  normalizeThreads,
  normalizeTimeout,
} from '../workflowConversion';

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

  const handleInputChange = (field: string, value: string) => {
    onNodeUpdate(selectedNode.id, field, value);
  };

  const handleFileSelection = async () => {
    try {
      const files = await window.electron.ipcRenderer.selectFiles();
      if (files && files.length > 0) {
        // Generate pattern automatically
        const pattern = generatePattern(files);
        handleInputChange('input', pattern);
        
        // Store files for this node
        onNodeFilesUpdate(selectedNode.id, files);
        
        // Log success
        addLog(`Selected ${files.length} file(s) for ${selectedNode.data.label}`);
        
        // Auto-suggest output pattern if not set
        if (!selectedNode.data.output || selectedNode.data.output === '') {
          const outputPattern = pattern.replace('{sample}', 'output/{sample}');
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
    <div className="properties-panel">
      <h3>Node Properties</h3>

      <div className="property-group">
        <label className="property-label">Node Name:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.label || ''}
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
          onChange={(e) => handleInputChange('tool', e.target.value)}
          placeholder="e.g., bash, fastqc, bowtie2"
        />
      </div>

      <div className="property-group">
        <label className="property-label">Command:</label>
        <textarea
          className="property-textarea"
          value={selectedNode.data.command || ''}
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
                🔄 Pattern: <code>{generatePattern(nodeFiles)}</code>
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
        <label className="property-label">Input Pattern:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.input || ''}
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
    </div>
  );
}
