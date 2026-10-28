"use client";

import { useEffect, useState } from "react";

export const CHAT_POLL_MS = 2000;

// Mirrors ChatMessage in lib/types.ts (owned by the chat backend worker).
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  runId?: string;
  /** Assistant messages: the user message this answers. */
  replyTo?: string;
  /** Set when the reply failed; `text` says why. */
  error?: string;
  model?: string;
  createdAt: number;
}

export interface ChatResponse {
  /** Last 200 messages, oldest first. */
  messages: ChatMessage[];
  /** User message ids that have no reply yet. Empty means nothing to poll for. */
  pending: string[];
  runner: { online: boolean };
}

export interface SendChatResponse {
  message: ChatMessage;
  /** "pc" when the PC runner took it; "cloud" when it is offline and the cloud runner was started. */
  placement: "pc" | "cloud";
  cloudError?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export function chatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getChat(): Promise<ChatResponse> {
  return request("/api/chat");
}

/** Stores the user's message. The reply arrives later as an assistant message with `replyTo` set. */
export function sendChat(text: string): Promise<SendChatResponse> {
  return request("/api/chat", { method: "POST", body: JSON.stringify({ text }) });
}

/**
 * Loads the chat history and keeps polling while the server reports pending user messages.
 * Polling stops on its own once `pending` is empty; `refresh` forces an immediate load and
 * restarts polling (call it after sending).
 */
export function useChat(enabled: boolean) {
  const [data, setData] = useState<ChatResponse | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only a load that saw a pending message keeps retrying after an error, so a signed-out
    // or broken API doesn't poll forever.
    let waiting = false;

    const tick = async () => {
      try {
        const next = await getChat();
        if (cancelled) return;
        setData(next);
        setError(null);
        waiting = next.pending.length > 0;
      } catch (err) {
        if (cancelled) return;
        setError(chatErrorMessage(err));
      }
      if (!cancelled && waiting) timer = setTimeout(tick, CHAT_POLL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, loadTick]);

  return {
    data,
    error,
    refresh: () => setLoadTick((n) => n + 1),
  };
}
