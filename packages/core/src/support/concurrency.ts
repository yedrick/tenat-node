/**
 * Ejecuta `fn` para cada elemento con como máximo `concurrency` tareas a la vez.
 * Acepta iterables asíncronos, así se pueden recorrer miles de tenants página por página.
 */
export async function forEachConcurrent<T>(
  items: Iterable<T> | AsyncIterable<T>,
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be an integer >= 1');
  }
  const iterator =
    Symbol.asyncIterator in items
      ? (items as AsyncIterable<T>)[Symbol.asyncIterator]()
      : (items as Iterable<T>)[Symbol.iterator]();

  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const next = await iterator.next();
      if (next.done) return;
      try {
        await fn(next.value);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
