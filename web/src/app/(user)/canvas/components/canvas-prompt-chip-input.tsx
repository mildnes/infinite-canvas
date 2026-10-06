"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Image } from "antd";
import { FileText, Image as ImageIcon, Music2, Sparkles, Video } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasAgentSkillReference } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { parsePromptTokens } from "./canvas-prompt-chip-tokens";
import { canvasPromptFragment, copyCanvasPromptSelection, insertCanvasPromptFragment, serializeCanvasPromptNodes } from "../utils/canvas-prompt-clipboard";

type CanvasPromptChipInputProps = {
    value: string;
    references?: CanvasResourceReference[];
    pendingReferences?: CanvasResourceReference[];
    onReferenceIdsChange?: (nodeIds: string[]) => void;
    skills?: CanvasAgentSkillReference[];
    onSelectSkill?: (skill: CanvasAgentSkillReference) => void;
    onChange: (value: string) => void;
    onSubmit?: (value?: string, referenceIds?: string[]) => void;
    onPasteImage?: (file: File) => void;
    className?: string;
    style?: CSSProperties;
    placeholder?: string;
};

type MentionState = {
    query: string;
    rect: DOMRect | null;
};

export function CanvasPromptChipInput({ value, references = [], pendingReferences = [], onReferenceIdsChange, skills = [], onSelectSkill, onChange, onSubmit, onPasteImage, className, style, placeholder }: CanvasPromptChipInputProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const editorRef = useRef<HTMLDivElement>(null);
    const caretRangeRef = useRef<Range | null>(null);
    const composingRef = useRef(false);
    const lastEmittedRef = useRef(value);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [skillMention, setSkillMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const activeReferences = useMemo(() => references.filter((reference) => reference.active), [references]);
    const referenceByLabel = useMemo(() => new Map(activeReferences.map((reference) => [reference.label, reference])), [activeReferences]);
    const activeLabels = useMemo(() => Array.from(new Set(activeReferences.map((reference) => reference.label))).sort((left, right) => right.length - left.length), [activeReferences]);
    const tokens = useMemo(() => parsePromptTokens(value, activeLabels), [activeLabels, value]);
    const candidates = useMemo(() => {
        if (!mention) return [];
        const query = mention.query.trim().toLowerCase();
        if (!query) return activeReferences;
        return activeReferences.filter((reference) => `${reference.label} ${reference.title} ${reference.kind} ${reference.text || ""}`.toLowerCase().includes(query));
    }, [activeReferences, mention]);
    const skillCandidates = useMemo(() => {
        if (!skillMention) return [];
        const query = skillMention.query.trim().toLowerCase();
        if (!query) return skills;
        return skills.filter((skill) => `${skill.name} ${skill.description || ""}`.toLowerCase().includes(query));
    }, [skillMention, skills]);

    useLayoutEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        if (document.activeElement === editor && value === lastEmittedRef.current) return;
        editor.textContent = "";
        tokens.forEach((token) => {
            if (token.type === "text") {
                editor.append(document.createTextNode(token.value));
                return;
            }
            const reference = referenceByLabel.get(token.label.replace(/^@/, ""));
            if (reference) { const chip = createReferenceChip(reference, theme, setImagePreview); chip.dataset.refLabel = token.label; editor.append(chip); }
            else editor.append(document.createTextNode(token.label));
        });
        lastEmittedRef.current = value;
    }, [referenceByLabel, theme, tokens, value]);

    useLayoutEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.querySelectorAll<HTMLElement>("[data-pending-reference='true']").forEach(removeReferenceChip);
        pendingReferences?.forEach((reference) => appendReferenceChip(editor, reference, theme, setImagePreview, true, caretRangeRef.current));
    }, [pendingReferences, theme]);

    const emitChange = (nextValue: string) => {
        lastEmittedRef.current = nextValue;
        onChange(nextValue);
        if (editorRef.current) onReferenceIdsChange?.(referenceIdsFromEditor(editorRef.current));
    };

    const commitPendingReferences = () => {
        const editor = editorRef.current;
        const pendingChips = editor?.querySelectorAll<HTMLElement>("[data-pending-reference='true']");
        pendingChips?.forEach((chip) => delete chip.dataset.pendingReference);
        const nextValue = editor ? serializePromptEditor(editor) : value;
        const referenceIds = editor ? referenceIdsFromEditor(editor) : [];
        if (pendingChips?.length) emitChange(nextValue);
        return { value: nextValue, referenceIds };
    };

    const closeMention = () => {
        setMention(null);
        setActiveIndex(0);
    };

    const closeSkillMention = () => {
        setSkillMention(null);
        setActiveIndex(0);
    };

    const syncMention = () => {
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range?.collapsed && editorRef.current?.contains(range.startContainer)) caretRangeRef.current = range.cloneRange();
        const text = textBeforeCaret();
        const match = /@([^\s@]*)$/.exec(text);
        if (!match || !activeReferences.length) {
            closeMention();
            return;
        }
        setMention({
            query: match[1] || "",
            rect: getCaretRect(),
        });
        setActiveIndex(0);
    };

    const syncSkillMention = () => {
        const text = textBeforeCaret();
        const match = /\/([^\s/]*)$/.exec(text);
        if (!match || !skills.length) {
            closeSkillMention();
            return;
        }
        setSkillMention({ query: match[1] || "", rect: getCaretRect() });
        setActiveIndex(0);
    };

    const syncFromEditor = () => {
        const editor = editorRef.current;
        if (!editor) return;
        emitChange(serializePromptEditor(editor));
        syncMention();
        syncSkillMention();
    };

    const insertReference = (reference: CanvasResourceReference) => {
        const editor = editorRef.current;
        if (!editor) return;
        removeActiveMention();
        const leadingSpace = document.createTextNode(" ");
        const chip = createReferenceChip(reference, theme, setImagePreview);
        const trailingSpace = document.createTextNode(" ");
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : caretRangeRef.current;
        if (range) {
            range.insertNode(trailingSpace);
            range.insertNode(chip);
            range.insertNode(leadingSpace);
            range.setStartAfter(trailingSpace);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
            caretRangeRef.current = range.cloneRange();
        } else {
            editor.append(leadingSpace, chip, trailingSpace);
            placeCaretAtEnd(editor);
        }
        closeMention();
        emitChange(serializePromptEditor(editor));
    };

    const insertSkill = (skill: CanvasAgentSkillReference) => {
        removeActiveSkillMention();
        closeSkillMention();
        emitChange(serializePromptEditor(editorRef.current!));
        onSelectSkill?.(skill);
    };

    const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => copyCanvasPromptSelection(editorRef.current, event, "label");
    const handleCut = (event: ClipboardEvent<HTMLDivElement>) => {
        if (copyCanvasPromptSelection(editorRef.current, event, "label", true)) syncFromEditor();
    };

    const showPlaceholder = !value.trim() && !pendingReferences?.length;

    return (
        <div className="relative w-full">
            {showPlaceholder && placeholder ? (
                <div className="pointer-events-none absolute left-3 top-2 text-sm leading-5" style={{ color: theme.node.placeholder }}>
                    {placeholder}
                </div>
            ) : null}

            <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-multiline="true"
                aria-label={placeholder}
                className={`${className || ""} overflow-y-auto whitespace-pre-wrap break-words outline-none`}
                style={{ ...style, cursor: "text" }}
                onFocus={commitPendingReferences}
                onPointerDown={commitPendingReferences}
                onInput={(event) => {
                    if (composingRef.current) return;
                    const selection = window.getSelection();
                    const node = selection?.anchorNode;
                    // 浏览器在末行光标前保留的独立换行节点只是占位。
                    if (selection?.isCollapsed && selection.anchorOffset === 0 && node instanceof Text && node.data === "\n" && node === event.currentTarget.lastChild) node.data = "\uFEFF";
                    syncFromEditor();
                }}
                onPaste={(event) => {
                    const imageFile = Array.from(event.clipboardData.files || []).find((item) => item.type.startsWith("image/"));
                    if (imageFile && onPasteImage) {
                        event.preventDefault();
                        onPasteImage(imageFile);
                        return;
                    }
                    const text = event.clipboardData.getData("text/plain");
                    if (!text) return;

                    event.preventDefault();

                    const fragment = canvasPromptFragment(document, text, "label", (label) => {
                        const reference = referenceByLabel.get(label);
                        return reference ? createReferenceChip(reference, theme, setImagePreview) : undefined;
                    }, activeLabels);
                    if (insertCanvasPromptFragment(editorRef.current, fragment)) syncFromEditor();
                }}
                onCopy={handleCopy}
                onCut={handleCut}
                onCompositionStart={() => {
                    composingRef.current = true;
                }}
                onCompositionEnd={() => {
                    composingRef.current = false;
                    syncFromEditor();
                }}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                    event.stopPropagation();

                    const committed = commitPendingReferences();

                    const nativeEvent = event.nativeEvent;
                    const isComposing = composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
                    if (isComposing) return;

                    if (skillMention && skillCandidates.length) {
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            setActiveIndex((index) => (index + 1) % skillCandidates.length);
                            return;
                        }
                        if (event.key === "ArrowUp") {
                            event.preventDefault();
                            setActiveIndex((index) => (index - 1 + skillCandidates.length) % skillCandidates.length);
                            return;
                        }
                        if (event.key === "Enter") {
                            event.preventDefault();
                            insertSkill(skillCandidates[Math.min(activeIndex, skillCandidates.length - 1)]);
                            return;
                        }
                        if (event.key === "Escape") {
                            event.preventDefault();
                            closeSkillMention();
                            return;
                        }
                    }

                    if (mention && candidates.length) {
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            setActiveIndex((index) => (index + 1) % candidates.length);
                            return;
                        }

                        if (event.key === "ArrowUp") {
                            event.preventDefault();
                            setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
                            return;
                        }

                        if (event.key === "Enter") {
                            event.preventDefault();
                            insertReference(candidates[Math.min(activeIndex, candidates.length - 1)]);
                            return;
                        }

                        if (event.key === "Escape") {
                            event.preventDefault();
                            closeMention();
                            return;
                        }
                    }

                    if ((event.key === "Backspace" || event.key === "Delete") && deleteAdjacentReference(event.key)) {
                        event.preventDefault();
                        requestAnimationFrame(syncFromEditor);
                        return;
                    }

                    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && onSubmit) {
                        event.preventDefault();
                        onSubmit(committed.value, committed.referenceIds);
                        return;
                    }

                    requestAnimationFrame(() => {
                        syncMention();
                        syncSkillMention();
                    });
                }}
                onPointerUp={() => {
                    requestAnimationFrame(() => {
                        syncMention();
                        syncSkillMention();
                    });
                }}
                onBlur={() => {
                    window.setTimeout(() => {
                        closeMention();
                        closeSkillMention();
                    }, 120);
                }}
            />

            {mention && candidates.length ? <MentionMenu rect={mention.rect} references={candidates} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertReference} /> : null}
            {skillMention && skillCandidates.length ? <SkillMenu rect={skillMention.rect} skills={skillCandidates} activeIndex={Math.min(activeIndex, skillCandidates.length - 1)} theme={theme} onSelect={insertSkill} /> : null}

            {imagePreview ? (
                <Image
                    src={imagePreview}
                    alt="引用图片预览"
                    style={{ display: "none" }}
                    preview={{
                        visible: true,
                        src: imagePreview,
                        onVisibleChange: (visible) => {
                            if (!visible) setImagePreview(null);
                        },
                    }}
                />
            ) : null}
        </div>
    );
}

