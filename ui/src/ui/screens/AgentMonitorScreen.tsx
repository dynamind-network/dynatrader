import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import {
  useTerminalSize,
  createSeparator,
  getScreenBreakpoints,
} from '../ResponsiveLayout.js';

interface Agent {
  id: string;
  name: string;
  task: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  tokensUsed?: number;
}

interface Goal {
  id: string;
  objective: string;
  status: string;
  progress: { stepsCompleted: number; totalSteps: number; percentComplete: number };
  tokensUsed: number;
  tokenBudget?: number;
}

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt: number;
  runCount: number;
}

interface TaskQueueStats {
  totalTasks: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

interface AgentMonitorProps {
  onBack: () => void;
}

export function AgentMonitorScreen({ onBack }: AgentMonitorProps) {
  const { width } = useTerminalSize();
  const breakpoints = getScreenBreakpoints(width);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [goal, setGoal] = useState<Goal | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [taskStats, setTaskStats] = useState<TaskQueueStats | null>(null);
  const [selectedTab, setSelectedTab] = useState<'agents' | 'goals' | 'cron' | 'tasks'>('agents');
  const [lastUpdate, setLastUpdate] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => {
      setLastUpdate(new Date());
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const tabs = ['agents', 'goals', 'cron', 'tasks'] as const;

  function getStatusColor(status: string): string {
    switch (status) {
      case 'running': return 'cyan';
      case 'completed': return 'green';
      case 'failed': return 'red';
      case 'cancelled': return 'yellow';
      case 'active': return 'green';
      case 'paused': return 'yellow';
      case 'budget_limited': return 'red';
      default: return 'white';
    }
  }

  function formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function renderProgressBar(progress: number, width: number = 20): string {
    const filled = Math.floor((progress / 100) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  function renderAgents() {
    if (agents.length === 0) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text dimColor>No active agents. Use @agent to spawn one.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>ACTIVE AGENTS ({agents.filter(a => a.status === 'running').length} running)</Text>
        <Box marginTop={1}>
          <Text>{createSeparator(width - 2)}</Text>
        </Box>
        {agents.map((agent) => {
          const elapsed = (agent.completedAt || Date.now()) - agent.startedAt;
          return (
            <Box key={agent.id} flexDirection="column" marginTop={1}>
              <Box>
                <Text color={getStatusColor(agent.status)} bold>[{agent.status.toUpperCase().padEnd(9)}]</Text>
                <Text> @{agent.name} </Text>
                <Text dimColor>({agent.id})</Text>
              </Box>
              <Box marginLeft={2}>
                <Text dimColor>Task: </Text>
                <Text>{agent.task.slice(0, width - 30)}</Text>
              </Box>
              <Box marginLeft={2}>
                <Text dimColor>Progress: </Text>
                <Text color={getStatusColor(agent.status)}>
                  {renderProgressBar(agent.progress)} {agent.progress}%
                </Text>
                <Text dimColor> | {formatElapsed(elapsed)}</Text>
              </Box>
              {agent.tokensUsed && (
                <Box marginLeft={2}>
                  <Text dimColor>Tokens: </Text>
                  <Text>{agent.tokensUsed.toLocaleString()}</Text>
                </Box>
              )}
              {agent.error && (
                <Box marginLeft={2}>
                  <Text color="red">Error: {agent.error}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    );
  }

  function renderGoals() {
    if (!goal) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text dimColor>No active goal. Use /goal set to create one.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>ACTIVE GOAL</Text>
        <Box marginTop={1}>
          <Text>{createSeparator(width - 2)}</Text>
        </Box>
        <Box marginTop={1}>
          <Text bold>{goal.objective}</Text>
        </Box>
        <Box>
          <Text dimColor>Status: </Text>
          <Text color={getStatusColor(goal.status)} bold>{goal.status.toUpperCase()}</Text>
        </Box>
        <Box>
          <Text dimColor>Progress: </Text>
          <Text>{goal.progress.stepsCompleted}/{goal.progress.totalSteps} steps ({goal.progress.percentComplete}%)</Text>
        </Box>
        <Box>
          <Text dimColor>Tokens: </Text>
          <Text>{goal.tokensUsed.toLocaleString()}</Text>
          {goal.tokenBudget && (
            <Text dimColor> / {goal.tokenBudget.toLocaleString()} ({Math.round((goal.tokensUsed / goal.tokenBudget) * 100)}%)</Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text>{renderProgressBar(goal.progress.percentComplete, 40)}</Text>
        </Box>
      </Box>
    );
  }

  function renderCron() {
    if (cronJobs.length === 0) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text dimColor>No cron jobs configured.</Text>
        </Box>
      );
    }

    return (
        <Box flexDirection="column" padding={1}>
          <Text color="cyan" bold>CRON JOBS ({cronJobs.filter(j => j.enabled).length} enabled)</Text>
          <Box marginTop={1}>
            <Text>{createSeparator(width - 2)}</Text>
          </Box>
          {cronJobs.map((job) => (
            <Box key={job.id} flexDirection="column" marginTop={1}>
              <Box>
                <Text color={job.enabled ? 'green' : 'yellow'} bold>{job.enabled ? '●' : '○'}</Text>
                <Text> {job.name} </Text>
                <Text dimColor>({job.schedule})</Text>
              </Box>
              <Box marginLeft={2}>
                <Text dimColor>Runs: </Text>
                <Text>{job.runCount}</Text>
                {job.lastRunAt && (
                  <Text dimColor> | Last: {new Date(job.lastRunAt).toLocaleTimeString()}</Text>
                )}
                <Text dimColor> | Next: {new Date(job.nextRunAt).toLocaleTimeString()}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      );
  }

  function renderTasks() {
    if (!taskStats) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text dimColor>No task queue data available.</Text>
        </Box>
      );
    }

    return (
        <Box flexDirection="column" padding={1}>
          <Text color="cyan" bold>TASK QUEUE</Text>
          <Box marginTop={1}>
            <Text>{createSeparator(width - 2)}</Text>
          </Box>
          <Box marginTop={1}>
            <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
              <Text bold>TOTAL: {taskStats.totalTasks}</Text>
              <Text color="cyan">  QUEUED: {taskStats.queued}</Text>
              <Text color="yellow">  RUNNING: {taskStats.running}</Text>
              <Text color="green">  COMPLETED: {taskStats.completed}</Text>
              <Text color="red">  FAILED: {taskStats.failed}</Text>
            </Box>
          </Box>
        </Box>
      );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>AGENT MONITOR [F14]</Text>
        <Box marginTop={1}>
          {tabs.map((tab) => (
            <Box key={tab} marginRight={2}>
              <Text
                color={selectedTab === tab ? 'cyan' : 'white'}
                bold={selectedTab === tab}
                underline={selectedTab === tab}
              >
                {tab.toUpperCase()}
              </Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text>{createSeparator(width - 2)}</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        {selectedTab === 'agents' && renderAgents()}
        {selectedTab === 'goals' && renderGoals()}
        {selectedTab === 'cron' && renderCron()}
        {selectedTab === 'tasks' && renderTasks()}
      </Box>

      <Box flexDirection="column" padding={1}>
        <Text>{createSeparator(width - 2)}</Text>
        <Box>
          <Text dimColor>Last update: {lastUpdate.toLocaleTimeString()}</Text>
          <Text dimColor> | Press </Text>
          <Text color="yellow">1-4</Text>
          <Text dimColor> to switch tabs, </Text>
          <Text color="yellow">Esc</Text>
          <Text dimColor> to return</Text>
        </Box>
      </Box>
    </Box>
  );
}

export default AgentMonitorScreen;
