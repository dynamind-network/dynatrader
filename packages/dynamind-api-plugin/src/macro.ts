/**
 * DynaMind API — Macro Provider
 *
 * Wraps the DynaMind Data API's macro calendar endpoints as a MacroProvider.
 * Provides: economic events, FOMC schedule.
 */

import type { MacroProvider, MacroEvent, FOMCMeeting } from "dynatrader";

export interface DynaMindMacroConfig {
  baseUrl: string;
  apiKey?: string;
}

export function createMacroProvider(config: DynaMindMacroConfig): MacroProvider {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  async function request<T>(path: string): Promise<T> {
    const resp = await fetch(`${config.baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`DynaMind API ${resp.status}: ${resp.statusText}`);
    }
    return resp.json() as Promise<T>;
  }

  return {
    async getCalendar(): Promise<MacroEvent[]> {
      const data = await request<{
        events: Array<{
          date: string;
          title: string;
          impact: string;
          currency: string;
          actual?: string;
          forecast?: string;
          previous?: string;
        }>;
      }>("/api/v1/macro/calendar");

      return data.events.map((e) => ({
        date: e.date,
        title: e.title,
        impact: e.impact as MacroEvent["impact"],
        currency: e.currency,
        actual: e.actual,
        forecast: e.forecast,
        previous: e.previous,
      }));
    },

    async getFOMC(): Promise<FOMCMeeting[]> {
      const data = await request<{
        meetings: Array<{
          date: string;
          time: string;
          type: string;
        }>;
      }>("/api/v1/macro/fomc");

      return data.meetings.map((m) => ({
        date: m.date,
        time: m.time,
        type: m.type,
      }));
    },
  };
}