function MentionMenu({
    rect,
    references,
    activeIndex,
    theme,
    onSelect,
}: {
    rect: DOMRect | null;
    references: CanvasResourceReference[];
    activeIndex: number;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onSelect: (reference: CanvasResourceReference) => void;
}) {
    const selectedRef = useRef(false);
    const activeItemRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        activeItemRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, references]);

    const selectReference = (reference: CanvasResourceReference) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(reference);
    };
    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => {
        event.stopPropagation();
    };
    const menuWidth = 256;
    const maxMenuHeight = 224;
    const menuHeight = Math.min(maxMenuHeight, references.length * 48 + 8);
    const gap = 6;
    const anchor = rect || new DOMRect(16, 16, 0, 0);
    const left = clamp(anchor.left, 8, window.innerWidth - menuWidth - 8);
    const showAbove = anchor.bottom + gap + menuHeight > window.innerHeight && anchor.top - gap - menuHeight >= 8;
    const top = clamp(showAbove ? anchor.top - gap - menuHeight : anchor.bottom + gap, 8, window.innerHeight - menuHeight - 8);

    return createPortal(
        <div
            data-canvas-resource-mention-menu="true"
            className="fixed z-[120] max-h-56 w-64 overflow-y-auto rounded-xl border p-1 shadow-2xl backdrop-blur-md"
            style={{
                left,
                top,
                background: theme.toolbar.panel,
                borderColor: theme.toolbar.border,
                color: theme.node.text,
            }}
            onPointerDown={stopCanvasInteraction}
            onMouseDown={stopCanvasInteraction}
            onClick={(event) => {
                event.stopPropagation();
            }}
        >
            {references.map((reference, index) => (
                <button
                    key={reference.id}
                    ref={index === activeIndex ? activeItemRef : undefined}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                    style={{
                        background: index === activeIndex ? theme.toolbar.activeBg : "transparent",
                        color: index === activeIndex ? theme.toolbar.activeText : theme.node.text,
                    }}
                    onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectReference(reference);
                    }}
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectReference(reference);
                    }}
                >
                    <ReferencePreview reference={reference} />

                    <span className="min-w-0 flex-1">
                        <span className="block font-medium">{reference.label}</span>
                        <span className="block truncate opacity-65">{reference.text || reference.title}</span>
                    </span>
                </button>
            ))}
        </div>,
        document.body,
    );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) {
        return <img src={reference.previewUrl} alt="" className="size-9 shrink-0 rounded-md object-cover" />;
    }
    if (reference.kind === "video" && reference.previewUrl) {
        return <video src={reference.previewUrl} className="size-9 shrink-0 rounded-md bg-black object-cover" muted preload="metadata" />;
    }
    const Icon = reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
            <Icon className="size-4" />
        </span>
    );
}

