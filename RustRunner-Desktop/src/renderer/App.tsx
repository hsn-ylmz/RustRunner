/**
 * RustRunner Workflow Editor
 * 
 * Visual workflow design interface using React Flow.
 * Now with wildcards support for batch file processing.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  NodeToolbar,
  useReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  MiniMap,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './App.css';

// =============================================================================
// Constants
// =============================================================================

const COLOR_OPTIONS = [
  '#a8e6cf', '#88c5f7', '#d4a5f7', '#f5efe9',
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6',
];

const DEFAULT_COLOR = '#88c5f7';

// =============================================================================
// Utility Functions
// =============================================================================

function labelToId(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function convertNodesToWorkflow(nodes: any[], edges: any[]) {
  const nodeIdToStepId = new Map<string, string>();
  nodes.forEach((node: any) => {
    nodeIdToStepId.set(node.id, labelToId(node.data.label));
  });

  const steps = nodes.map((node: any) => {
    const stepId = nodeIdToStepId.get(node.id)!;
    const incoming = edges.filter((e: any) => e.target === node.id);
    const outgoing = edges.filter((e: any) => e.source === node.id);

    return {
      id: stepId,
      tool: node.data.tool || '',
      command: node.data.command || '',
      input: node.data.input ? [node.data.input] : [],
      output: node.data.output ? [node.data.output] : [],
      previous: incoming.map((e: any) => nodeIdToStepId.get(e.source)!),
      next: outgoing.map((e: any) => nodeIdToStepId.get(e.target)!),
      threads: 1,
    };
  });

  return { steps };
}

function validateWorkflow(workflow: any): string[] {
  const errors: string[] = [];

  if (!workflow.steps || workflow.steps.length === 0) {
    errors.push('Workflow has no steps');
    return errors;
  }

  const stepIds = new Set<string>();
  workflow.steps.forEach((step: any) => {
    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);

    if (!step.id || step.id.trim() === '') {
      errors.push('Step has empty ID');
    }
    if (!step.tool || step.tool.trim() === '') {
      errors.push(`Step ${step.id}: missing tool`);
    }
    if (!step.command || step.command.trim() === '') {
      errors.push(`Step ${step.id}: missing command`);
    }
  });

  return errors;
}

// =============================================================================
// Wildcard Helper Functions
// =============================================================================

/**
 * Generates a wildcard pattern from a list of files.
 * Example: ["sample1.fastq", "sample2.fastq"] -> "{sample}.fastq"
 */
function generatePattern(files: string[]): string {
  if (files.length === 0) return '';
  
  const firstFile = files[0];
  const fileName = firstFile.split('/').pop() || firstFile;
  const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
  const dir = firstFile.substring(0, firstFile.lastIndexOf('/') + 1);
  
  return `${dir}{sample}${ext}`;
}

/**
 * Extracts wildcard values from file list (removes extensions).
 * Example: ["sample1.fastq", "sample2.fastq"] -> ["sample1", "sample2"]
 */
function extractWildcardValues(files: string[]): string[] {
  return files.map(file => {
    const fileName = file.split('/').pop() || file;
    return fileName.replace(/\.[^.]+$/, ''); // Remove extension
  });
}

/**
 * Checks if a string contains wildcard syntax.
 */
function hasWildcards(text: string): boolean {
  return text.includes('{') && text.includes('}');
}

// =============================================================================
// Custom Node Component
// =============================================================================

function CustomNode({ id, data, selected }: any) {
  const { updateNodeData } = useReactFlow();

  const handleColorChange = (newColor: string) => {
    updateNodeData(id, { color: newColor });
  };

  const nodeColor = data.color || DEFAULT_COLOR;

  return (
    <>
      <NodeToolbar isVisible={selected} className="nopan">
        <div className="color-picker-toolbar">
          {COLOR_OPTIONS.map((colorOption) => (
            <button
              key={colorOption}
              onClick={() => handleColorChange(colorOption)}
              className={`color-button ${colorOption === nodeColor ? 'selected' : ''}`}
              style={{ backgroundColor: colorOption }}
              title={`Change color to ${colorOption}`}
            />
          ))}
        </div>
      </NodeToolbar>

      <div
        className={`custom-node ${selected ? 'selected' : ''}`}
        style={{ background: nodeColor }}
      >
        <Handle type="target" position={Position.Top} />
        <div className="node-label">{data.label || 'New Node'}</div>
        <div className="node-tool">{data.tool || 'No tool'}</div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    </>
  );
}

