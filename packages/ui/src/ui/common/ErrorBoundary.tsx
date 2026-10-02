import React, { Component, ErrorInfo, ReactNode } from "react";
import { Box, Text } from "@dynatrader/ink/terminal";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Error Boundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>
            WARN Application Error
          </Text>
          <Text color="gray">
            {this.state.error?.message || "An unexpected error occurred"}
          </Text>
          <Text color="gray" dimColor>
            Press Ctrl+C to exit and restart
          </Text>
        </Box>
      );
    }

    return this.props.children;
  }
}