function createReferenceChip(reference: CanvasResourceReference, theme: (typeof canvasThemes)[keyof typeof canvasThemes], onImagePreview: (url: string) => void) {
    const wrapper = document.createElement("span");
    wrapper.contentEditable = "false";
    wrapper.dataset.refLabel = reference.label;
    wrapper.dataset.refNodeId = reference.nodeId;
    if (reference.kind === "image" && reference.previewUrl) {
        const image = document.createElement("img");
        image.src = reference.previewUrl;
        image.alt = reference.label;
        image.className = "size-6 rounded object-cover";
        wrapper.className = "mx-px inline-flex size-6 items-center justify-center overflow-hidden rounded align-middle";
        wrapper.appendChild(image);
        wrapper.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onImagePreview(reference.previewUrl || "");
        });
        return wrapper;
    }

    wrapper.className = "mx-px inline-flex h-6 max-w-40 items-center justify-center overflow-hidden rounded-md border px-1 text-xs leading-none align-middle";
    wrapper.style.background = theme.toolbar.panel;
    wrapper.style.borderColor = theme.node.stroke;
    wrapper.style.color = theme.node.text;
    wrapper.title = reference.text || reference.title;
    const text = document.createElement("span");
    text.className = "block truncate";
    text.textContent = reference.kind === "text" ? reference.text || reference.title : reference.label;
    wrapper.appendChild(text);
    return wrapper;
}

