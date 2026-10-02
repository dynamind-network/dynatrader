import { bold, cyan, dim, green, printSeparator } from '../utils';

export interface CliCommandHelp {
  name: string;
  usage: string;
  description: string;
  options?: string[];
  subcommands?: string[];
}

export const CLI_COMMANDS: CliCommandHelp[] = [
  { name: 'init', usage: 'dynatrader init [--yes]', description: 'Create the agent workspace and initial configuration.', options: ['--yes  Use defaults without prompts.'] },
  { name: 'setup', usage: 'dynatrader setup', description: 'Review and save workspace configuration.' },
  { name: 'status', usage: 'dynatrader status [--json]', description: 'Show runtime health and workspace summary.', options: ['--json  Print the status object as JSON.'] },
  { name: 'trade', usage: 'dynatrader trade [--mode paper|backtest|live] [--execute]', description: 'Run one agent turn for the configured market universe.', options: ['--mode <mode>  Select execution mode.', '--execute  Submit final trade intents.'] },
  { name: 'portfolio', usage: 'dynatrader portfolio', description: 'Show account balances and recent persisted trades.' },
  { name: 'backtest', usage: 'dynatrader backtest <symbol> --timeframe <timeframe> [--days N]', description: 'Run a historical strategy backtest.', options: ['--timeframe <1m|5m|15m|1h|4h|1d>  Required candle interval.', '--days <N>  Lookback window; default 30.', '--start <date> --end <date>  Set an explicit window.', '--venues <a,b>  Restrict tested venues.'] },
  { name: 'pipeline', usage: 'dynatrader pipeline [--mode research|backtest|paper]', description: 'Run the multi-agent analysis pipeline.' },
  { name: 'agents', usage: 'dynatrader agents', description: 'List configured workspace agents.' },
  { name: 'memory', usage: 'dynatrader memory [query]', description: 'Inspect or search agent memory.' },
  { name: 'sessions', usage: 'dynatrader sessions <list|show|export> [session-id] [options]', description: 'Browse and export persisted agent conversations.', subcommands: ['list  List persisted sessions.', 'show <id>  Show a session and its messages.', 'export <id> [--format markdown|json]  Write a transcript to stdout.'] },
  { name: 'compact', usage: 'dynatrader compact [--status] [--dynamic]', description: 'Inspect or run context compaction.' },
  { name: 'risk', usage: 'dynatrader risk', description: 'Show current risk state.' },
  { name: 'halt', usage: 'dynatrader halt [reason] [--symbol <symbol>]', description: 'Halt trading globally or for a symbol.' },
  { name: 'resume', usage: 'dynatrader resume', description: 'Lift active trading halts.' },
  { name: 'cron', usage: 'dynatrader cron <subcommand> [args] [--json]', description: 'Manage scheduled jobs and persisted execution history.', options: ['--json  Print one structured JSON result; supported by all cron subcommands.', '--limit <1-500>  Limit history results; defaults to 50.'], subcommands: ['list', 'add', 'update', 'inspect', 'remove', 'pause', 'resume', 'trigger', 'history'] },
  { name: 'mcp', usage: 'dynatrader mcp <subcommand> [args]', description: 'Manage configured MCP servers.', subcommands: ['list', 'inspect', 'add', 'update', 'remove', 'enable', 'disable', 'server'] },
  { name: 'kanban', usage: 'dynatrader kanban <subcommand> [args]', description: 'Manage the workspace task board.', subcommands: ['list', 'show', 'create', 'claim', 'transition', 'link'] },
  { name: 'issues', usage: 'dynatrader issues <subcommand> [args]', description: 'Manage markdown issues.' },
  { name: 'track', usage: 'dynatrader track <subcommand> [args]', description: 'Manage tracked entities.' },
  { name: 'inbox', usage: 'dynatrader inbox <subcommand> [args]', description: 'Read delivered reports and task results.' },
  { name: 'workspace', usage: 'dynatrader workspace <list|create|show|validate> [args]', description: 'Manage agent workspaces.', subcommands: ['list', 'create', 'show', 'validate'] },
  { name: 'gateway', usage: 'dynatrader gateway <subcommand> [args]', description: 'Manage daemon lifecycle and channel connections.', options: ['status --json  Print gateway and daemon status as JSON.'], subcommands: ['run', 'start', 'stop', 'restart', 'status', 'logs', 'monit', 'install', 'uninstall', 'send'] },
  { name: 'plugins', usage: 'dynatrader plugins [list|inspect|reload]', description: 'Inspect or reload configured plugins.' },
  { name: 'learning', usage: 'dynatrader learning', description: 'Deprecated; use agent memory and skills tools in chat.' },
  { name: 'doctor', usage: 'dynatrader doctor [--json] [--fix]', description: 'Run system diagnostics.', options: ['--json  Print the diagnostic report as JSON.', '--fix  Attempt supported repairs.'] },
  { name: 'logs', usage: 'dynatrader logs [--follow] [--lines N] [--filter text]', description: 'Read daemon logs.' },
  { name: 'config', usage: 'dynatrader config <list|get|set|validate> [args]', description: 'Inspect and update configuration.' },
  { name: 'version', usage: 'dynatrader version', description: 'Show version information.' },
  { name: 'completion', usage: 'dynatrader completion <bash|zsh|powershell>', description: 'Print shell completion setup.' },
];

