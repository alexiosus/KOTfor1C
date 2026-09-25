export function createDeferredLoader<T>(factory: () => Promise<T>): () => Promise<T> {
    let loading: Promise<T> | null = null;

    return () => {
        if (loading) {
            return loading;
        }

        const attempt = Promise.resolve().then(factory);
        loading = attempt;
        void attempt.catch(() => {
            if (loading === attempt) {
                loading = null;
            }
        });
        return attempt;
    };
}

export function createDeferredResourceLoader<T>(
    factory: () => Promise<T>,
    register: (resource: T) => void
): () => Promise<T> {
    return createDeferredLoader(async () => {
        const resource = await factory();
        register(resource);
        return resource;
    });
}
