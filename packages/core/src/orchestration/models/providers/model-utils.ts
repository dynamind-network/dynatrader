export function resolveProviderModelId(
  providerId: string,
  requestedModel: string | undefined,
  configuredModel: string,
): string {
  const requested = normalizeModelValue(requestedModel);
  const configured = normalizeModelValue(configuredModel);

  if (requested) {
    const requestedProvider = getProviderPrefix(requested);
    if (!requestedProvider || requestedProvider === providerId) {
      return stripProviderPrefix(requested, providerId);
    }
  }

  if (configured) {
    const configuredProvider = getProviderPrefix(configured);
    if (!configuredProvider || configuredProvider === providerId) {
      return stripProviderPrefix(configured, providerId);
    }
  }

  return configured || requested || '';
}

function normalizeModelValue(value?: string | null): string {
  return value?.trim().replace(/[),.;]+$/, '') ?? '';
}

function getProviderPrefix(model: string): string | null {
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0) {
    return null;
  }
  return model.slice(0, slashIndex).trim();
}

function stripProviderPrefix(model: string, providerId: string): string {
  const prefix = `${providerId}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}
