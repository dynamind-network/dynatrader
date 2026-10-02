import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(__dirname, 'SettingsScreen.tsx');
const source = readFileSync(sourcePath, 'utf-8');

describe('SettingsScreen', () => {
  it('keeps the settings page compact and status-focused', () => {
    expect(source).toContain('export function SettingsScreen');
    expect(source).toContain('Settings');
    expect(source).toContain('Wallet');
    expect(source).toContain('Environment');
    expect(source).toContain('System');
    expect(source).toContain('Quick actions');
    expect(source).toContain('Keyboard shortcuts');
    expect(source).toContain('Esc');
    expect(source).not.toContain('DYNAMIND SETTINGS');
    expect(source).not.toContain('Configuration & Status');
  });
});

