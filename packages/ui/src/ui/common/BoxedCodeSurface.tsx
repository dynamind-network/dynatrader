import React from "react";
import { Box, Text } from "@dynatrader/ink/terminal";

interface CodeLine {
  text: string;
  color?: string;
  dimColor?: boolean;
}

interface BoxedCodeSurfaceProps {
  title: string;
  path?: string;
  lines: CodeLine[];
  maxWidth?: number;
}

export function BoxedCodeSurface({
  title,
  path,
  lines,
  maxWidth,
}: BoxedCodeSurfaceProps) {
  const width = maxWidth ? Math.max(24, maxWidth) : undefined;

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      width={width}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">
          {title}
        </Text>
        {path ? (
          <Text dimColor color="gray">
            {path}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Text
            key={`${line.text}-${index}`}
            color={line.color}
            dimColor={line.dimColor}
            wrap="wrap"
          >
            {line.text}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

