import { useEffect, useRef, useState } from 'react'
import { roomSyncClient, type ChatMessage } from '../networking/roomSyncClient'

type Props = {
  selfSocketId: string | null
  onNewMessage?: () => void
}

const MAX_MESSAGES = 100

export function ChatPanel({ selfSocketId, onNewMessage }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const onNewMessageRef = useRef(onNewMessage)
  onNewMessageRef.current = onNewMessage

  useEffect(() => {
    return roomSyncClient.subscribeChatMessages((msg) => {
      setMessages((prev) => {
        const next = [...prev, msg]
        return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next
      })
      onNewMessageRef.current?.()
    })
  }, [])

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages])

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    setInput('')
    try {
      await roomSyncClient.sendChatMessage(text)
    } catch {
      // message failed — re-populate input so user can retry
      setInput(text)
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  function formatTime(ts: number) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <section className="chat-panel" aria-label="Chat">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Chat</p>
          <h2>Room</h2>
        </div>
      </div>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 ? (
          <p className="chat-empty">No messages yet</p>
        ) : (
          messages.map((msg, i) => {
            const isSelf = msg.senderId === selfSocketId
            return (
              <div
                key={`${msg.senderId}-${msg.ts}-${i}`}
                className={['chat-message', isSelf ? 'chat-message--self' : ''].filter(Boolean).join(' ')}
              >
                <span className="chat-meta">
                  <strong className="chat-username">{isSelf ? 'You' : msg.username}</strong>
                  <span className="chat-time">{formatTime(msg.ts)}</span>
                </span>
                <span className="chat-text">{msg.text}</span>
              </div>
            )
          })
        )}
      </div>

      <div className="chat-input-row">
        <input
          className="chat-input"
          type="text"
          placeholder="Message…"
          maxLength={500}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
          aria-label="Chat message"
        />
        <button
          type="button"
          className="ghost-action ghost-action--sm chat-send-btn"
          onClick={() => void send()}
          disabled={sending || !input.trim()}
          aria-label="Send message"
        >
          Send
        </button>
      </div>
    </section>
  )
}
