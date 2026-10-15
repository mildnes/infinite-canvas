export type GenerationCategory = { id: string; name: string; createdAt: number; updatedAt?: number };
export type DeletedGenerationCategory = { id: string; deletedAt: number };

export function mergeImageCategories<T extends GenerationCategory>(
    local: readonly T[] = [],
    remote: readonly T[] = [],
    localDeleted: readonly DeletedGenerationCategory[] = [],
    remoteDeleted: readonly DeletedGenerationCategory[] = [],
): { categories: T[]; deletedCategories: DeletedGenerationCategory[] } {
    const categories = new Map<string, T>();
    const deleted = new Map<string, DeletedGenerationCategory>();
    for (const category of [...local, ...remote]) {
        const existing = categories.get(category.id);
        if (!existing || (category.updatedAt ?? category.createdAt) > (existing.updatedAt ?? existing.createdAt)) {
            categories.set(category.id, category);
        }
    }
    for (const tombstone of [...localDeleted, ...remoteDeleted]) {
        if (tombstone.deletedAt > (deleted.get(tombstone.id)?.deletedAt ?? -Infinity)) deleted.set(tombstone.id, tombstone);
    }
    return {
        categories: [...categories.values()]
            .filter((category) => (deleted.get(category.id)?.deletedAt ?? -Infinity) < (category.updatedAt ?? category.createdAt))
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
        deletedCategories: [...deleted.values()].sort((a, b) => a.deletedAt - b.deletedAt || a.id.localeCompare(b.id)),
    };
}

export function addCategoryIds(existing: readonly string[] = [], toAdd: readonly string[] = []): string[] {
    return Array.from(new Set([...existing, ...toAdd].filter(Boolean)));
}

export function resolveCategoryByName<T extends { name: string }>(categories: readonly T[], name: string): T | undefined {
    const trimmed = name.trim();
    return trimmed ? categories.find((category) => category.name.trim() === trimmed) : undefined;
}
