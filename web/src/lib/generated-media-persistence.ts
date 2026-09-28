export function isStableGeneratedMediaKey(storageKey?: string) {
    return Boolean(storageKey?.startsWith("server:"));
}

export function assertGeneratedMediaOwner(currentToken: string, ownerToken: string) {
    if (!ownerToken || currentToken !== ownerToken) throw new Error("账号已切换，已忽略迟到的媒体结果");
}
