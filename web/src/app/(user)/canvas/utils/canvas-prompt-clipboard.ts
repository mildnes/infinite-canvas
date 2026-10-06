import { parsePromptTokens } from "../components/canvas-prompt-chip-tokens";

type ReferenceSyntax = "label" | "node";
type ClipboardEventLike = { clipboardData: { setData: (type: string, value: string) => void }; preventDefault: () => void };

export function serializeCanvasPromptNodes(nodes: NodeListOf<ChildNode>, syntax: ReferenceSyntax, state = { text: "", emptyLine: true, pendingBr: false }, group = { hasContent: false, afterBlock: false }): string {
    // 延后 BR，块边界负责换行，避免浏览器行末占位 BR 多出一行。
    nodes.forEach((node) => {
        const element = node.nodeType === 1 ? node as HTMLElement : null;
        const reference = syntax === "label" ? element?.dataset.refLabel : element?.dataset.referenceNodeId ? `@[node:${element.dataset.referenceNodeId}]` : undefined;
        const text = node.nodeType === 3 ? node.textContent || "" : reference;
        const block = !reference && (element?.tagName === "DIV" || element?.tagName === "P");
        const br = element?.tagName === "BR";
        if (!text && !block && !br) {
            if (element) serializeCanvasPromptNodes(element.childNodes, syntax, state, group);
            return;
        }
        if (block || group.afterBlock) {
            if (group.hasContent && (state.emptyLine || !state.text.endsWith("\n"))) state.text += "\n";
            state.pendingBr = false;
            state.emptyLine = true;
            group.afterBlock = false;
        }
        if (block) {
            serializeCanvasPromptNodes(element!.childNodes, syntax, state);
            state.pendingBr = false;
            group.afterBlock = true;
        } else {
            if (state.pendingBr) { state.text += "\n"; state.emptyLine = true; }
            state.pendingBr = br;
            if (text) { state.text += text; state.emptyLine = false; }
        }
        group.hasContent = true;
    });
    return state.text.replace(/\uFEFF/g, "");
}

export function copyCanvasPromptSelection(editor: HTMLElement | null, event: ClipboardEventLike, syntax: ReferenceSyntax, cut = false): boolean {
    const selection = editor?.ownerDocument.defaultView?.getSelection();
    if (!editor || !selection?.rangeCount || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;
    const text = serializeCanvasPromptNodes(range.cloneContents().childNodes, syntax);
    if (!text) return false;
    event.clipboardData.setData("text/plain", text);
    // 有意仅复制纯文本；阻止浏览器以图片 alt 或 text/html 覆盖引用标记。
    event.preventDefault();
    if (cut) {
        range.deleteContents();
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }
    return true;
}

export function canvasPromptFragment(document: Document, text: string, syntax: ReferenceSyntax, resolveChip: (key: string) => HTMLElement | undefined, labels: string[] = []): DocumentFragment {
    const tokens = syntax === "label"
        ? parsePromptTokens(text, labels).map((token) => token.type === "text" ? { text: token.value } : { text: token.label, key: token.label.replace(/^@/, "") })
        : text.split(/(@\[node:[^\]]+\])/g).filter(Boolean).map((part) => ({ text: part, key: /^@\[node:([^\]]+)\]$/.exec(part)?.[1] }));
    const fragment = document.createDocumentFragment();
    for (const token of tokens) {
        const chip = "key" in token && token.key ? resolveChip(token.key) : undefined;
        if (chip && syntax === "label") chip.dataset.refLabel = token.text;
        fragment.append(chip || document.createTextNode(token.text));
    }
    return fragment;
}

export function insertCanvasPromptFragment(editor: HTMLElement | null, fragment: DocumentFragment): boolean {
    const selection = editor?.ownerDocument.defaultView?.getSelection();
    if (!editor || !selection?.rangeCount || !fragment.lastChild) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;
    const last = fragment.lastChild;
    range.deleteContents();
    range.insertNode(fragment);
    range.setStartAfter(last);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}
