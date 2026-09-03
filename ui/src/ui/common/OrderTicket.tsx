import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";

export interface OrderTicketData {
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
  leverage?: number;
  reduceBy?: number;
}

interface OrderTicketProps {
  order: OrderTicketData;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function OrderTicket({
  order,
  onConfirm,
  onCancel,
  isSubmitting = false,
}: OrderTicketProps) {
  const [step, setStep] = useState<"preview" | "confirm">("preview");

  useInput(
    (input: string, key: { escape?: boolean; return?: boolean }) => {
      if (isSubmitting) return;

      if (key.escape) {
        if (step === "confirm") {
          setStep("preview");
        } else {
          onCancel();
        }
        return;
      }

      if (key.return) {
        if (step === "preview") {
          setStep("confirm");
        } else {
          onConfirm();
        }
      }
    },
    { isActive: true },
  );

  const sideColor = order.side === "buy" ? "green" : "red";
  const typeColor = order.orderType === "market" ? "yellow" : "cyan";
  const totalColor = order.side === "buy" ? "red" : "green";
  const confirmColor = step === "confirm" ? "yellow" : "gray";

  return (
    <Box
      flexDirection="column"
      width={50}
      borderStyle="round"
      borderColor={sideColor}
    >
      <Box
        flexDirection="row"
        justifyContent="space-between"
        borderStyle="round"
        borderColor={sideColor}
      >
        <Text bold color={sideColor}>
          {order.side.toUpperCase()} {order.symbol}
        </Text>
        <Text color={typeColor}>{order.orderType.toUpperCase()}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="gray">Size:</Text>
          <Text>{order.size.toFixed(4)}</Text>
        </Box>

        {order.orderType === "limit" && order.price && (
          <Box flexDirection="row" justifyContent="space-between">
            <Text color="gray">Price:</Text>
            <Text>${order.price.toFixed(2)}</Text>
          </Box>
        )}

        {order.leverage && (
          <Box flexDirection="row" justifyContent="space-between">
            <Text color="gray">Leverage:</Text>
            <Text>{order.leverage}x</Text>
          </Box>
        )}

        <Box height={1} borderStyle="single" borderColor="gray" />

        <Box flexDirection="row" justifyContent="space-between">
          <Text color="gray">Total:</Text>
          <Text color={totalColor} bold>
            ${order.totalValue.toFixed(2)}
          </Text>
        </Box>

        <Box flexDirection="row" justifyContent="space-between">
          <Text color="gray">Est. Fees:</Text>
          <Text>${order.fees.toFixed(4)}</Text>
        </Box>

        {order.slippage !== undefined && order.slippage > 0 && (
          <Box flexDirection="row" justifyContent="space-between">
            <Text color="gray">Est. Slippage:</Text>
            <Text color="yellow">{order.slippage.toFixed(2)}%</Text>
          </Box>
        )}

        {(order.reduceOnly || order.postOnly) && (
          <Box flexDirection="row" gap={1}>
            {order.reduceOnly && (
              <Text color="yellow" dimColor>
                [REDUCE ONLY]
              </Text>
            )}
            {order.postOnly && (
              <Text color="cyan" dimColor>
                [POST ONLY]
              </Text>
            )}
          </Box>
        )}
      </Box>

      <Box height={1} borderStyle="single" borderColor="gray" />

      <Box flexDirection="column" alignItems="center" paddingY={1}>
        {step === "preview" ? (
          <Text dimColor>Press [ENTER] to confirm</Text>
        ) : (
          <>
            <Text bold color={confirmColor}>
              CONFIRM {order.side.toUpperCase()}?
            </Text>
            <Text dimColor>Press [ENTER] again to submit, [ESC] to cancel</Text>
          </>
        )}
      </Box>

      {isSubmitting && (
        <Box flexDirection="column" alignItems="center">
          <Text color="yellow">Submitting order...</Text>
        </Box>
      )}
    </Box>
  );
}

interface QuickOrderProps {
  symbol: string;
  currentPrice?: number;
  onSubmit: (order: OrderTicketData) => void;
}

export function QuickOrder({
  symbol,
  currentPrice,
  onSubmit,
}: QuickOrderProps) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [size, setSize] = useState("");
  const [price, setPrice] = useState(currentPrice?.toString() || "");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");

  const handleSubmit = () => {
    const sizeNum = parseFloat(size);
    if (isNaN(sizeNum) || sizeNum <= 0) return;

    const priceNum = orderType === "limit" ? parseFloat(price) : currentPrice;
    if (orderType === "limit" && (!priceNum || isNaN(priceNum))) return;

    const totalValue = sizeNum * (priceNum || currentPrice || 0);
    const fees = totalValue * 0.0005;

    onSubmit({
      symbol,
      side,
      orderType,
      size: sizeNum,
      price: priceNum,
      totalValue,
      fees,
    });
  };

  const sideColor = side === "buy" ? "green" : "red";

  return (
    <Box
      flexDirection="column"
      width={40}
      borderStyle="round"
      borderColor={sideColor}
    >
      <Box flexDirection="row" justifyContent="center" gap={2}>
        <Text color={side === "buy" ? "green" : "gray"} bold={side === "buy"}>
          {side === "buy" ? "[BUY]" : "BUY"}
        </Text>
        <Text color="gray">|</Text>
        <Text color={side === "sell" ? "red" : "gray"} bold={side === "sell"}>
          {side === "sell" ? "[SELL]" : "SELL"}
        </Text>
      </Box>

      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Text color="gray">Symbol:</Text>
        <Text bold>{symbol}</Text>
      </Box>

      {currentPrice && (
        <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
          <Text color="gray">Mark:</Text>
          <Text>${currentPrice.toFixed(2)}</Text>
        </Box>
      )}

      <Box flexDirection="row" justifyContent="center" gap={2} paddingY={1}>
        <Text color={orderType === "market" ? "yellow" : "gray"}>
          {orderType === "market" ? "[MARKET]" : "MARKET"}
        </Text>
        <Text color="gray">|</Text>
        <Text color={orderType === "limit" ? "cyan" : "gray"}>
          {orderType === "limit" ? "[LIMIT]" : "LIMIT"}
        </Text>
      </Box>

      <Box paddingX={1}>
        <Text color="gray">Size: {size || "0.0000"}</Text>
      </Box>

      {orderType === "limit" && (
        <Box paddingX={1}>
          <Text color="gray">Price: {price || "-"}</Text>
        </Box>
      )}

      <Box flexDirection="row" justifyContent="center" paddingY={1}>
        <Text dimColor>Type to set size, Enter to preview</Text>
      </Box>
    </Box>
  );
}