function appendReferenceChip(
    editor: HTMLElement,
    reference: CanvasResourceReference,
    theme: (typeof canvasThemes)[keyof typeof canvasThemes],
    onImagePreview: (url: string) => void,
    pending = false,
    caret?: Range | null,
) {
    const chip = createReferenceChip(reference, theme, onImagePreview);
    if (pending) chip.dataset.pendingReference = "true";
    if (caret && editor.contains(caret.startContainer)) {
        const trailingSpace = document.createTextNode(" ");
        caret.insertNode(trailingSpace);
        trailingSpace.before(" ", chip);
        caret.setStartAfter(trailingSpace);
        caret.collapse(true);
        return;
    }
    let line = editor;
    while (true) {
        let last = line.lastChild;
        while (last?.nodeType === Node.TEXT_NODE && !last.textContent) last = last.previousSibling;
        if (last instanceof HTMLElement && (last.tagName === "DIV" || last.tagName === "P")) {
            line = last;
            continue;
        }
        if (last instanceof HTMLBRElement) last.remove();
        break;
    }
    line.append(document.createTextNode(" "), chip, document.createTextNode(" "));
    editor.scrollTop = editor.scrollHeight;
}

function removeReferenceChip(chip: HTMLElement) {
    const parent = chip.parentElement;
    const previousSibling = chip.previousSibling;
    const nextSibling = chip.nextSibling;
    if (previousSibling?.nodeType === Node.TEXT_NODE) previousSibling.textContent = (previousSibling.textContent || "").replace(/[ \u00A0]$/, "");
    if (nextSibling?.nodeType === Node.TEXT_NODE) nextSibling.textContent = (nextSibling.textContent || "").replace(/^[ \u00A0]/, "");
    chip.remove();
    parent?.normalize();
}

