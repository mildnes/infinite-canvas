"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createCanvasWriterLock, type CanvasWriterLock, type CanvasWriterStatus } from "../utils/canvas-writer-lock";

export function useCanvasWriterLock(ownerId: string, projectId: string, onReacquired: () => void, beforeRelease: () => void | Promise<void>) {
    const lockRef = useRef<CanvasWriterLock | null>(null);
    const callbackRef = useRef(onReacquired);
    callbackRef.current = onReacquired;
    const releaseRef = useRef(beforeRelease);
    releaseRef.current = beforeRelease;
    const [state, setState] = useState<{ ownerId: string; projectId: string; status: CanvasWriterStatus }>({
        ownerId, projectId, status: "pending",
    });
    useLayoutEffect(() => {
        let wasReader = false;
        lockRef.current = createCanvasWriterLock(ownerId, projectId, (status) => {
            if (status === "reader" || status === "pending") wasReader = true;
            if ((status === "writer" || status === "uncoordinated") && wasReader) {
                wasReader = false;
                lockRef.current?.setReady(false);
                callbackRef.current();
            }
            setState({ ownerId, projectId, status });
        }, () => releaseRef.current());
        return () => { lockRef.current?.dispose(); lockRef.current = null; };
    }, [ownerId, projectId]);
    const canWrite = useCallback(() => lockRef.current?.canWrite() === true, []);
    const takeOver = useCallback(() => lockRef.current?.takeOver(), []);
    const resume = useCallback(() => lockRef.current?.setReady(true), []);
    return { status: state.ownerId === ownerId && state.projectId === projectId ? state.status : "pending", canWrite, takeOver, resume };
}
