type NativeBootstrapResult = {
  status:
    | "disabled"
    | "enabled"
    | "existing"
    | "manual_required"
    | "paired"
    | "retrying"
    | "superseded";
  code?: string;
};

export function createNativeBootstrapController(params: {
  chromeApi?: unknown;
  getPairing(): Promise<{ relayUrl?: string } | null>;
  applyPairing(params: {
    pairing: { relayUrl: string; token: string; gatewayUrl?: string };
    accessMode: "all";
    source: "native";
    generation: number;
  }): Promise<{ ok?: boolean; existing?: boolean } | undefined>;
}): {
  attempt(): Promise<NativeBootstrapResult>;
  disableSynchronously(): Promise<void>;
  enable(options?: { attemptNow?: boolean }): Promise<NativeBootstrapResult>;
  status(): Promise<{ disabled: boolean; state: string; failureCode?: string }>;
};

export function requestRelayEnsure(
  relayPort: number,
  chromeApi?: unknown,
): Promise<{ status: string }>;

export function prepareRetiredCopilotState(chromeApi?: unknown): Promise<{ blocked: boolean }>;

export function discardRetiredCopilotState(chromeApi?: unknown): Promise<void>;
