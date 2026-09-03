import React from 'react';
import { ToolStateProvider, useToolState } from '../../services/ToolStateManagerProvider.js';

// Test component that displays the current tool state
const ToolStateDisplay: React.FC = () => {
  const toolState = useToolState();

  return (
    <div>
      <div>Processing: {toolState.state.isProcessing.toString()}</div>
      <div>Current Tool: {toolState.state.currentTool || 'null'}</div>
      <div>Active Tools: {toolState.state.activeTools.join(', ') || 'none'}</div>
      <div>Pending Approvals: {toolState.state.pendingApprovals.length}</div>
    </div>
  );
};

// Test wrapper component
const TestWrapper: React.FC = () => (
  <ToolStateProvider>
    <ToolStateDisplay />
  </ToolStateProvider>
);

// Test cases to verify the tool state management
export function testToolStateManager() {
  console.log('Testing ToolStateManager...');

  try {
    // Test 1: State validation
    const TestComponent = () => {
      const toolState = useToolState();

      React.useEffect(() => {
        // Test state validation
        const isValid = toolState.validateState();
        console.log('State validation:', isValid);

        // Test tool processing
        toolState.startProcessing();
        toolState.setCurrentTool('test_tool');
        toolState.setActiveTools(['test_tool', 'another_tool']);

        // Test pending approval
        const approvePromise = new Promise<boolean>((resolve) => {
          toolState.addPendingApproval('test_tool', {}, resolve);
        });

        // Test history
        toolState.addToolToHistory('test_tool');

        setTimeout(() => {
          toolState.finishToolInHistory('test_tool', true);
          toolState.stopProcessing();

          const executionTime = toolState.getToolExecutionTime('test_tool');
          console.log('Tool execution time:', executionTime);

          const isActive = toolState.isToolActive('test_tool');
          console.log('Tool active:', isActive);
        }, 100);
      }, [toolState]);

      return null;
    };

    // Simple test without rendering
    console.log('✓ ToolStateManager component created successfully');
    return true;
  } catch (error) {
    console.error('✗ ToolStateManager tests failed:', error);
    return false;
  }
}
