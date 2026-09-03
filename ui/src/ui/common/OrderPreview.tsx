import React from "react";
import { Box, Text } from "ink";

export interface OrderData {
  symbol: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  size: number;
  price?: number;
  totalValue: number;
  fees: number;
  slippage?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  timeInForce?: "GTC" | "IOC" | "FOK";
}

interface OrderPreviewProps {
  order: OrderData;
  showConfirmation?: boolean;
}

export function OrderPreview({
  order,
  showConfirmation = false,
}: OrderPreviewProps) {
  const sideColor = order.side === "buy" ? "green" : "red";
  const typeColor = order.orderType === "market" ? "yellow" : "cyan";
  const totalColor = order.side === "buy" ? "red" : "green";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={sideColor}
      paddingX={1}
    >
      <Box>
        <Text bold color="white">
          {order.symbol}
        </Text>
      </Box>

      <Box>
        <Text color={sideColor} bold>
          {order.side.toUpperCase()}
        </Text>
        <Text color="gray"> </Text>
        <Text color={typeColor}>{order.orderType.toUpperCase()}</Text>
        {order.reduceOnly && (
          <>
            <Text color="gray"> </Text>
            <Text color="yellow">REDUCE</Text>
          </>
        )}
        {order.postOnly && (
          <>
            <Text color="gray"> </Text>
            <Text color="cyan">POST</Text>
          </>
        )}
      </Box>

      <Box>
        <Text color="gray">Size: </Text>
        <Text>{order.size.toFixed(4)}</Text>
      </Box>

      {order.orderType === "limit" && order.price !== undefined && (
        <Box>
          <Text color="gray">Price: </Text>
          <Text>${order.price.toFixed(2)}</Text>
        </Box>
      )}

      <Box>
        <Text color="gray">Total: </Text>
        <Text color={totalColor} bold>
          ${order.totalValue.toFixed(2)}
        </Text>
      </Box>

      <Box>
        <Text color="gray">Est. Fees: </Text>
        <Text>${order.fees.toFixed(4)}</Text>
        {order.slippage !== undefined && order.slippage > 0 && (
          <>
            <Text color="gray"> | Slippage: </Text>
            <Text color="yellow">{order.slippage.toFixed(2)}%</Text>
          </>
        )}
      </Box>

      {order.timeInForce && (
        <Box>
          <Text color="gray">TIF: </Text>
          <Text>{order.timeInForce}</Text>
        </Box>
      )}

      {showConfirmation && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="yellow">
            ⚠ Confirm Order?
          </Text>
          <Text dimColor>Press [Enter] to confirm, [Esc] to cancel</Text>
        </Box>
      )}
    </Box>
  );
}
