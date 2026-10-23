import type {
  RuntimeRequestMessage,
  RuntimeResponseMessage,
} from '../types.ts';

export async function sendWufRuntimeMessage<T = unknown>(
  message: RuntimeRequestMessage,
): Promise<RuntimeResponseMessage<T>> {
  const sendMessage = globalThis.chrome?.runtime?.sendMessage;
  if (typeof sendMessage === 'function') {
    try {
      const response = (await sendMessage(message)) as
        | RuntimeResponseMessage<T>
        | undefined;
      if (response && typeof response.ok === 'boolean') {
        return response;
      }
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'SEND_MESSAGE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  const fallbackHandler = (
    globalThis as unknown as {
      __WUF_TEST_MESSAGE_HANDLER__?: (
        msg: RuntimeRequestMessage,
      ) => Promise<RuntimeResponseMessage<T>>;
    }
  ).__WUF_TEST_MESSAGE_HANDLER__;

  if (typeof fallbackHandler === 'function') {
    return await fallbackHandler(message);
  }

  return {
    ok: false,
    error: {
      code: 'RUNTIME_UNAVAILABLE',
      message: 'chrome.runtime.sendMessage is unavailable',
    },
  };
}
