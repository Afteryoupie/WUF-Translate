import type { ProviderProfileType } from '../types.ts';
import { inferProviderType } from './provider-performance.ts';
import {
  fetchLocalModelEntries,
  resolveSavedModelId,
  type LocalModelEntry,
} from './watchdog-client.ts';

export interface PickerControlLike {
  value: string;
  hidden: boolean;
  disabled: boolean;
  textContent?: string | null;
  options?: Array<{ text: string; value: string }>;
  replaceChildren?: (...nodes: unknown[]) => void;
  add?: (option: { text: string; value: string }) => void;
  addEventListener: (type: string, listener: () => void) => void;
  dispatchEvent: (event: Event) => boolean;
}

export interface LocalModelPickerBindings {
  baseUrl: PickerControlLike;
  input: PickerControlLike;
  select: PickerControlLike;
  refresh: PickerControlLike;
  clear: PickerControlLike;
  status: PickerControlLike;
  hint?: PickerControlLike;
  apiKey?: PickerControlLike;
  t: (key: string) => string;
  getProviderType?: () => ProviderProfileType;
  onModelChange?: (model: string) => void;
}

function createOption(text: string, value: string): { text: string; value: string } {
  if (typeof globalThis.Option === 'function') {
    return new globalThis.Option(text, value);
  }
  return { text, value };
}

function populateSelectOptions(
  select: PickerControlLike,
  models: LocalModelEntry[],
  savedModel: string,
  defaultLabel: string,
): { resolved: string; normalizedFromAlias: boolean } {
  const items: Array<{ text: string; value: string }> = [
    createOption(defaultLabel, ''),
  ];
  const seen = new Set<string>(['']);
  for (const model of models) {
    if (!seen.has(model.id)) {
      seen.add(model.id);
      items.push(createOption(model.name || model.id, model.id));
    }
  }
  const { resolved, normalizedFromAlias } = resolveSavedModelId(savedModel, models);
  if (resolved && !seen.has(resolved)) {
    items.push(createOption(resolved, resolved));
  }
  if (typeof select.replaceChildren === 'function') {
    select.replaceChildren(...items);
  } else {
    select.options = items;
  }
  select.value = resolved;
  return { resolved, normalizedFromAlias };
}

/**
 * Binds a local /v1/models dropdown selector with refresh, manual clear to
 * server default (''), offline preservation of saved models, and stale response
 * protection when switching endpoints or provider types.
 */
export function bindLocalModelPicker(bindings: LocalModelPickerBindings): () => Promise<void> {
  const {
    baseUrl,
    input,
    select,
    refresh,
    clear,
    status,
    apiKey,
    t,
    getProviderType,
    onModelChange,
  } = bindings;

  let refreshToken = 0;
  let selectionToken = 0;
  let syncingInput = false;

  const isLocalActive = (): boolean => {
    if (getProviderType) {
      return getProviderType() === 'local';
    }
    return inferProviderType(baseUrl.value) === 'local';
  };

  const notifyModelInput = (nextValue: string): void => {
    input.value = nextValue;
    select.value = nextValue;
    syncingInput = true;
    try {
      input.dispatchEvent(new Event('input'));
    } finally {
      syncingInput = false;
    }
    onModelChange?.(nextValue);
  };

  select.addEventListener('change', () => {
    selectionToken++;
    notifyModelInput(select.value);
  });

  clear.addEventListener('click', () => {
    selectionToken++;
    notifyModelInput('');
  });

  input.addEventListener('input', () => {
    if (!syncingInput) {
      selectionToken++;
    }
  });

  const update = async (): Promise<void> => {
    const currentRefreshToken = ++refreshToken;
    const currentSelectionToken = selectionToken;

    if (!isLocalActive()) {
      input.hidden = false;
      select.hidden = true;
      refresh.disabled = false;
      status.textContent = '';
      return;
    }

    const endpoint = baseUrl.value.trim();
    const key = apiKey?.value?.trim() || '';
    refresh.disabled = true;
    status.textContent = t('options.localModel.loading');

    try {
      const models = await fetchLocalModelEntries(endpoint, key);
      if (currentRefreshToken !== refreshToken) {
        return;
      }
      if (!isLocalActive()) {
        input.hidden = false;
        select.hidden = true;
        status.textContent = '';
        return;
      }
      if (currentSelectionToken !== selectionToken) {
        status.textContent = t('options.localModel.ready');
        return;
      }
      const currentSaved = input.value.trim();
      const { resolved, normalizedFromAlias } = populateSelectOptions(
        select,
        models,
        currentSaved,
        t('options.localModel.serverDefault'),
      );
      if (normalizedFromAlias && resolved !== currentSaved) {
        notifyModelInput(resolved);
      }
      input.hidden = true;
      select.hidden = false;
      status.textContent = t('options.localModel.ready');
    } catch {
      if (currentRefreshToken !== refreshToken) {
        return;
      }
      if (!isLocalActive()) {
        input.hidden = false;
        select.hidden = true;
        status.textContent = '';
        return;
      }
      if (currentSelectionToken !== selectionToken) {
        status.textContent = t('options.localModel.offlineError');
        return;
      }
      const currentSaved = input.value.trim();
      populateSelectOptions(
        select,
        [],
        currentSaved,
        t('options.localModel.serverDefault'),
      );
      input.hidden = false;
      select.hidden = false;
      select.value = currentSaved;
      status.textContent = t('options.localModel.offlineError');
    } finally {
      if (currentRefreshToken === refreshToken) {
        refresh.disabled = false;
      }
    }
  };

  refresh.addEventListener('click', () => {
    void update();
  });

  baseUrl.addEventListener('change', () => {
    void update();
  });

  return update;
}
