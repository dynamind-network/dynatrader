import React from "react";
import { Box, Text } from "@dynatrader/ink/terminal";

export interface PositionData {
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  leverage: number;
  liquidationPrice?: number;
  notionalValue?: number;
  marginUsed?: number;
  unrealizedFunding?: number;
}

interface PositionCardProps {
  position: PositionData;
  compact?: boolean;
  showActions?: boolean;
}

export function PositionCard({
  position,
  compact = false,
  showActions = false,
}: PositionCardProps) {
  const pnlColor = position.pnl >= 0 ? "green" : "red";
  const sideColor = position.side === "long" ? "green" : "red";
  const leverageColor =
    position.leverage > 10 ? "red" : position.leverage > 5 ? "yellow" : "gray";

  if (compact) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="blue"
        paddingX={1}
      >
        <Box>
          <Text bold color="white">
            {position.symbol}
          </Text>
          <Text color="gray"> </Text>
          <Text color={sideColor}>{position.side.toUpperCase()}</Text>
          <Text color="gray"> </Text>
          <Text color={leverageColor}>{position.leverage}x</Text>
        </Box>
        <Box>
          <Text color={pnlColor}>
            ${position.pnl.toFixed(2)} ({position.pnlPercent.toFixed(2)}%)
          </Text>
        </Box>
      </Box>
    );
  }

  const marginRatio =
    position.notionalValue && position.marginUsed
      ? (position.notionalValue / position.marginUsed).toFixed(1)
      : null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text bold color="white">
          {position.symbol}
        </Text>
        <Text color="gray"> </Text>
        <Text color={sideColor} bold>
          {position.side.toUpperCase()}
        </Text>
        <Text color="gray"> </Text>
        <Text color={leverageColor}>{position.leverage}x</Text>
        {position.liquidationPrice && (
          <>
            <Text color="gray"> | Liq: </Text>
            <Text color="red">${position.liquidationPrice.toFixed(0)}</Text>
          </>
        )}
      </Box>

      <Box>
        <Text color="gray">Size: </Text>
        <Text>{position.size.toFixed(4)}</Text>
        {position.notionalValue && (
          <>
            <Text color="gray"> (</Text>
            <Text>${position.notionalValue.toFixed(2)}</Text>
            <Text color="gray">)</Text>
          </>
        )}
      </Box>

      <Box>
        <Text color="gray">Entry: </Text>
        <Text>${position.entryPrice.toFixed(2)}</Text>
        <Text color="gray"> | Mark: </Text>
        <Text>${position.currentPrice.toFixed(2)}</Text>
      </Box>

      <Box>
        <Text color="gray">PnL: </Text>
        <Text color={pnlColor} bold>
          ${position.pnl.toFixed(2)} ({position.pnlPercent.toFixed(2)}%)
        </Text>
        {position.unrealizedFunding !== undefined &&
          position.unrealizedFunding !== 0 && (
            <>
              <Text color="gray"> | Funding: </Text>
              <Text color={position.unrealizedFunding >= 0 ? "green" : "red"}>
                ${position.unrealizedFunding.toFixed(2)}
              </Text>
            </>
          )}
      </Box>

      {marginRatio && (
        <Box>
          <Text color="gray">Margin: </Text>
          <Text>${position.marginUsed?.toFixed(2)}</Text>
          <Text color="gray"> (</Text>
          <Text>{marginRatio}x</Text>
          <Text color="gray">)</Text>
        </Box>
      )}

      {showActions && (
        <Box marginTop={1}>
          <Text dimColor>[Close] [Add] [Reduce]</Text>
        </Box>
      )}
    </Box>
  );
}

