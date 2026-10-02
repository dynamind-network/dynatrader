/**
 * DynaMind API — Macro Provider
 *
 * Wraps the DynaMind Data API's macro calendar endpoints as a MacroProvider.
 * Provides: economic events, FOMC schedule.
 */

import type { MacroProvider, MacroEvent, FOMCMeeting } from "@dyna/core";
import { requestDynaMindApi } from "./http.js";

export interface DynaMindMacroConfig {
  baseUrl: string;
  apiKey?: string;
}
export function createMacroProvider(config: DynaMindMacroConfig): MacroProvider {
  async function request<T>(path: string): Promise<T> {
    return requestDynaMindApi<T>(config, path, { timeoutMs: 10_000 });
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
