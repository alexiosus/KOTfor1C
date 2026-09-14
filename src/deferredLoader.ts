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
