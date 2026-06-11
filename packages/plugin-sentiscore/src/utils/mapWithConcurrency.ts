/**
 * Run async tasks over items with at most `limit` in flight at once.
 */
export async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (!items.length) return [];
    const concurrency = Math.max(1, Math.floor(limit));
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        for (;;) {
            const i = nextIndex++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker()
    );
    await Promise.all(workers);
    return results;
}
