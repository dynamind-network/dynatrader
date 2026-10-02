export interface ToastNotification {
  id: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  timestamp: number;
  autoDismissMs: number;
}

let notifications: ToastNotification[] = [];
const MAX_TOASTS = 3;
const DEFAULT_DISMISS_MS = 5000;

export function showNotification(
  message: string,
  type: ToastNotification['type'] = 'info',
  autoDismissMs: number = DEFAULT_DISMISS_MS
): ToastNotification {
  const toast: ToastNotification = {
    id: `toast-${Date.now()}`,
    message,
    type,
    timestamp: Date.now(),
    autoDismissMs,
  };

  notifications = notifications.filter(
    (t) => Date.now() - t.timestamp < t.autoDismissMs
  );

  if (notifications.length >= MAX_TOASTS) {
    notifications = notifications.slice(1);
  }

  notifications.push(toast);
  return toast;
}

export function dismissNotification(id: string): void {
  notifications = notifications.filter((t) => t.id !== id);
}

export function dismissAllNotifications(): void {
  notifications = [];
}

export function getActiveNotifications(): ToastNotification[] {
  const now = Date.now();
  notifications = notifications.filter(
    (t) => now - t.timestamp < t.autoDismissMs
  );
  return [...notifications];
}

export function hasActiveNotifications(): boolean {
  return getActiveNotifications().length > 0;
}