function referenceIdsFromEditor(editor: HTMLElement) {
    return Array.from(new Set(Array.from(editor.querySelectorAll<HTMLElement>("[data-ref-node-id]"))
        .map((chip) => chip.dataset.refNodeId)
        .filter((id): id is string => Boolean(id))));
}

function serializePromptEditor(editor: HTMLElement) {
    return serializeCanvasPromptNodes(editor.childNodes, "label");
}

function removeActiveMention() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const text = textBeforeCaret();
    const match = /@([^\s@]*)$/.exec(text);
    if (!match) return;
    range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
    range.deleteContents();
}

function removeActiveSkillMention() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const text = textBeforeCaret();
    const match = /\/([^\s/]*)$/.exec(text);
    if (!match) return;
    range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
    range.deleteContents();
}

function SkillMenu({
    rect,
    skills,
    activeIndex,
    theme,
    onSelect,
}: {
    rect: DOMRect | null;
    skills: CanvasAgentSkillReference[];
    activeIndex: number;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onSelect: (skill: CanvasAgentSkillReference) => void;
}) {
    const activeItemRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        activeItemRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, skills]);
    const menuWidth = 280;
    const menuHeight = Math.min(260, skills.length * 48 + 8);
    const anchor = rect || new DOMRect(16, 16, 0, 0);
    const left = clamp(anchor.left, 8, window.innerWidth - menuWidth - 8);
    const top = clamp(anchor.bottom + 6, 8, window.innerHeight - menuHeight - 8);
    return createPortal(
        <div
            data-canvas-skill-menu="true"
            className="fixed z-[120] max-h-64 w-[280px] overflow-y-auto rounded-xl border p-1 shadow-2xl backdrop-blur-md"
            style={{ left, top, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            {skills.map((skill, index) => (
                <button
                    key={skill.id}
                    ref={index === activeIndex ? activeItemRef : undefined}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                    style={{ background: index === activeIndex ? theme.toolbar.activeBg : "transparent", color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }}
                    onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelect(skill);
                    }}
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                >
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
                        <Sparkles className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block font-medium">{skill.name}</span>
                        <span className="block truncate opacity-65">{skill.description || (skill.source === "builtin" ? "内置画布 Skill" : "后台配置 Skill")}</span>
                    </span>
                </button>
            ))}
        </div>,
        document.body,
    );
}

function deleteAdjacentReference(key: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const target = adjacentReferenceNode(range, key);
    if (!target) return false;
    target.parentNode?.normalize();
    const previousSibling = target.previousSibling;
    const nextSibling = target.nextSibling;
    if (previousSibling?.nodeType === Node.TEXT_NODE) previousSibling.textContent = (previousSibling.textContent || "").replace(/[ \u00A0]$/, "");
    if (nextSibling?.nodeType === Node.TEXT_NODE) nextSibling.textContent = (nextSibling.textContent || "").replace(/^[ \u00A0]/, "");
    const nextCaretNode = document.createTextNode("");
    target.replaceWith(nextCaretNode);
    range.setStart(nextCaretNode, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function adjacentReferenceNode(range: Range, key: string) {
    const container = range.startContainer;
    const offset = range.startOffset;
    const previous = key === "Backspace";
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
        return findReferenceSibling(container, previous);
    }
    const children = Array.from(container.childNodes);
    return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, true);
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
    let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
    while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) {
        current = previous ? current.previousSibling : current.nextSibling;
    }
    return current instanceof HTMLElement && current.dataset.refLabel ? current : null;
}

function textBeforeCaret() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return "";
    const range = selection.getRangeAt(0).cloneRange();
    const editor = closestPromptEditor(range.startContainer);
    if (!editor) return "";
    range.setStart(editor, 0);
    return range.toString();
}

function getCaretRect(): DOMRect | null {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height || rect.left || rect.top) return rect;
    const editor = closestPromptEditor(range.startContainer);
    return editor?.getBoundingClientRect() || null;
}

function closestPromptEditor(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest("[contenteditable='true']") || null;
}

function placeCaretAtEnd(element: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function clamp(value: number, min: number, max: number) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
}
