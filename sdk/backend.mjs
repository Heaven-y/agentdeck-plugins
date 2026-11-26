/** 插件作者只实现业务；消息、取消、宿主请求和退出由 SDK 统一处理。 */
export function definePlugin(definition) {
  const requests = new Map(),
    hostRequests = new Map();
  let state,
    initialized = false,
    initializing,
    closing;
  const send = (message) =>
    new Promise((resolve, reject) => {
      if (!process.connected) return reject(new Error('插件已断开'));
      process.send(message, (error) => (error ? reject(error) : resolve()));
    });
  const host = {
    request(input, options) {
      return new Promise((resolve, reject) => {
        if (closing || options?.signal?.aborted) return reject(new Error('请求已取消'));
        if (hostRequests.size >= 16) return reject(new Error('请求过多'));
        const id = crypto.randomUUID();
        const finish = () => {
          clearTimeout(timer);
          options?.signal?.removeEventListener('abort', abort);
          hostRequests.delete(id);
        };
        const abort = () => {
          finish();
          void send({ type: 'host.cancel', id }).catch(() => undefined);
          reject(new Error('请求已取消'));
        };
        const timer = setTimeout(abort, 40_000);
        options?.signal?.addEventListener('abort', abort, { once: true });
        hostRequests.set(id, { resolve, reject, finish });
        void send({ type: 'host.request', id, input }).catch((error) => {
          finish();
          reject(error);
        });
      });
    },
  };
  const dispose = () =>
    (closing ??= (async () => {
      for (const controller of requests.values()) controller.abort();
      for (const pending of hostRequests.values()) {
        pending.finish();
        pending.reject(new Error('插件已停止'));
      }
      await initializing?.catch(() => undefined);
      if (initialized) await definition.dispose?.(state);
    })());
  process.on('message', async (message) => {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return;
    const { id, type, input } = message;
    if (type === 'host.response') {
      const pending = hostRequests.get(id);
      if (!pending) return;
      pending.finish();
      message.ok ? pending.resolve(message.value) : pending.reject(new Error(message.message || '宿主服务调用失败'));
      return;
    }
    if (type === 'cancel') {
      requests.get(id)?.abort();
      return;
    }
    try {
      let value = null;
      if (type === 'initialize') {
        if (
          initialized ||
          initializing ||
          closing ||
          !input ||
          typeof input.dataDir !== 'string' ||
          typeof input.hostDataDir !== 'string'
        )
          throw new Error();
        initializing = Promise.resolve().then(() => definition.initialize({ ...input, host }));
        state = await initializing;
        initialized = true;
      } else if (type === 'request') {
        if (!initialized || closing || requests.size >= 32 || requests.has(id)) throw new Error();
        const controller = new AbortController();
        requests.set(id, controller);
        try {
          value = await definition.request(state, input, controller.signal);
        } finally {
          requests.delete(id);
        }
      } else if (type === 'dispose') await dispose();
      else return;
      await send({ id, ok: true, value });
      if (type === 'dispose') process.disconnect?.();
    } catch {
      await send({ id, ok: false }).catch(() => undefined);
    }
  });
  process.once('disconnect', () => {
    void dispose().finally(() => process.exit(0));
  });
}
