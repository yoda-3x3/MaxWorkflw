"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { chatErrorMessage, sendChat, useChat, type ChatMessage } from "./chatApi";

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const chat = useChat(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Set when the last message went to the cloud runner because the PC is offline.
  const [cloudNote, setCloudNote] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const messages = chat.data?.messages ?? [];
  const pendingCount = chat.data?.pending.length ?? 0;
  const runnerOffline = chat.data?.runner.online === false;

  // Keep the newest message in view as replies arrive.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, pendingCount]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    setCloudNote(null);
    try {
      const res = await sendChat(text);
      setDraft("");
      if (res.placement === "cloud") {
        setCloudNote(
          res.cloudError
            ? `PC runner offline; sent to the cloud runner, but: ${res.cloudError}`
            : "PC runner offline; sent to the cloud runner.",
        );
      }
      chat.refresh();
    } catch (err) {
      setSendError(chatErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send();
  }

  // Enter sends; Shift+Enter inserts a newline.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <aside className="chat-panel" aria-label="Chat">
      <header className="chat-header">
        <h2>Chat</h2>
        <button type="button" onClick={onClose} aria-label="Close chat">
          ×
        </button>
      </header>

      {runnerOffline && (
        <div role="alert" className="chat-notice">
          <strong>PC runner offline.</strong> Messages go to the cloud runner until it is back.
        </div>
      )}

      {chat.error && !chat.data && (
        <p className="form-error">Could not load chat: {chat.error}</p>
      )}

      <div className="chat-messages" ref={listRef} aria-live="polite">
        {!chat.data && !chat.error && <p className="chat-empty">Loading…</p>}
        {chat.data && messages.length === 0 && (
          <p className="chat-empty">No messages yet. Say something to the team.</p>
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} message={m} />
        ))}
        {pendingCount > 0 && (
          <div className="chat-bubble chat-bubble-assistant chat-typing" role="status">
            <span className="chat-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="chat-typing-label">Thinking…</span>
          </div>
        )}
      </div>

      {cloudNote && <p className="chat-notice-note">{cloudNote}</p>}
      {sendError && <p className="form-error">{sendError}</p>}

      <form className="chat-input" onSubmit={onSubmit}>
        <textarea
          aria-label="Message"
          placeholder="Message the team (Enter to send, Shift+Enter for a new line)"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
        />
        <button type="submit" disabled={sending || !draft.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </aside>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={`chat-bubble chat-bubble-${message.role}${message.error ? " chat-bubble-error" : ""}`}>
      <div className="chat-text">{message.text}</div>
      {message.error && <div className="chat-error-tag">Failed: {message.error}</div>}
      <time className="chat-time" dateTime={new Date(message.createdAt).toISOString()}>
        {time}
      </time>
    </div>
  );
}