export function printCliHelp(topic?: string): void {
  if (topic) {
    const command = CLI_COMMANDS.find((entry) => entry.name === topic);
    if (!command) {
      console.error(`Unknown help topic: ${topic}`);
      console.error('Run dynatrader --help to see available commands.');
      process.exitCode = 2;
      return;
    }
    console.log(`\n${bold(cyan(command.name))} — ${command.description}\n`);
    console.log(bold('Usage:'));
    console.log(`  ${command.usage}`);
    if (command.subcommands?.length) {
      console.log(`\n${bold('Subcommands:')}`);
      for (const item of command.subcommands) console.log(`  ${item}`);
    }
    if (command.options?.length) {
      console.log(`\n${bold('Options:')}`);
      for (const item of command.options) console.log(`  ${item}`);
    }
    console.log();
    return;
  }

  console.log(`\n${bold(cyan('DynaTrader CLI'))}`);
  console.log(dim('Agent runtime, trading, memory, sessions, and operator controls'));
  printSeparator();
  console.log(`\n${bold('Usage:')}\n  dynatrader <command> [options]\n`);
  console.log(bold('Commands:'));
  const width = Math.max(...CLI_COMMANDS.map((entry) => entry.name.length));
  for (const entry of CLI_COMMANDS) {
    console.log(`  ${green(entry.name.padEnd(width))}  ${entry.description}`);
  }
  console.log(`\n${bold('Common options:')}`);
  console.log('  --workspace <path>  Agent workspace directory.');
  console.log('  --runtime <path>    Alias for --workspace.');
  console.log('  --mode <mode>       Select the runtime mode for supported commands.');
  console.log('  --dev               Development launch option.');
  console.log('  --no-daemon         Do not connect to the background daemon.');
  console.log('  --stdio             Run the JSON-RPC stdio entry point.');
  console.log('  --verbose           Enable verbose output where supported.');
  console.log('  --quiet             Suppress non-essential output where supported.');
  console.log('  -h, --help          Show this help or help for a command.');
  console.log('\nUse `dynatrader <command> --help` for command options.');
  console.log('Use `dynatrader completion <bash|zsh|powershell>` to print shell completions.\n');
}

export function getCompletionScript(shell: string): string {
  const commands = CLI_COMMANDS.map((entry) => entry.name).join(' ');
  const subcommandEntries = CLI_COMMANDS.filter((entry) => entry.subcommands?.length);
  const bashCases = subcommandEntries.map((entry) => {
    const values = entry.subcommands!.map((item) => item.split(/\s+/)[0]).join(' ');
    return `    ${entry.name}) words="${values}" ;;`;
  }).join('\n');
  const powershellCases = subcommandEntries.map((entry) => {
    const values = entry.subcommands!.map((item) => item.split(/\s+/)[0]).map((item) => `'${item}'`).join(',');
    return `    '${entry.name}' { $candidates = @(${values}) }`;
  }).join('\n');
  const zshCases = subcommandEntries.map((entry) => {
    const values = entry.subcommands!.map((item) => item.split(/\s+/)[0]).join(' ');
    return `    ${entry.name}) _values 'subcommand' ${values} ;;`;
  }).join('\n');
  switch (shell.toLowerCase()) {
    case 'bash':
      return `# Add to ~/.bashrc: eval "$(dynatrader completion bash)"\n_dynatrader_complete() {\n  local cur="\${COMP_WORDS[COMP_CWORD]}"\n  local words="${commands} --help --workspace --runtime --mode --verbose --quiet"\n  if (( COMP_CWORD > 1 )); then\n    case "\${COMP_WORDS[1]}" in\n${bashCases}\n    esac\n  fi\n  COMPREPLY=( $(compgen -W "$words" -- "$cur") )\n}\ncomplete -F _dynatrader_complete dynatrader dyna\n`;
    case 'zsh':
      return `# Add to ~/.zshrc: eval "$(dynatrader completion zsh)"\n_dynatrader() {\n  local -a commands\n  commands=(${commands.split(' ').map((item) => `'${item}:${CLI_COMMANDS.find((entry) => entry.name === item)?.description.replaceAll("'", "\\'")}'`).join(' ')})\n  if (( CURRENT == 2 )); then\n    _describe 'command' commands\n    return\n  fi\n  case $words[2] in\n${zshCases}\n    *) _files ;;\n  esac\n}\ncompdef _dynatrader dynatrader dyna\n`;
    case 'powershell':
    case 'pwsh':
      return `# Add to your PowerShell profile.\nRegister-ArgumentCompleter -Native -CommandName dynatrader,dyna -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  $candidates = @('${commands.split(' ').join("','")}','--help','--workspace','--runtime','--mode','--verbose','--quiet')\n  if ($commandAst.CommandElements.Count -gt 1) {\n    switch ($commandAst.CommandElements[1].Value) {\n${powershellCases}\n    }\n  }\n  $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`;
    default:
      throw new Error(`Unsupported shell '${shell}'. Choose bash, zsh, or powershell.`);
  }
}
