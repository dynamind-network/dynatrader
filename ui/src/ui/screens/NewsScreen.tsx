import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { providers } from '../../config/providers.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { ScreenPaneWorkspace, useScreenPaneController } from '../layout/ScreenPaneWorkspace.js';

interface NewsItem {
  title: string;
  source: string;
  pubDate: Date;
  link: string;
}

interface NewsScreenProps {
  onBack: () => void;
  terminalSize?: { width: number; height: number };
  workspaceDir?: string;
}

const NEWS_REFRESH_MS = 5 * 60 * 1000;

const FALLBACK_NEWS: NewsItem[] = [
  {
    title: 'Markets are moving fast. Live crypto headlines are temporarily unavailable.',
    source: 'DynaMind',
    pubDate: new Date(),
    link: '',
  },
  {
    title:
      'Use the Markets screen for price action and the Analysis screen for technical signals while news refreshes.',
    source: 'DynaMind',
    pubDate: new Date(Date.now() - 5 * 60 * 1000),
    link: '',
  },
  {
    title: 'This panel will retry automatically after the provider rate limit cools down.',
    source: 'DynaMind',
    pubDate: new Date(Date.now() - 10 * 60 * 1000),
    link: '',
  },
];

/**
 * F7 - News Screen
 * Shows crypto news from CoinGecko API
 */
