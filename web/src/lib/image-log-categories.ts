export function addCategoryIds(existing: readonly string[] = [], toAdd: readonly string[] = []): string[] {
    return Array.from(new Set([...existing, ...toAdd].filter(Boolean)));
}

export function resolveCategoryByName<T extends { name: string }>(categories: readonly T[], name: string): T | undefined {
    const trimmed = name.trim();
    return trimmed ? categories.find((category) => category.name.trim() === trimmed) : undefined;
}
