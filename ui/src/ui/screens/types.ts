// Screen types for Bloomberg-style navigation

export type ScreenType =
  | 'chat' // F12 - Main AI chat (default)
  | 'help' // F1 - Help & shortcuts
  | 'markets' // F2 - Live prices overview
  | 'portfolio' // F3 - Holdings & PnL
  | 'trades' // F4 - Order history
  | 'alerts' // F5 - Price alerts
  | 'analysis' // F6 - Technical analysis
  | 'news' // F7 - Market news
  | 'watchlist' // F8 - Custom watchlist
  | 'chart' // F9 - Full price chart
  | 'search' // F10 - Search
  | 'autohedge' // F11 - AutoHedgeFund control
  | 'settings' // Ctrl+S - Dynamind settings
  | 'models' // Model selector
  | 'orderbook' // Order book depth view
  | 'sessions' // Session picker
  | 'mcp'; // MCP servers

export interface ScreenConfig {
  key: string;
  name: string;
  shortcut: string;
  description: string;
}

export const SCREENS: Record<ScreenType, ScreenConfig> = {
  help: {
    key: 'f1',
    name: 'Help',
    shortcut: 'F1',
    description: 'Commands & shortcuts',
  },
  markets: {
    key: 'f2',
    name: 'Markets',
    shortcut: 'F2',
    description: 'Live prices',
  },
  portfolio: {
    key: 'f3',
    name: 'Portfolio',
    shortcut: 'F3',
    description: 'Holdings & PnL',
  },
  trades: {
    key: 'f4',
    name: 'Trades',
    shortcut: 'F4',
    description: 'Order history',
  },
  alerts: {
    key: 'f5',
    name: 'Alerts',
    shortcut: 'F5',
    description: 'Price alerts',
  },
  analysis: {
    key: 'f6',
    name: 'Analysis',
    shortcut: 'F6',
    description: 'Technical indicators',
  },
  news: { key: 'f7', name: 'News', shortcut: 'F7', description: 'Market news' },
  watchlist: {
    key: 'f8',
    name: 'Watchlist',
    shortcut: 'F8',
    description: 'Custom watchlist',
  },
  chart: {
    key: 'f9',
    name: 'Chart',
    shortcut: 'F9',
    description: 'Price chart',
  },
  search: {
    key: 'f10',
    name: 'Search',
    shortcut: 'F10',
    description: 'Search assets',
  },
  autohedge: {
    key: 'f11',
    name: 'AutoHedge',
    shortcut: 'F11',
    description: 'AutoHedgeFund control',
  },
  chat: {
    key: 'f12',
    name: 'Chat',
    shortcut: 'F12',
    description: 'AI Assistant',
  },
  orderbook: {
    key: 'f13',
    name: 'OrderBook',
    shortcut: 'F13',
    description: 'Order book depth',
  },
  settings: {
    key: 'ctrl+s',
    name: 'Settings',
    shortcut: 'Ctrl+S',
    description: 'Dynamind settings',
  },
  models: {
    key: '',
    name: 'Models',
    shortcut: '/models',
    description: 'Switch AI model',
  },
  sessions: {
    key: '',
    name: 'Sessions',
    shortcut: '/resume',
    description: 'Resume a session',
  },
  mcp: {
    key: '',
    name: 'MCP',
    shortcut: '/mcp',
    description: 'Manage MCP servers',
  },
};

// Map F-keys to screens
export const F_KEY_MAP: Record<string, ScreenType> = {
  f1: 'help',
  f2: 'markets',
  f3: 'portfolio',
  f4: 'trades',
  f5: 'alerts',
  f6: 'analysis',
  f7: 'news',
  f8: 'watchlist',
  f9: 'chart',
  f10: 'search',
  f11: 'autohedge',
  f12: 'chat',
};

// Price data type
export interface PriceData {
  symbol: string;
  price: number;
  change24h: number;
  volume: number;
  high24h: number;
  low24h: number;
  sparkline: number[];
}

// Portfolio position
export interface Position {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

// AutoHedgeFund status
export type AutoHedgeStatus = 'stopped' | 'running' | 'paused' | 'error';

export interface AutoHedgePosition {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  leverage: number;
}

export interface AutoHedgeState {
  status: AutoHedgeStatus;
  startTime: Date | null;
  positions: AutoHedgePosition[];
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  logs: string[];
}
