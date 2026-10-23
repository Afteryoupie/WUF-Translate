export const WUF_PAGE_CONTEXT_MENU_ID = 'wuf-page-action';

let refreshVersion = 0;

function warnContextMenu(error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  console.warn('[wuf] context menu:', msg);
}

function getI18nMessage(key: string, fallback: string): string {
  try {
    return globalThis.chrome?.i18n?.getMessage?.(key) || fallback;
  } catch {
    return fallback;
  }
}

export async function refreshPageContextMenu(): Promise<void> {
  const cm = globalThis.chrome?.contextMenus;
  if (!cm) return;
  const version = ++refreshVersion;
  try {
    const tabs = await globalThis.chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const tab = tabs?.[0];
    const badge =
      tab?.id != null
        ? await globalThis.chrome.action.getBadgeText({ tabId: tab.id })
        : '';
    const restore = Boolean(badge);
    if (version !== refreshVersion) return;
    await cm.update(WUF_PAGE_CONTEXT_MENU_ID, {
      title: restore
        ? getI18nMessage('contextShowOriginal', '顯示原文')
        : getI18nMessage('contextTranslatePage', '翻譯本頁'),
    });
  } catch (error) {
    warnContextMenu(error);
  }
}

export function registerPageContextMenus(): void {
  const cm = globalThis.chrome?.contextMenus;
  if (!cm) return;

  async function rebuild(): Promise<void> {
    await cm.removeAll();
    await new Promise<void>((resolve, reject) => {
      cm.create(
        {
          id: WUF_PAGE_CONTEXT_MENU_ID,
          title: getI18nMessage('contextTranslatePage', '翻譯本頁'),
          contexts: [
            'page',
            'frame',
            'selection',
            'link',
            'image',
            'video',
            'audio',
            'editable',
          ],
          documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'],
        },
        () => {
          const lastErr = globalThis.chrome?.runtime?.lastError;
          if (lastErr) {
            reject(new Error(lastErr.message || 'contextMenus.create failed'));
          } else {
            resolve();
          }
        },
      );
    });
    await refreshPageContextMenu();
  }

  const refresh = () => {
    void rebuild().catch(warnContextMenu);
  };

  globalThis.chrome?.runtime?.onInstalled?.addListener(refresh);
  globalThis.chrome?.runtime?.onStartup?.addListener(refresh);
  globalThis.chrome?.tabs?.onActivated?.addListener(() => {
    void refreshPageContextMenu();
  });
  globalThis.chrome?.windows?.onFocusChanged?.addListener(() => {
    void refreshPageContextMenu();
  });

  cm.onClicked.addListener(async (info, tab) => {
    if (tab?.id == null || info.menuItemId !== WUF_PAGE_CONTEXT_MENU_ID) return;
    try {
      const badge = await globalThis.chrome.action.getBadgeText({ tabId: tab.id });
      const restore = Boolean(badge);
      const message = restore
        ? { type: 'wuf:restore-page' as const }
        : {
            type: 'wuf:translate-page' as const,
            payload: { force: true, translateOnly: true },
          };
      await globalThis.chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
      await refreshPageContextMenu();
    } catch (error) {
      warnContextMenu(error);
    }
  });
}
