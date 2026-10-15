import localforage from "localforage";
import { mergeImageCategories, type DeletedGenerationCategory, type GenerationCategory } from "@/lib/image-log-categories";
import { fetchUserImageCategories, syncUserImageCategories, type UserImageCategories } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";

const CATEGORY_STORE_KEY = "infinite-canvas:image_generation_categories";
const DELETED_CATEGORY_STORE_KEY = "infinite-canvas:image_generation_deleted_categories";
const LEGACY_OWNER_KEY = "infinite-canvas:image_generation_categories:legacy-owner";
const categoryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_categories" });
let storageQueue = Promise.resolve();
let syncQueue = Promise.resolve();

function categoryOwner() {
    const { token, user } = useUserStore.getState();
    return token ? user?.id || null : "anon";
}

function localKeys(owner: string) {
    const suffix = owner === "anon" ? "" : `:${owner}`;
    return [CATEGORY_STORE_KEY + suffix, DELETED_CATEGORY_STORE_KEY + suffix];
}

async function readForOwner(owner: string | null): Promise<UserImageCategories> {
    if (!owner || owner !== categoryOwner()) return { categories: [], deletedCategories: [] };
    const [categoryKey, deletedKey] = localKeys(owner);
    const [categories, deletedCategories, legacyOwner] = await Promise.all([
        categoryStore.getItem<GenerationCategory[]>(categoryKey),
        categoryStore.getItem<DeletedGenerationCategory[]>(deletedKey),
        owner === "anon" ? Promise.resolve("anon") : categoryStore.getItem<string>(LEGACY_OWNER_KEY),
    ]);
    let state = mergeImageCategories(
        Array.isArray(categories) ? categories.filter((category) => category.id && category.name) : [],
        [],
        Array.isArray(deletedCategories) ? deletedCategories.filter((category) => category.id && Number.isFinite(category.deletedAt)) : [],
        [],
    );
    // 旧公共数组仅交给首次登录同步的账号，原数据保留；后续账号只读取自己的副本。
    if (!legacyOwner && owner === categoryOwner()) {
        const [legacyCategories, legacyDeleted] = await Promise.all([
            categoryStore.getItem<GenerationCategory[]>(CATEGORY_STORE_KEY),
            categoryStore.getItem<DeletedGenerationCategory[]>(DELETED_CATEGORY_STORE_KEY),
        ]);
        if (owner !== categoryOwner()) return { categories: [], deletedCategories: [] };
        state = mergeImageCategories(state.categories, Array.isArray(legacyCategories) ? legacyCategories : [], state.deletedCategories, Array.isArray(legacyDeleted) ? legacyDeleted : []);
        await Promise.all([
            categoryStore.setItem(categoryKey, state.categories),
            categoryStore.setItem(deletedKey, state.deletedCategories),
        ]);
        await categoryStore.setItem(LEGACY_OWNER_KEY, owner);
    }
    return state;
}

function queueStorage<T>(action: () => Promise<T>): Promise<T> {
    const result = storageQueue.then(action);
    storageQueue = result.then(() => {}, () => {});
    return result;
}

export function readStoredImageCategories(): Promise<UserImageCategories> {
    const owner = categoryOwner();
    return queueStorage(() => readForOwner(owner));
}

export function sameImageCategoryState(a: UserImageCategories, b: UserImageCategories) {
    const canonical = (state: UserImageCategories) => mergeImageCategories(state.categories, [], state.deletedCategories, []);
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function writeStoredImageCategories(state: UserImageCategories): Promise<UserImageCategories> {
    const owner = categoryOwner();
    return queueStorage(async () => {
        const local = await readForOwner(owner);
        if (!owner || categoryOwner() !== owner) return local;
        const [categoryKey, deletedKey] = localKeys(owner);
        const merged = mergeImageCategories(local.categories, state.categories, local.deletedCategories, state.deletedCategories);
        await Promise.all([
            categoryStore.setItem(categoryKey, merged.categories),
            categoryStore.setItem(deletedKey, merged.deletedCategories),
        ]);
        return merged;
    });
}

export function syncStoredImageCategories(token: string, state: UserImageCategories): Promise<UserImageCategories> {
    const owner = categoryOwner();
    const isOwner = () => owner && categoryOwner() === owner && (!token || useUserStore.getState().token === token);
    const sync = syncQueue.then(async () => {
        if (!isOwner()) return readStoredImageCategories();
        const local = await writeStoredImageCategories(state);
        if (!token || !isOwner()) return local;
        const remote = await fetchUserImageCategories(token);
        if (!isOwner()) return local;
        const merged = await writeStoredImageCategories(mergeImageCategories(
            local.categories, remote.categories, local.deletedCategories, remote.deletedCategories,
        ));
        if (isOwner() && !sameImageCategoryState(merged, remote)) {
            await syncUserImageCategories(token, merged);
            if (!isOwner()) return merged;
            const saved = await fetchUserImageCategories(token);
            if (!isOwner()) return merged;
            return writeStoredImageCategories(mergeImageCategories(merged.categories, saved.categories, merged.deletedCategories, saved.deletedCategories));
        }
        return merged;
    });
    syncQueue = sync.then(() => {}, () => {});
    return sync;
}
