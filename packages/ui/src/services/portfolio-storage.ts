import * as fs from 'fs';
import * as path from 'path';
import type { StoredPosition, PortfolioData } from '../types/wallet.js';
import { parseJson } from '../utils/json.js';
import { getDynamindPath } from '../utils/constants.js';

const PORTFOLIO_FILE = getDynamindPath('portfolio.json');

function ensureAppDir(): void {
  const appDir = getDynamindPath();
  if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
  }
}

export function loadPortfolioData(): PortfolioData {
  ensureAppDir();

  try {
    if (fs.existsSync(PORTFOLIO_FILE)) {
      const data = fs.readFileSync(PORTFOLIO_FILE, 'utf-8');
      const parsed = parseJson<{ positions?: StoredPosition[]; lastUpdated?: string }>(data);
      if (parsed) {
        return {
          positions: parsed.positions || [],
          lastUpdated: new Date(parsed.lastUpdated || Date.now()),
        };
      }
    }
  } catch (error) {
    console.error('Failed to load portfolio data:', error);
  }

  return {
    positions: [],
    lastUpdated: new Date(),
  };
}

export function savePortfolioData(data: PortfolioData): void {
  ensureAppDir();

  try {
    const toSave = {
      positions: data.positions,
      lastUpdated: data.lastUpdated.toISOString(),
    };
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(toSave, null, 2));
  } catch (error) {
    console.error('Failed to save portfolio data:', error);
  }
}

export function addPosition(position: StoredPosition): void {
  const data = loadPortfolioData();

  const existingIndex = data.positions.findIndex(
    (p) => p.symbol === position.symbol && p.chain === position.chain
  );

  if (existingIndex >= 0) {
    const existing = data.positions[existingIndex];
    const totalQuantity = existing.quantity + position.quantity;
    const avgEntryPrice =
      (existing.entryPrice * existing.quantity + position.entryPrice * position.quantity) /
      totalQuantity;

    data.positions[existingIndex] = {
      ...existing,
      quantity: totalQuantity,
      entryPrice: avgEntryPrice,
      entryTimestamp: new Date(),
    };
  } else {
    data.positions.push(position);
  }

  data.lastUpdated = new Date();
  savePortfolioData(data);
}

export function removePosition(symbol: string, chain: string): void {
  const data = loadPortfolioData();
  data.positions = data.positions.filter((p) => !(p.symbol === symbol && p.chain === chain));
  data.lastUpdated = new Date();
  savePortfolioData(data);
}

export function updatePositionQuantity(symbol: string, chain: string, newQuantity: number): void {
  const data = loadPortfolioData();
  const position = data.positions.find((p) => p.symbol === symbol && p.chain === chain);

  if (position) {
    if (newQuantity <= 0) {
      removePosition(symbol, chain);
    } else {
      position.quantity = newQuantity;
      data.lastUpdated = new Date();
      savePortfolioData(data);
    }
  }
}

export function getStoredPositions(): StoredPosition[] {
  return loadPortfolioData().positions;
}

export function clearAllPositions(): void {
  savePortfolioData({
    positions: [],
    lastUpdated: new Date(),
  });
}

