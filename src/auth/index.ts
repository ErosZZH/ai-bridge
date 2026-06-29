// Phase 1: Copilot auth (device-code OAuth, token exchange + refresh).
// See Backlog tasks 2-3. Stubbed for the scaffold.

export type DeviceCodePrompt = {
  userCode: string;
  verificationUri: string;
};

// Placeholder: real device-code flow lands in task 2.
export async function ensureAuth(): Promise<DeviceCodePrompt | null> {
  return null;
}
