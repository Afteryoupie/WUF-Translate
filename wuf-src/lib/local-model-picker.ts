import type { ProviderProfileType } from '../types.ts';
import { inferProviderType } from './provider-performance.ts';
import { fetchLocalModelsCatalog } from './watchdog-client.ts';

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
  models: string[],
  savedModel: string,
  defaultLabel: string,
): void {
  const items: Array<{ text: string; value: string }> = [
    createOption(defaultLabel, ''),
  ];
  const seen = new Set<string>(['']);
  for (const model of models) {
    if (!seen.has(model)) {
      seen.add(model);
      items.push(createOption(model, model));
    }
  }
  const trimmedSaved = savedModel.trim();
  if (trimmedSaved && !seen.has(trimmedSaved)) {
    items.push(createOption(trimmedSaved, trimmedSaved));
  }
  if (typeof select.replaceChildren === 'function') {
    select.replaceChildren(...items);
  } else {
    select.options = items;
  }
  select.value = trimmedSaved;
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

  let requestToken = 0;

  const isLocalActive = (): boolean => {
    if (getProviderType) {
      return getProviderType() === 'local';
    }
    return inferProviderType(baseUrl.value) === 'local';
  };

  const notifyModelInput = (nextValue: string): void => {
    input.value = nextValue;
    select.value = nextValue;
    input.dispatchEvent(new Event('input'));
    onModelChange?.(nextValue);
  };

  select.addEventListener('change', () => {
    notifyModelInput(select.value);
  });

  clear.addEventListener('click', () => {
    notifyModelInput('');
  });

  const update = async (): Promise<void> => {
    const currentToken = ++requestToken;
    const savedModel = input.value.trim();

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
      const models = await fetchLocalModelsCatalog(endpoint, key);
      if (currentToken !== requestToken || !isLocalActive()) {
        return;
      }
      populateSelectOptions(
        select,
        models,
        input.value,
        t('options.localModel.serverDefault'),
      );
      input.hidden = true;
      select.hidden = false;
      status.textContent = t('options.localModel.ready');
    } catch {
      if (currentToken !== requestToken || !isLocalActive()) {
        return;
      }
      populateSelectOptions(
        select,
        [],
        savedModel,
        t('options.localModel.serverDefault'),
      );
      input.hidden = false;
      select.hidden = false;
      select.value = savedModel;
      status.textContent = t('options.localModel.offlineError');
    } finally {
      if (currentToken === requestToken) {
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
