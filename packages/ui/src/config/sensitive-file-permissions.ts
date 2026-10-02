const windowsAclWarningsShown = new Set<string>();

export function reportSensitiveFilePermissions(filePath: string, fileMode: number): void {
  if (process.platform === 'win32') {
    if (!windowsAclWarningsShown.has(filePath)) {
      windowsAclWarningsShown.add(filePath);
      console.warn(
        `[security] Windows ACLs for sensitive files are not verified. ` +
          `Ensure access to ${filePath} and its parent directory is restricted to trusted users.`,
      );
    }
    return;
  }

  const mode = fileMode & 0o777;
  if (mode !== 0o600) {
    console.warn(
      `[security] WARNING: ${filePath} has permissions ${mode.toString(8)} ` +
        `(expected 600). Other processes may read your private keys. ` +
        `Run: chmod 600 "${filePath}"`,
    );
  }
}
