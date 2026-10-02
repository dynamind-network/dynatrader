export type ShellCommandDecision =
  | { decision: 'allow' }
  | { decision: 'approval'; reason: string }
  | { decision: 'block'; reason: string };

/** Conservative command safety checks shared by runtime and TUI shell tools. */
export function classifyShellCommand(command: string): ShellCommandDecision {
  const value = command.trim();
  const normalized = value.replace(/\\/g, '/').replace(/\s+/g, ' ').toLowerCase();
  if (!value) return { decision: 'block', reason: 'The command is empty.' };

  const hardBlocks: Array<[RegExp, string]> = [
    [/\brm\s+-[^\n]*r[^\n]*f\s+(?:--\s+)?(?:\/(?:\*|\s|$)|\/dev\/|~(?:\/|\s|$)|\$home(?:\/|\s|$))/i, 'Recursive deletion targets a system or home root.'],
    [/\b(?:format(?:\.com)?(?=\s|$)|diskpart)\b/i, 'Disk formatting and partition commands are blocked.'],
    [/\bdd\s+[^\n]*\bof=(?:\/dev\/|[a-z]:\\?)/i, 'Raw disk writes are blocked.'],
    [/\bremove-item\b[^\n]*(?:-recurse|\-r\b)[^\n]*(?:[a-z]:\\?$|\\|\/\s*$|\$home|\$env:userprofile)/i, 'Recursive deletion of a drive or home directory is blocked.'],
    [/:\s*\(\)\s*\{[^}]*:\|:&\s*\};\s*:/, 'Fork bombs are blocked.'],
  ];
  for (const [pattern, reason] of hardBlocks) if (pattern.test(normalized)) return { decision: 'block', reason };

  if (/[;&|]/.test(value) || value.includes('$(') || value.includes('`')) {
    return { decision: 'approval', reason: 'Shell metacharacters require explicit approval.' };
  }

  const approvalChecks: Array<[RegExp, string]> = [
    [/\b(?:sudo|runas|start-process\b[^\n]*-verb\s+runas)\b/i, 'Elevated commands require explicit approval.'],
    [/\b(?:invoke-expression|\biex\b|eval)\b|\b(?:powershell|pwsh)\b[^\n]*-(?:enc|encodedcommand)\b/i, 'Dynamic or encoded script execution requires explicit approval.'],
    [/\b(?:bash|sh)\s+-c\b|\bcmd(?:\.exe)?\s+\/c\b|\b(?:powershell|pwsh)\b[^\n]*-command\b/i, 'Nested shell or inline script execution requires explicit approval.'],
    [/^\s*(?:[^\s]*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+\S+/i, 'Nested PowerShell execution requires explicit approval.'],
    [/(?:curl|wget|invoke-webrequest|iwr)\b[^\n]*\|\s*(?:bash|sh|pwsh|powershell|iex)\b/i, 'Downloading and immediately executing code requires explicit approval.'],
    [/\b(?:shutdown|restart-computer|stop-computer|reg\s+delete|sc\s+delete)\b/i, 'System-level changes require explicit approval.'],
    [/\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f)/i, 'Destructive Git commands require explicit approval.'],
    [/\brm\s+-[^\n]*r[^\n]*f\b|\bremove-item\b[^\n]*-recurse/i, 'Recursive deletion requires explicit approval.'],
    [/(?:^|[\s"'])[^\s"']*(?:\.env(?:\.[^\s"']+)?|id_rsa|id_ed25519|credentials(?:\.json)?|\.ssh(?:\/|$))(?=$|[\s"'])/i, 'Commands that touch credentials or private keys require explicit approval.'],
  ];
  for (const [pattern, reason] of approvalChecks) if (pattern.test(normalized)) return { decision: 'approval', reason };

  return { decision: 'allow' };
}
