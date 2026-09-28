export type ModelCreditCost = { channelId: string; model: string; credits: number };
export type ModelCreditQuote = { min: number; max: number };

function costKey(channelId: string, model: string) {
    return JSON.stringify([channelId, model]);
}

export function indexModelCredits(costs: readonly ModelCreditCost[] = []) {
    return new Map<string, number>(costs.filter((cost) => cost.channelId).map((cost) => [costKey(cost.channelId, cost.model), cost.credits]));
}

export function requestCreditQuote(options: {
    channelMode: string;
    costIndex: ReadonlyMap<string, number>;
    channels: readonly { id?: string; models?: string[]; enabled?: boolean }[];
    channelId?: string;
    model: string;
    count?: string | number;
}): ModelCreditQuote {
    if (options.channelMode !== "remote") return { min: 0, max: 0 };
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(options.count)) || 1)));
    const isWorkflow = options.model.startsWith("workflow:");
    const available = options.channels.filter((channel) => channel.enabled !== false && channel.id && (isWorkflow ? channel.id === options.channelId : channel.models?.includes(options.model)));
    const selected = available.find((channel) => channel.id === options.channelId);
    const prices = (selected ? [selected] : available).map((channel) => (options.costIndex.get(costKey(channel.id || "", options.model)) ?? 0) * count);
    return prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : { min: 0, max: 0 };
}

export function formatCreditQuote(quote: ModelCreditQuote) {
    return quote.min === quote.max ? quote.min.toLocaleString() : `${quote.min.toLocaleString()}–${quote.max.toLocaleString()}`;
}
