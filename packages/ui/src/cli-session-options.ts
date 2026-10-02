export interface CliSessionOptions {
  sessionId?: string;
  sessionRequested: boolean;
  resumeRequested: boolean;
  continueSession: boolean;
}

export function selectInitialSessionId(
  sessionId: string | undefined,
  continueSession: boolean,
  recentSessions: Array<{ id: string }>,
): string | undefined {
  return sessionId ?? (continueSession ? recentSessions[0]?.id : undefined);
}

/** Parse only session-selection flags so both CLI entrypoints share semantics. */
export function parseCliSessionOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliSessionOptions {
  let sessionId = env['DYNATRADER_SESSION']?.trim() || undefined;
  let sessionRequested = false;
  let resumeRequested = false;
  let continueSession = env['DYNATRADER_CONTINUE'] === 'true';

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '-c' || arg === '--continue') {
      continueSession = true;
      continue;
    }

    const isResume = arg === '--resume' || arg.startsWith('--resume=');
    const isSession = arg === '-s' || arg === '--session' || arg.startsWith('--session=');
    if (!isResume && !isSession) continue;

    sessionRequested ||= isSession;
    resumeRequested ||= isResume;
    const equalsIndex = arg.indexOf('=');
    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : args[index + 1];
    if (equalsIndex < 0 && value && !value.startsWith('-')) index++;
    if (value && !value.startsWith('-')) sessionId = value;
  }

  return { sessionId, sessionRequested, resumeRequested, continueSession };
}
