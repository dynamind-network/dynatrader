import React from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';

interface HelpScreenProps {
  onBack: () => void;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text color="gray" bold>
      {children}
    </Text>
  );
}

function Row({ left, right, leftWidth = 14 }: { left: string; right: string; leftWidth?: number }) {
  return (
    <Box>
      <Box width={leftWidth}>
        <Text color="cyan">{left}</Text>
      </Box>
      <Text dimColor>{right}</Text>
    </Box>
  );
}

export function HelpScreen({ onBack }: HelpScreenProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="cyan" bold>
          Help
        </Text>
        <Text dimColor>F1 · Esc to return</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <SectionTitle>Screen navigation</SectionTitle>
        <Text dimColor>Use these shortcuts from chat mode to move around the terminal.</Text>
        <Box flexDirection="column" marginTop={1}>
          <Row left="H" right="Help" />
          <Row left="M" right="Markets" />
          <Row left="P" right="Portfolio" />
          <Row left="G" right="Graph" />
          <Row left="T" right="Trades" />
          <Row left="A" right="Alerts" />
          <Row left="Y" right="Analysis" />
          <Row left="N" right="News" />
          <Row left="W" right="Watchlist" />
          <Row left="S" right="Search" />
          <Row left="O" right="Models" />
          <Row left="R" right="Chat" />
          <Row left="D" right="Depth" />
          <Row left="Esc" right="Return to chat" />
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <SectionTitle>Slash commands</SectionTitle>
        <Box flexDirection="column" marginTop={1}>
          <Row left="/help" right="Show this help" leftWidth={18} />
          <Row left="/clear" right="Clear chat history" leftWidth={18} />
          <Row left="/compact" right="Summarize and compact the session" leftWidth={18} />
          <Row left="/resume" right="List or resume saved sessions" leftWidth={18} />
          <Row left="/agents" right="List configured agents" leftWidth={18} />
          <Row left="/agents create" right="Create a markdown workspace agent" leftWidth={18} />
          <Row left="/plan <goal>" right="Generate a read-only plan for review" leftWidth={22} />
          <Row left="/plugins" right="List built-in plugins" leftWidth={18} />
          <Row left="/tools" right="List available tools" leftWidth={18} />
          <Row left="/mcp" right="Show connected MCP servers" leftWidth={18} />
          <Row left="/model" right="Show current AI model" leftWidth={18} />
          <Row left="/exit" right="Exit DynaMind Terminal" leftWidth={18} />
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <SectionTitle>Agents and tools</SectionTitle>
        <Box flexDirection="column" marginTop={1}>
          <Row left="@name" right="Use a configured workspace agent" leftWidth={14} />
          <Text dimColor>
            workspace agents are markdown files. Create them with /agents create.
          </Text>
          <Row left="read" right="Read files or directories" leftWidth={14} />
          <Row left="write" right="Write files" leftWidth={14} />
          <Row left="edit" right="Edit by replacement" leftWidth={14} />
          <Row left="question" right="Ask a multiple-choice question" leftWidth={14} />
          <Row left="shell" right="Execute shell commands" leftWidth={14} />
          <Row left="glob/grep" right="Search files and content" leftWidth={14} />
          <Row left="runtime" right="Backend runtime tools" leftWidth={14} />
          <Row left="MCP" right="Configured MCP servers" leftWidth={14} />
        </Box>
      </Box>

      <Box flexDirection="column">
        <SectionTitle>Keyboard shortcuts</SectionTitle>
        <Box flexDirection="column" marginTop={1}>
          <Row left="Ctrl+C" right="Stop current operation or exit" leftWidth={14} />
          <Row left="Ctrl+K" right="Open command palette" leftWidth={14} />
          <Row left="Mouse drag" right="Select and copy terminal text" leftWidth={14} />
          <Row left="Enter" right="Submit message" leftWidth={14} />
          <Row left="Y/N" right="Approve or deny tool execution" leftWidth={14} />
          <Row left="Esc" right="Return to chat from any screen" leftWidth={14} />
        </Box>
      </Box>
    </Box>
  );
}

export default HelpScreen;

