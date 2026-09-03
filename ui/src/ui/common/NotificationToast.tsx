import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { COLORS, SPACING } from '../design/tokens.js';
import {
  getActiveNotifications,
  dismissNotification,
  type ToastNotification,
} from '../../core/notification-toast.js';

interface NotificationToastProps {
  maxVisible?: number;
}

const typeColors: Record<ToastNotification['type'], string> = {
  info: COLORS.accent,
  success: COLORS.success,
  warning: COLORS.warning,
  error: COLORS.error,
};

const typeIcons: Record<ToastNotification['type'], string> = {
  info: 'ℹ',
  success: '✓',
  warning: '⚠',
  error: '✗',
};

export function NotificationToast({ maxVisible = 3 }: NotificationToastProps) {
  const [notifications, setNotifications] = useState<ToastNotification[]>([]);

  useEffect(() => {
    const interval = setInterval(() => {
      const active = getActiveNotifications();
      setNotifications(active.slice(-maxVisible));
    }, 500);
    return () => clearInterval(interval);
  }, [maxVisible]);

  if (notifications.length === 0) return null;

  return (
    <Box flexDirection="column" width="100%">
      {notifications.map((toast) => (
        <Box
          key={toast.id}
          paddingX={SPACING.xs}
          paddingY={0}
          flexDirection="row"
          justifyContent="space-between"
        >
          <Box flexDirection="row">
            <Text color={typeColors[toast.type]} bold>
              {typeIcons[toast.type]}{' '}
            </Text>
            <Text color={COLORS.primary}>{toast.message}</Text>
          </Box>
          <Text color={COLORS.muted} dimColor>
            esc
          </Text>
        </Box>
      ))}
    </Box>
  );
}
