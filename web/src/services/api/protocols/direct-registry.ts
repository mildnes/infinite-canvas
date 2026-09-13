import type { DirectAIProvider } from "@/stores/use-config-store";
import { apimartDirectProtocol } from "./apimart";
import { arkDirectProtocol } from "./ark";
import { kieDirectProtocol } from "./kie";
import type { DirectProtocolAdapter } from "./types";

export const directProtocolAdapters: Readonly<Record<DirectAIProvider, DirectProtocolAdapter>> = {
    kie: kieDirectProtocol,
    apimart: apimartDirectProtocol,
    ark: arkDirectProtocol,
};
