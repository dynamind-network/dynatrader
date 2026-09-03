export interface HeaderSegment {
  text: string;
  active?: boolean;
  dim?: boolean;
  bold?: boolean;
  /** Wrap active screen text in brackets for visual emphasis: [Chat] vs Plan */
  bracketed?: boolean;
}

interface NavItem {
  key: string;
  full: string;
  medium: string;
  short: string;
}

type NavVariant = 'full' | 'medium' | 'short';

const VERSION = '1.0.0';
const PREFIX = `Dynamind v${VERSION} | `;
const SUFFIX = ' | Esc:Chat';
const OVERFLOW = ' ...';

const NAV_ITEMS: NavItem[] = [
  { key: 'help', full: 'Help', medium: 'Help', short: 'H' },
  { key: 'markets', full: 'Markets', medium: 'Mkt', short: 'M' },
  { key: 'portfolio', full: 'Portfolio', medium: 'Port', short: 'P' },
  { key: 'trades', full: 'Trades', medium: 'Trad', short: 'T' },
  { key: 'alerts', full: 'Alerts', medium: 'Alert', short: 'A' },
  { key: 'analysis', full: 'Analysis', medium: 'Analyze', short: 'A' },
  { key: 'news', full: 'News', medium: 'News', short: 'N' },
  { key: 'watchlist', full: 'Watchlist', medium: 'Watch', short: 'W' },
  { key: 'chart', full: 'Graph', medium: 'Graph', short: 'G' },
  { key: 'search', full: 'Search', medium: 'Find', short: 'F' },
  { key: 'orderbook', full: 'Depth', medium: 'Depth', short: 'D' },
];

const SCREEN_LABELS: Record<string, { full: string; medium: string; short: string }> = {
  chat: { full: 'Chat', medium: 'Chat', short: 'C' },
  help: { full: 'Help', medium: 'Help', short: 'H' },
  markets: { full: 'Markets', medium: 'Mkt', short: 'M' },
  portfolio: { full: 'Portfolio', medium: 'Port', short: 'P' },
  trades: { full: 'Trades', medium: 'Trad', short: 'T' },
  alerts: { full: 'Alerts', medium: 'Alert', short: 'A' },
  analysis: { full: 'Analysis', medium: 'Analyze', short: 'A' },
  news: { full: 'News', medium: 'News', short: 'N' },
  watchlist: { full: 'Watchlist', medium: 'Watch', short: 'W' },
  chart: { full: 'Graph', medium: 'Graph', short: 'G' },
  search: { full: 'Search', medium: 'Find', short: 'F' },
  orderbook: { full: 'Depth', medium: 'Depth', short: 'D' },
  settings: { full: 'Settings', medium: 'Sett', short: 'O' },
  models: { full: 'Models', medium: 'Model', short: 'R' },
};

interface LayoutConfig {
  activeVariant: NavVariant;
  itemVariant: NavVariant;
  order: string[];
}

interface HeaderLayout {
  segments: HeaderSegment[];
  text: string;
}

function getScreenLabel(screen: string, variant: NavVariant): string {
  const labels = SCREEN_LABELS[screen] ?? {
    full: screen,
    medium: screen.slice(0, 5) || 'Chat',
    short: screen.charAt(0).toUpperCase() || 'C',
  };
  return labels[variant];
}

function getItemLabel(item: NavItem, variant: NavVariant): string {
  return item[variant];
}

function createEmergencyLayout(width: number, activeScreen: string): HeaderLayout {
  const fallback = `${PREFIX}${getScreenLabel(activeScreen, 'short')}${SUFFIX}`;
  const clipped = fallback.slice(0, Math.max(0, width));
  return {
    segments: [{ text: clipped, bold: true }],
    text: clipped,
  };
}

function fitNavItems(
  width: number,
  activeScreen: string,
  config: LayoutConfig
): HeaderLayout | null {
  const budget = width - PREFIX.length - SUFFIX.length;
  if (budget <= 0) {
    return null;
  }

  const activeLabel = getScreenLabel(activeScreen, config.activeVariant);
  if (activeLabel.length > budget) {
    return null;
  }

  const segments: HeaderSegment[] = [
    { text: PREFIX, bold: true },
    { text: activeLabel, active: true, bold: true, bracketed: true },
  ];

  let used = activeLabel.length;
  const orderedItems = config.order
    .map((key) => NAV_ITEMS.find((item) => item.key === key))
    .filter((item): item is NavItem => Boolean(item))
    .filter((item) => item.key !== activeScreen);

  let omitted = false;

  for (const item of orderedItems) {
    const label = getItemLabel(item, config.itemVariant);
    const cost = 1 + label.length;
    if (used + cost > budget) {
      omitted = true;
      continue;
    }

    segments.push({ text: ' ', dim: true });
    segments.push({ text: label });
    used += cost;
  }

  if (omitted && used + OVERFLOW.length <= budget) {
    segments.push({ text: OVERFLOW, dim: true });
  }

  segments.push({ text: SUFFIX, dim: true });

  const text = segments.map((segment) => segment.text).join('');
  if (text.length > width) {
    return null;
  }

  return { segments, text };
}

export function buildHeaderNavLayout(width: number, activeScreen: string): HeaderLayout {
  const configs: LayoutConfig[] =
    width >= 100
      ? [
          {
            activeVariant: 'full',
            itemVariant: 'full',
            order: NAV_ITEMS.map((item) => item.key),
          },
          {
            activeVariant: 'medium',
            itemVariant: 'medium',
            order: NAV_ITEMS.map((item) => item.key),
          },
          {
            activeVariant: 'medium',
            itemVariant: 'short',
            order: [
              'help',
              'markets',
              'portfolio',
              'trades',
              'alerts',
              'chart',
              'search',
              'watchlist',
            ],
          },
          {
            activeVariant: 'short',
            itemVariant: 'short',
            order: [],
          },
        ]
      : width >= 70
        ? [
            {
              activeVariant: 'medium',
              itemVariant: 'medium',
              order: ['help', 'markets', 'portfolio', 'trades', 'analysis', 'search'],
            },
            {
              activeVariant: 'medium',
              itemVariant: 'short',
              order: [
                'help',
                'markets',
                'portfolio',
                'trades',
                'alerts',
                'chart',
                'search',
                'watchlist',
              ],
            },
            {
              activeVariant: 'short',
              itemVariant: 'short',
              order: [],
            },
          ]
        : [
            {
              activeVariant: 'medium',
              itemVariant: 'short',
              order: [
                'help',
                'markets',
                'portfolio',
                'trades',
                'alerts',
                'chart',
                'search',
                'watchlist',
              ],
            },
            {
              activeVariant: 'short',
              itemVariant: 'short',
              order: [],
            },
          ];

  if (width <= 40) {
    const minimal = fitNavItems(width, activeScreen, {
      activeVariant: 'medium',
      itemVariant: 'short',
      order: [],
    });
    if (minimal) {
      return minimal;
    }
  }

  for (const config of configs) {
    const layout = fitNavItems(width, activeScreen, config);
    if (layout) {
      return layout;
    }
  }

  return createEmergencyLayout(width, activeScreen);
}
