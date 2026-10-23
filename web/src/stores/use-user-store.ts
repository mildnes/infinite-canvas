"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { AUTH_TOKEN_KEY, fetchCurrentUser, login, register, type AuthPayload, type AuthUser } from "@/services/api/auth";

type UserStore = {
    token: string;
    user: AuthUser | null;
    isReady: boolean;
    isLoading: boolean;
    setSession: (token: string, user: AuthUser) => void;
    clearSession: () => void;
    hydrateUser: () => Promise<void>;
    login: (payload: AuthPayload) => Promise<AuthUser>;
    register: (payload: AuthPayload) => Promise<AuthUser>;
};

const DEFAULT_USER_READY_TIMEOUT_MS = 10_000;

export function waitForUserReadiness(
    ready: () => boolean,
    subscribe: (listener: () => void) => () => void,
    timeoutMs = DEFAULT_USER_READY_TIMEOUT_MS,
): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
        let settled = false;
        let unsubscribe = () => {};
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            unsubscribe();
            resolve(value);
        };
        const timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs));
        unsubscribe = subscribe(() => {
            if (ready()) finish(true);
        });
        if (ready()) finish(true);
    });
}

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            setSession: (token, user) => set({ token, user, isReady: true }),
            clearSession: () => set({ token: "", user: null, isReady: true }),
            hydrateUser: async () => {
                const hydrated = await waitForUserReadiness(
                    () => useUserStore.persist.hasHydrated(),
                    (listener) => useUserStore.persist.onFinishHydration(listener),
                );
                if (!hydrated) set({ isLoading: false, isReady: true });
                const token = get().token;
                if (!token) {
                    set({ user: null, isReady: true });
                    return;
                }
                set({ isLoading: true, isReady: false });
                try {
                    const user = await fetchCurrentUser(token);
                    if (get().token !== token) return;
                    if (user.role === "guest") {
                        set({ token: "", user: null, isReady: true, isLoading: false });
                        return;
                    }
                    set({ user, isReady: true, isLoading: false });
                } catch {
                    if (get().token === token) set({ user: null, isReady: true, isLoading: false });
                }
            },
            login: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await login(payload);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
            register: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await register(payload);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
        }),
        {
            name: AUTH_TOKEN_KEY,
            partialize: (state) => ({ token: state.token }),
            onRehydrateStorage: () => (state) => {
                if (state) state.isReady = false;
            },
        },
    ),
);