// =============================================================================
// Properties Panel Component
// =============================================================================

function PropertiesPanel({ 
  selectedNode, 
  onNodeUpdate,
  nodeFiles,
  onNodeFilesUpdate,
  addLog
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
        {selectedNode.data.label && (
          <div className="property-hint">
            Step ID: {labelToId(selectedNode.data.label)}
          </div>
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
    </div>
  );
}

// =============================================================================
// Node Types
// =============================================================================

const nodeTypes = { custom: CustomNode };
const defaultEdgeOptions = { animated: true };

// =============================================================================
// Main Editor Component
// =============================================================================

function WorkflowEditorInner() {
  const [nodes, setNodes] = useState<any[]>([]);
  const [edges, setEdges] = useState<any[]>([]);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [workflowName, setWorkflowName] = useState('Untitled Workflow');
  const [executionState, setExecutionState] = useState<'idle' | 'running' | 'paused'>('idle');
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [tempWorkflowName, setTempWorkflowName] = useState('');
  const [executionLogs, setExecutionLogs] = useState<string[]>([]);
  const [showExecutionPanel, setShowExecutionPanel] = useState(true);
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [nodeWildcardFiles, setNodeWildcardFiles] = useState<Record<string, string[]>>({}); // NEW: Wildcard files per node
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Suppress ResizeObserver errors
  useEffect(() => {
    const handleError = (event: any) => {
      if (event.message?.includes('ResizeObserver loop completed')) {
        event.stopImmediatePropagation();
        return false;
      }
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setExecutionLogs((prev) => [...prev, `[${timestamp}] ${message}`]);
  }, []);

  // Setup IPC listeners
  useEffect(() => {
    window.electron.ipcRenderer.onWorkflowOutput((output: string) => {
      addLog(output);
    });

    window.electron.ipcRenderer.onWorkflowComplete((success: boolean, message: string) => {
      setExecutionState('idle');
      addLog(success ? 'Workflow completed successfully!' : `Workflow failed: ${message}`);
    });

    window.electron.ipcRenderer.onWorkflowError((error: string) => {
      setExecutionState('idle');
      addLog(`Execution error: ${error}`);
    });

    addLog('Ready to execute workflows');
  }, [addLog]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [executionLogs]);

  // Callbacks
  const onSelectionChange = useCallback(({ nodes: selectedNodes }: any) => {
    setSelectedNode(selectedNodes?.length > 0 ? selectedNodes[0] : null);
  }, []);

  const onNodesChange = useCallback((changes: any) => {
    setNodes((nds) => applyNodeChanges(changes, nds) as any[]);
  }, []);

  const onEdgesChange = useCallback((changes: any) => {
    setEdges((eds) => applyEdgeChanges(changes, eds) as any[]);
  }, []);

  const onConnect = useCallback((params: any) => {
    setEdges((eds) => addEdge(params, eds) as any[]);
  }, []);

  const onNodeUpdate = useCallback(
    (nodeId: string, field: string, value: string) => {
      setNodes((nds) =>
        nds.map((node: any) => {
          if (node.id === nodeId) {
            const updatedNode = {
              ...node,
              data: { ...node.data, [field]: value },
            };
            if (selectedNode?.id === nodeId) {
              setSelectedNode(updatedNode);
            }
            return updatedNode;
          }
          return node;
        })
      );
    },
    [selectedNode]
  );

  // NEW: Handler for wildcard files
  const handleNodeFilesUpdate = useCallback((nodeId: string, files: string[]) => {
    setNodeWildcardFiles(prev => ({
      ...prev,
      [nodeId]: files
    }));
  }, []);

  const addNode = useCallback(() => {
    const newNode = {
      id: `node_${Date.now()}`,
      position: { x: Math.random() * 400, y: Math.random() * 300 },
      data: {
        label: `Node ${nodes.length + 1}`,
        tool: '',
        command: '',
        input: '',
        output: '',
        color: DEFAULT_COLOR,
      },
      type: 'custom',
    };
    setNodes((nds) => [...nds, newNode]);
  }, [nodes.length]);

  const deleteSelectedNodes = useCallback(() => {
    const selectedIds = nodes.filter((n: any) => n.selected).map((n: any) => n.id);
    setNodes((nds) => nds.filter((node: any) => !node.selected));
    setEdges((eds) =>
      eds.filter((edge: any) => !selectedIds.includes(edge.source) && !selectedIds.includes(edge.target))
    );
    
    // Clean up wildcard files for deleted nodes
    setNodeWildcardFiles(prev => {
      const updated = { ...prev };
      selectedIds.forEach(id => delete updated[id]);
      return updated;
    });
    
    setSelectedNode(null);
  }, [nodes]);

  // File operations
  const handleNew = useCallback(() => {
    setTempWorkflowName('My Workflow');
    setShowNameDialog(true);
  }, []);

  const handleConfirmNew = useCallback(() => {
    if (!tempWorkflowName.trim()) return;
    setWorkflowName(tempWorkflowName);
    setShowNameDialog(false);
    addLog(`New workflow created: ${tempWorkflowName}`);

    const templateNodes = [
      {
        id: 'node_1',
        position: { x: 250, y: 100 },
        data: { label: 'Start', tool: '', command: '', input: '', output: '', color: '#a8e6cf' },
        type: 'custom',
      },
      {
        id: 'node_2',
        position: { x: 250, y: 250 },
        data: { label: 'Process', tool: '', command: '', input: '', output: '', color: DEFAULT_COLOR },
        type: 'custom',
      },
    ];

    setNodes(templateNodes);
    setEdges([]);
    setSelectedNode(null);
    setExecutionState('idle');
    setNodeWildcardFiles({});
  }, [tempWorkflowName, addLog]);

  const handleOpen = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = (e: any) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const content = event.target?.result as string;
          const data = JSON.parse(content);

          if (!data.nodes || !data.edges) {
            addLog('Invalid workflow file format');
            return;
          }

          setNodes(data.nodes);
          setEdges(data.edges);
          setSelectedNode(null);
          if (data.metadata?.name) setWorkflowName(data.metadata.name);
          if (data.wildcardFiles) setNodeWildcardFiles(data.wildcardFiles);
          addLog(`Workflow opened: ${data.nodes.length} nodes, ${data.edges.length} edges`);
        } catch (error) {
          addLog(`Failed to open workflow: ${error}`);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [addLog]);

  const handleSave = useCallback(() => {
    try {
      const exportData = {
        nodes,
        edges,
        wildcardFiles: nodeWildcardFiles,
        metadata: { name: workflowName, version: '1.1.0', createdAt: new Date().toISOString() },
      };

      const jsonString = JSON.stringify(exportData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      const safeName = workflowName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      link.download = `${safeName}_${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      addLog(`Workflow saved: ${link.download}`);
    } catch (error) {
      addLog(`Failed to save workflow: ${error}`);
    }
  }, [nodes, edges, nodeWildcardFiles, workflowName, addLog]);

  const handleClear = useCallback(() => {
    if (confirm('Clear all nodes and edges? This cannot be undone.')) {
      setNodes([]);
      setEdges([]);
      setSelectedNode(null);
      setExecutionState('idle');
      setNodeWildcardFiles({});
      addLog('Canvas cleared');
    }
  }, [addLog]);

  const handleSelectDirectory = useCallback(async () => {
    const directory = await window.electron.ipcRenderer.selectDirectory();
    if (directory) {
      setWorkingDirectory(directory);
      addLog(`Working directory set: ${directory}`);
    }
  }, [addLog]);

  // NEW: Prepare wildcard files for execution
  const prepareWildcardFiles = useCallback(() => {
    const wildcards: Record<string, string[]> = {};
    
    // Collect all files from all nodes
    Object.entries(nodeWildcardFiles).forEach(([nodeId, files]) => {
      if (files.length > 0) {
        // For v1, we use 'sample' as the wildcard name
        // If multiple nodes have wildcards, merge their files
        if (!wildcards['sample']) {
          wildcards['sample'] = [];
        }
        wildcards['sample'] = [...new Set([...wildcards['sample'], ...files])];
      }
    });
    
    return Object.keys(wildcards).length > 0 ? wildcards : undefined;
  }, [nodeWildcardFiles]);

  // Execution
  const handleRun = useCallback(async () => {
    if (executionState === 'paused') {
      setExecutionState('running');
      window.electron.ipcRenderer.resumeWorkflow();
      return;
    }

    let dir = workingDirectory;
    if (!dir) {
      addLog('Select working directory for workflow files...');
      dir = (await window.electron.ipcRenderer.selectDirectory()) || '';
      if (!dir) {
        addLog('Execution cancelled - no directory selected');
        return;
      }
      setWorkingDirectory(dir);
      addLog(`Working directory set: ${dir}`);
    }

    const workflowData = convertNodesToWorkflow(nodes, edges);
    const wildcards = prepareWildcardFiles();
    
    // Add wildcard files if present
    const workflow = wildcards ? {
      ...workflowData,
      wildcardFiles: wildcards
    } : workflowData;

    const errors = validateWorkflow(workflow);

    if (errors.length > 0) {
      addLog('Workflow validation failed:');
      errors.forEach((err) => addLog(`  - ${err}`));
      return;
    }

    // Log wildcard expansion info
    if (wildcards && wildcards.sample) {
      addLog(`🔄 Wildcards detected - will expand to ${wildcards.sample.length} file(s)`);
    }

    setExecutionState('running');
    window.electron.ipcRenderer.runWorkflow(workflow, false, dir);
  }, [nodes, edges, executionState, workingDirectory, nodeWildcardFiles, prepareWildcardFiles, addLog]);

  const handleDryRun = useCallback(async () => {
    let dir = workingDirectory;
    if (!dir) {
      addLog('Select working directory for dry run...');
      dir = (await window.electron.ipcRenderer.selectDirectory()) || '';
      if (!dir) {
        addLog('Dry run cancelled - no directory selected');
        return;
      }
      setWorkingDirectory(dir);
      addLog(`Working directory set: ${dir}`);
    }

    const workflowData = convertNodesToWorkflow(nodes, edges);
    const wildcards = prepareWildcardFiles();
    
    const workflow = wildcards ? {
      ...workflowData,
      wildcardFiles: wildcards
    } : workflowData;

    const errors = validateWorkflow(workflow);

    if (errors.length > 0) {
      addLog('Workflow validation failed:');
      errors.forEach((err) => addLog(`  - ${err}`));
      return;
    }

    if (wildcards && wildcards.sample) {
      addLog(`🔄 Dry run with wildcards - will show ${wildcards.sample.length} expanded step(s)`);
    }

    addLog('Starting dry run (commands will not execute)...');
    window.electron.ipcRenderer.runWorkflow(workflow, true, dir);
  }, [nodes, edges, workingDirectory, nodeWildcardFiles, prepareWildcardFiles, addLog]);

  const handlePause = useCallback(() => {
    if (executionState === 'running') {
      setExecutionState('paused');
      window.electron.ipcRenderer.pauseWorkflow();
    }
  }, [executionState]);

  const handleClearLogs = useCallback(() => {
    setExecutionLogs([]);
    const timestamp = new Date().toLocaleTimeString();
    setExecutionLogs([`[${timestamp}] Logs cleared`]);
  }, []);

  const handleTogglePanel = useCallback(() => {
    setShowExecutionPanel((prev) => !prev);
  }, []);

  return (
    <div className="workflow-editor">
      <div className="main-content">
        <div className="flow-container">
          {/* Top Toolbar */}
          <div className="top-toolbar">
            <div className="workflow-info">
              <div className="workflow-title">{workflowName}</div>
              {workingDirectory && (
                <div className="working-directory">
                  {workingDirectory.replace(/^.*[\\\/]/, '')}
                </div>
              )}
            </div>

            <div className="file-buttons">
              <button className="toolbar-button" onClick={handleNew}>New</button>
              <button className="toolbar-button" onClick={handleOpen}>Open</button>
              <button className="toolbar-button" onClick={handleSave}>Save</button>
              <button className="toolbar-button" onClick={handleClear}>Clear</button>
              <button className="toolbar-button" onClick={handleSelectDirectory}>
                Set Directory
              </button>
            </div>

            <div className="edit-buttons">
              <button className="toolbar-button add-button" onClick={addNode}>+ Add Node</button>
              <button className="toolbar-button delete-button" onClick={deleteSelectedNodes}>Delete</button>
            </div>
          </div>

          {/* Execution Controls */}
          <div className="execution-controls">
            <button
              className={`execution-button run-button ${executionState === 'running' ? 'active' : ''}`}
              onClick={handleRun}
              disabled={nodes.length === 0}
            >
              {executionState === 'paused' ? 'Resume' : 'Run'}
            </button>

            <button
              className="execution-button dry-run-button"
              onClick={handleDryRun}
              disabled={nodes.length === 0 || executionState !== 'idle'}
            >
              Dry Run
            </button>

            <button
              className={`execution-button pause-button ${executionState === 'paused' ? 'active' : ''}`}
              onClick={handlePause}
              disabled={executionState !== 'running'}
            >
              Pause
            </button>
          </div>

          <ReactFlow
            nodes={nodes}
            edges={edges}
            defaultEdgeOptions={defaultEdgeOptions}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            nodeTypes={nodeTypes}
            fitView
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={30}
              color="var(--canvas-grid)"
            />
            <Controls />
            <MiniMap
              nodeStrokeWidth={1}
              nodeColor={(node: any) => node.data?.color || '#aaa'}
            />
          </ReactFlow>
        </div>

        {selectedNode && (
          <PropertiesPanel 
            selectedNode={selectedNode} 
            onNodeUpdate={onNodeUpdate}
            nodeFiles={nodeWildcardFiles[selectedNode.id] || []}
            onNodeFilesUpdate={handleNodeFilesUpdate}
            addLog={addLog}
          />
        )}
      </div>

      {/* Execution Logs Panel */}
      <div className={`execution-panel ${showExecutionPanel ? 'visible' : 'hidden'}`}>
        <div className="execution-panel-header">
          <h3>Execution Logs</h3>
          <div className="execution-panel-controls">
            <button className="panel-button" onClick={handleClearLogs}>Clear</button>
            <button className="panel-button" onClick={handleTogglePanel}>
              {showExecutionPanel ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {showExecutionPanel && (
          <div className="execution-panel-content">
            {executionLogs.map((log, index) => (
              <div
                key={index}
                className={`log-entry ${
                  log.includes('error') || log.includes('failed') ? 'error' :
                  log.includes('completed') || log.includes('successfully') ? 'success' :
                  log.includes('paused') ? 'warning' :
                  log.includes('resumed') || log.includes('dry run') || log.includes('Wildcards') ? 'info' : ''
                }`}
              >
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>

      {/* Name Dialog */}
      {showNameDialog && (
        <div className="dialog-overlay" onClick={() => setShowNameDialog(false)}>
          <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
            <h3>New Workflow</h3>
            <label>
              Workflow Name:
              <input
                type="text"
                className="dialog-input"
                value={tempWorkflowName}
                onChange={(e) => setTempWorkflowName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleConfirmNew()}
                autoFocus
              />
            </label>
            <p className="dialog-hint">
              You will choose a working directory when you click Run.
            </p>
            <div className="dialog-buttons">
              <button className="dialog-button cancel" onClick={() => setShowNameDialog(false)}>
                Cancel
              </button>
              <button className="dialog-button confirm" onClick={handleConfirmNew}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// App with Provider
// =============================================================================

export default function App() {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner />
    </ReactFlowProvider>
  );
}