export function NewsScreen({ onBack, terminalSize: providedSize, workspaceDir }: NewsScreenProps) {
  const internalSize = useTerminalSize();
  const terminalSize = providedSize ?? internalSize;
  const paneController = useScreenPaneController({ screenId: 'news', workspaceDir, terminalSize, paneIds: ['feed', 'preview', 'sources'], defaultPanes: ['feed'] });
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [isFallback, setIsFallback] = useState(false);
  const [retryAt, setRetryAt] = useState<Date | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  useEffect(() => {
    fetchNews();
    const interval = setInterval(fetchNews, NEWS_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (news.length === 0) {
      setSelectedIndex(0);
      setPreviewIndex(null);
      return;
    }

    setSelectedIndex((prev) => Math.min(prev, news.length - 1));
    setPreviewIndex((prev) => (prev === null ? null : Math.min(prev, news.length - 1)));
  }, [news]);

  useInput((_input, key) => {
    if (news.length === 0) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(prev + 1, news.length - 1));
      return;
    }

    if (key.return) {
      setPreviewIndex((prev) => (prev === selectedIndex ? null : selectedIndex));
    }
  }, { isActive: paneController.isInputActive('feed') });

  async function fetchNews() {
    try {
      setLoading(true);
      const url = `${providers.news.rest}${providers.news.newsPath}`;
      const response = await fetch(url);

      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        const retryAtValue =
          retryAfter && !Number.isNaN(Number(retryAfter))
            ? new Date(Date.now() + Number(retryAfter) * 1000)
            : new Date(Date.now() + NEWS_REFRESH_MS);

        if (response.status === 429) {
          setRetryAt(retryAtValue);
          throw new Error('Rate limited (429)');
        }

        throw new Error(`API returned ${response.status}`);
      }

      const data = (await response.json()) as {
        Data: Array<{
          title: string;
          source: string;
          published_on: number;
          url: string;
          categories: string;
        }>;
      };

      if (!data.Data || data.Data.length === 0) {
        throw new Error('No news data received');
      }

      const newsItems: NewsItem[] = data.Data.slice(0, 15).map((item) => ({
        title: item.title,
        source: item.source || 'CryptoCompare',
        pubDate: new Date(item.published_on * 1000),
        link: item.url,
      }));

      setNews(newsItems);
      setLastUpdate(new Date());
      setLoading(false);
      setError(null);
      setIsFallback(false);
      setRetryAt(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch news';
      setError(message);
      if (news.length === 0) {
        setNews(FALLBACK_NEWS);
        setIsFallback(true);
        setLastUpdate(new Date());
      }
      setLoading(false);
    }
  }

  if (loading && news.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          NEWS [F7]
        </Text>
        <Text dimColor>Loading news...</Text>
      </Box>
    );
  }

  if (error && news.length === 0 && !isFallback) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          NEWS [F7]
        </Text>
        <Box marginTop={1}>
          <Text color="red">Unable to fetch news</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Error: {error}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {error.includes('429')
              ? 'The news provider is rate limiting requests. Please wait and try again.'
              : 'Check your internet connection and try again.'}
          </Text>
        </Box>
        <Box marginTop={2}>
          <Text dimColor>Press </Text>
          <Text color="yellow">Esc</Text>
          <Text dimColor> to return to chat</Text>
        </Box>
      </Box>
    );
  }

  const mainPane = (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          NEWS [F7]
        </Text>
        <Text dimColor> Last update: {lastUpdate.toLocaleTimeString()}</Text>
      </Box>

      {error && (
        <Box marginBottom={1} flexDirection="column">
          <Text color={isFallback ? 'yellow' : 'red'}>
            {isFallback
              ? 'Using fallback headlines because the live news API is unavailable.'
              : `News refresh failed: ${error}`}
          </Text>
          {retryAt && (
            <Text dimColor>Next automatic retry after {retryAt.toLocaleTimeString()}</Text>
          )}
        </Box>
      )}

      {/* Column Headers */}
      <Box>
        <Box width={3}>
          <Text bold> </Text>
        </Box>
        <Box width={10}>
          <Text bold>Time</Text>
        </Box>
        <Box width={14}>
          <Text bold>Source</Text>
        </Box>
        <Box width={53}>
          <Text bold>Headline</Text>
        </Box>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{'─'.repeat(80)}</Text>
      </Box>

      {/* News Rows */}
      {news.map((item, i) => {
        const timeStr = formatTimeAgo(item.pubDate);
        const isSelected = i === selectedIndex;
        const truncatedTitle =
          item.title.length > 51 ? item.title.slice(0, 48) + '...' : item.title;

        return (
          <Box key={i} marginBottom={0}>
            <Box width={3}>
              <Text color={isSelected ? 'cyan' : 'gray'} bold={isSelected}>
                {isSelected ? '>' : ' '}
              </Text>
            </Box>
            <Box width={10}>
              <Text color={isSelected ? 'cyan' : undefined} dimColor={!isSelected}>
                {timeStr}
              </Text>
            </Box>
            <Box width={14}>
              <Text color={isSelected ? 'yellow' : 'gray'} bold={isSelected}>
                {item.source.slice(0, 12)}
              </Text>
            </Box>
            <Box width={53}>
              <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                {truncatedTitle}
              </Text>
            </Box>
          </Box>
        );
      })}

      {previewIndex !== null && news[previewIndex] && (
        <>
          <Box marginTop={1}>
            <Text dimColor>{'─'.repeat(80)}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="cyan" bold>
              PREVIEW
            </Text>
            <Box marginTop={1}>
              <Text color="yellow">Source: </Text>
              <Text color="white">{news[previewIndex].source}</Text>
              <Text dimColor> | {formatTimeAgo(news[previewIndex].pubDate)}</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="white" bold>
                {news[previewIndex].title}
              </Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>
                {news[previewIndex].link
                  ? `Link: ${news[previewIndex].link}`
                  : 'No article link available for this item.'}
              </Text>
            </Box>
          </Box>
        </>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{'─'.repeat(80)}</Text>
      </Box>
      <Box>
        <Text dimColor>Press </Text>
        <Text color="yellow">Esc</Text>
        <Text dimColor> to return | </Text>
        <Text color="yellow">↑/↓</Text>
        <Text dimColor> browse | </Text>
        <Text color="yellow">Enter</Text>
        <Text dimColor> preview | </Text>
        <Text color="yellow">Alt+M</Text>
        <Text dimColor> for markets | </Text>
        <Text color="yellow">Alt+Y</Text>
        <Text dimColor> for analysis</Text>
      </Box>
    </Box>
  );

  const sourceCounts = news.reduce<Record<string, number>>((counts, item) => {
    counts[item.source] = (counts[item.source] ?? 0) + 1;
    return counts;
  }, {});
  const topSources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const selected = news[selectedIndex];
  const briefingPane = (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>LIVE BRIEFING</Text>
      <Text>{news.length} headlines in the current feed</Text>
      <Text dimColor> </Text>
      <Text color="yellow" bold>SOURCES</Text>
      {topSources.length ? topSources.map(([source, count]) => (
        <Box key={source} justifyContent="space-between"><Text>{source}</Text><Text dimColor>{count} stories</Text></Box>
      )) : <Text dimColor>Waiting for headlines…</Text>}
      <Text dimColor> </Text>
      <Text color="yellow" bold>SELECTED STORY</Text>
      {selected ? <>
        <Text color="white" bold>{selected.title}</Text>
        <Text dimColor>{selected.source} · {formatTimeAgo(selected.pubDate)}</Text>
        {selected.link ? <Text dimColor>{selected.link}</Text> : null}
      </> : <Text dimColor>Select a headline in the feed.</Text>}
      {isFallback && <Text color="yellow">Fallback feed · live provider unavailable</Text>}
      {retryAt && <Text dimColor>Retry after {retryAt.toLocaleTimeString()}</Text>}
    </Box>
  );

  return (
    <ScreenPaneWorkspace
      controller={paneController}
      terminalSize={terminalSize}
      panes={[
        { id: 'feed', title: 'NEWS FEED', content: mainPane },
        { id: 'briefing', title: 'NEWS BRIEFING', content: briefingPane },
      ]}
    />
  );
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export default NewsScreen;
