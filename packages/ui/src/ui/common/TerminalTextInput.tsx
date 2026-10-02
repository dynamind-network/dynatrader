import React, { useEffect, useRef } from 'react';
import { Text, useInput } from '@dynatrader/ink/terminal';

interface TerminalTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  isActive?: boolean;
}

/** Small controlled single-line input that uses DynaTrader's renderer/input context. */
export function TerminalTextInput({ value, onChange, onSubmit, placeholder, isActive = true }: TerminalTextInputProps) {
  const cursor = useRef(value.length);
  useEffect(() => { cursor.current = Math.min(cursor.current, value.length); }, [value]);

  useInput((input, key) => {
    if (key.return) { onSubmit?.(value); return; }
    if (key.leftArrow) { cursor.current = Math.max(0, cursor.current - 1); return; }
    if (key.rightArrow) { cursor.current = Math.min(value.length, cursor.current + 1); return; }
    if (key.backspace) {
      if (cursor.current > 0) {
        const next = value.slice(0, cursor.current - 1) + value.slice(cursor.current);
        cursor.current--;
        onChange(next);
      }
      return;
    }
    if (key.delete) {
      if (cursor.current < value.length) onChange(value.slice(0, cursor.current) + value.slice(cursor.current + 1));
      return;
    }
    if (input && !key.ctrl && !key.meta && !input.includes('\n') && !input.includes('\r')) {
      const next = value.slice(0, cursor.current) + input + value.slice(cursor.current);
      cursor.current += input.length;
      onChange(next);
    }
  }, { isActive });

  if (!value) return <Text dimColor>{placeholder ?? ''}</Text>;
  return <Text>{value.slice(0, cursor.current)}▏{value.slice(cursor.current)}</Text>;
}
