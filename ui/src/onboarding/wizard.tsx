import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { PROVIDERS, Auth } from '../index.js';
import { parseJson } from '../utils/json.js';
import { getDynamindPath } from '../utils/constants.js';
import { validateAPIKey, testAPIKey, formatProviderName, checkExistingConfig } from './utils.js';

interface WizardStep {
  welcome: boolean;
  apiKeys: boolean;
  wallet: boolean;
  summary: boolean;
}

interface OnboardingWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

export function OnboardingWizard({ onComplete, onCancel }: OnboardingWizardProps) {
  const [step, setStep] = useState<WizardStep>({
    welcome: true,
    apiKeys: false,
    wallet: false,
    summary: false,
  });
  const [providersToConfig, setProvidersToConfig] = useState<string[]>([]);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [wallet, setWallet] = useState<{ privateKey: string; address: string }>({
    privateKey: '',
    address: '',
  });
  const [testResults, setTestResults] = useState<
    Record<string, { success: boolean; error?: string }>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  useEffect(() => {
    const checkConfig = async () => {
      const config = await checkExistingConfig();
      if (config.hasAuth) {
        setProvidersToConfig(Object.keys(apiKeys));
      }
    };
    checkConfig();
  }, []);

  const providerOptions = Object.entries(PROVIDERS)
    .filter(([id]) => !providersToConfig.includes(id))
    .map(([id, provider]) => ({
      value: id,
      label: `${provider.displayName} (${provider.models.length} models)`,
    }));

  const nextStep = useCallback(() => {
    if (step.welcome) {
      setStep({ welcome: false, apiKeys: true, wallet: false, summary: false });
    } else if (step.apiKeys) {
      setStep({ welcome: false, apiKeys: false, wallet: true, summary: false });
    } else if (step.wallet) {
      setStep({ welcome: false, apiKeys: false, wallet: false, summary: true });
    }
  }, [step]);

  const skipWallet = useCallback(() => {
    setWallet({ privateKey: '', address: '' });
    setStep({ welcome: false, apiKeys: false, wallet: false, summary: true });
  }, []);

  const goBack = useCallback(() => {
    if (step.apiKeys) {
      setStep({ welcome: true, apiKeys: false, wallet: false, summary: false });
    } else if (step.wallet) {
      setStep({ welcome: false, apiKeys: true, wallet: false, summary: false });
    }
  }, [step]);

  const handleProviderSelect = useCallback(
    async (provider: string) => {
      const existing = await Auth.get(provider);
      if (existing) {
        setProvidersToConfig([...providersToConfig, provider]);
        setApiKeys({
          ...apiKeys,
          [provider]: existing.type === 'api' ? (existing as any).key : '',
        });
        return;
      }

      setStep({ welcome: false, apiKeys: true, wallet: false, summary: false });
    },
    [apiKeys, providersToConfig]
  );

  const saveApiKeys = useCallback(async () => {
    setIsLoading(true);
    setError('');

    for (const [provider, key] of Object.entries(apiKeys)) {
      if (key && validateAPIKey(provider, key)) {
        const testResult = await testAPIKey(provider, key);
        setTestResults({ ...testResults, [provider]: testResult });

        if (!testResult.success) {
          setError(`Failed to connect to ${formatProviderName(provider)}: ${testResult.error}`);
          setIsLoading(false);
          return;
        }

        await Auth.set(provider, { type: 'api', key });
      }
    }

    setIsLoading(false);
    nextStep();
  }, [apiKeys]);

  const saveWallet = useCallback(async () => {
    if (wallet.privateKey || wallet.address) {
      const fs = await import('fs/promises');
      const settingsPath = getDynamindPath('settings.json');

      try {
        const settingsContent = await fs.readFile(settingsPath, 'utf-8');
        const settings = parseJson<Record<string, unknown>>(settingsContent);
        if (!settings) {
          throw new Error('Invalid settings JSON');
        }
        settings.wallet = {
          privateKey: wallet.privateKey,
          address: wallet.address,
        };
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        nextStep();
      } catch {
        setError('Failed to save wallet configuration');
        setIsLoading(false);
      }
    } else {
      nextStep();
    }
  }, [wallet]);

  const finishOnboarding = useCallback(async () => {
    onComplete();
  }, [onComplete]);

  if (step.welcome) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="white" inverse={true}>
            {'  Dynamind Terminal Onboarding  '}
          </Text>
        </Box>

        <Text color="cyan">Welcome to Dynamind Terminal</Text>
        <Text>This wizard will help you configure:</Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Text color="green">• API keys for AI providers</Text>
          <Text color="yellow">• Wallet (optional, for trading features)</Text>
          <Text>• Basic configuration</Text>
        </Box>

        <Box marginTop={2}>
          <Text color="white" bold>
            Press Enter to continue, ESC to cancel
          </Text>
        </Box>
      </Box>
    );
  }

  if (step.apiKeys) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Configure API Keys
          </Text>
          <Text dimColor>Setup one or more AI providers to enable AI features</Text>
        </Box>

        {providersToConfig.length > 0 && (
          <Box marginBottom={1} borderStyle="round" borderColor="green" padding={1}>
            <Text color="green" bold>
              Configured Providers
            </Text>
            {providersToConfig.map((provider) => (
              <Box key={provider} paddingLeft={2}>
                <Text color="white">✓ {formatProviderName(provider)}</Text>
              </Box>
            ))}
          </Box>
        )}

        <Box marginBottom={1}>
          <Text color="yellow" bold>
            Add Provider
          </Text>
          <Text dimColor>Select a provider to configure its API key:</Text>
          {providerOptions.map((option) => (
            <Box key={option.value} paddingLeft={2}>
              <Text color="cyan">
                {option.value + 1}. {option.label}
              </Text>
            </Box>
          ))}
        </Box>

        {error && (
          <Box marginBottom={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}

        <Box marginTop={1} flexDirection="column">
          {providersToConfig.length < Object.keys(PROVIDERS).length && (
            <Text dimColor>
              Press number (1-{providerOptions.length}) to add provider, or Enter to continue
            </Text>
          )}
          {providersToConfig.length > 0 && (
            <>
              <Text dimColor>Press S to save and test API keys</Text>
              <Text dimColor>Press Esc to go back</Text>
            </>
          )}
        </Box>
      </Box>
    );
  }

  if (step.wallet) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Configure Wallet (Optional)
          </Text>
          <Text dimColor>Trading features require a wallet configuration</Text>
          <Text dimColor>You can skip this and use only AI features</Text>
        </Box>

        <Box marginBottom={1} borderStyle="round" borderColor="yellow" padding={1}>
          <Text color="yellow" bold>
            WARN Security Warning
          </Text>
          <Text>Private keys control your wallet. Never share them.</Text>
          <Text>Store securely and never commit to version control.</Text>
        </Box>

        <Box marginBottom={1}>
          <Text color="white" bold>
            Private Key
          </Text>
          <Text dimColor>Your wallet private key for signing transactions</Text>
          <Text color="white">Status: {wallet.privateKey ? '✓ Configured' : 'Not set'}</Text>
        </Box>

        <Box marginBottom={1}>
          <Text color="white" bold>
            Main Address
          </Text>
          <Text dimColor>Your wallet's main address for receiving funds</Text>
          <Text color="white">Status: {wallet.address ? '✓ Configured' : 'Not set'}</Text>
        </Box>

        {error && (
          <Box marginBottom={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          {wallet.privateKey || wallet.address ? (
            <>
              <Text dimColor>Press S to save wallet configuration</Text>
              <Text dimColor>Press Esc to skip wallet setup</Text>
            </>
          ) : (
            <Text dimColor>Press S to skip (AI features work without wallet)</Text>
          )}
        </Box>
      </Box>
    );
  }

  if (step.summary) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="green">
            Configuration Summary
          </Text>
          <Text dimColor>Review your configuration before finishing</Text>
        </Box>

        <Box marginBottom={1} borderStyle="round" padding={1}>
          <Text color="white" bold>
            API Keys
          </Text>
          {Object.keys(apiKeys).length > 0 ? (
            <Box flexDirection="column">
              {Object.entries(apiKeys).map(([provider, key]) => (
                <Box key={provider} paddingLeft={2}>
                  <Text color="green">✓ {formatProviderName(provider)}</Text>
                  <Text dimColor>Key: {key.substring(0, 8)}...</Text>
                  {testResults[provider]?.success ? (
                    <Text color="green">Tested successfully</Text>
                  ) : (
                    <Text color="red">Test failed</Text>
                  )}
                </Box>
              ))}
            </Box>
          ) : (
            <Text color="red" dimColor>
              No API keys configured
            </Text>
          )}
        </Box>

        <Box marginBottom={1} borderStyle="round" padding={1}>
          <Text color="white" bold>
            Wallet
          </Text>
          {wallet.privateKey || wallet.address ? (
            <Box flexDirection="column" paddingLeft={2}>
              <Text color="green">✓ Configured</Text>
              <Text dimColor>Address: {wallet.address?.substring(0, 10)}...</Text>
            </Box>
          ) : (
            <Text color="yellow" dimColor>
              Not configured (optional)
            </Text>
          )}
        </Box>

        {error && (
          <Box marginBottom={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}

        <Box marginTop={2} flexDirection="column">
          <Text color="white" bold>
            Press Enter to finish onboarding
          </Text>
          <Text dimColor>Press Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (isLoading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box>
          <Text color="cyan">Testing API key...</Text>
        </Box>
      </Box>
    );
  }

  return null;
}
