import React from "react";
import { Box, Text } from "ink";

interface ScrollbarMetrics {
  show: boolean;
  thumbHeight: number;
  thumbTop: number;
  trackHeight: number;
}

interface ScrollbarProps {
  metrics: ScrollbarMetrics;
  onOffsetChange: (newOffset: number) => void;
}

export function Scrollbar({ metrics, onOffsetChange }: ScrollbarProps) {
  const { show, thumbHeight, thumbTop, trackHeight } = metrics;

  if (!show) {
    return null;
  }

  const trackContent: React.ReactNode[] = [];
  for (let row = 0; row < trackHeight; row += 1) {
    if (row >= thumbTop && row < thumbTop + thumbHeight) {
      trackContent.push(
        <Text key={row} color="white">
          {"█"}
        </Text>,
      );
    } else {
      trackContent.push(<Text key={row}> </Text>);
    }
  }

  return (
    <Box flexDirection="column" width={1}>
      {trackContent}
    </Box>
  );
}
