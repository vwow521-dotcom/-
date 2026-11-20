export function readCodexTranscript(file: unknown, server?: string): {
  readable: boolean;
  hasToolCall: boolean;
  agent: string | null;
  drift: boolean;
  version: string | null;
};
