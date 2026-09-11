export class StorageSyncDeduper<T> {
    private readonly requests = new Map<string, Promise<T | null>>();

    run(key: string, execute: () => Promise<T | null>, keepSuccess: boolean) {
        const existing = this.requests.get(key);
        if (existing) return existing;
        const request = execute();
        this.requests.set(key, request);
        void request.then(
            (result) => {
                if ((!result || !keepSuccess) && this.requests.get(key) === request) this.requests.delete(key);
            },
            () => {
                if (this.requests.get(key) === request) this.requests.delete(key);
            },
        );
        return request;
    }

    clear() {
        this.requests.clear();
    }

    deleteResult(matches: (result: T) => boolean) {
        for (const [key, request] of this.requests) {
            void request.then((result) => {
                if (result && matches(result) && this.requests.get(key) === request) this.requests.delete(key);
            }, () => undefined);
        }
    }
}
