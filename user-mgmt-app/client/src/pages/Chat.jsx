import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api, { parseError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import Avatar from '../components/Avatar';

const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_VIDEO = 50 * 1024 * 1024;

const clock = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const previewOf = (m) => (!m ? 'No messages yet' : m.type === 'IMAGE' ? '📷 Photo' : m.type === 'VIDEO' ? '🎥 Video' : m.content);

function dayLabel(d) {
  const date = new Date(d);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return clock(d);
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/* ------------------------------------------------------------------ */
/* New chat: search for a person and open a conversation               */
/* ------------------------------------------------------------------ */
function NewChat({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.get('/chat/users', { params: { search: q } })
        .then((r) => alive && setPeople(r.data.data))
        .catch((e) => alive && setError(parseError(e).message));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  const pick = async (person) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/chat/conversations', { userId: person.id });
      await onPick(res.data.conversation.id);
    } catch (err) {
      setError(parseError(err).message);
      setBusy(false);
    }
  };

  return (
    <div className="newchat">
      <input autoFocus type="search" placeholder="Search people by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
      {error && <p className="error-text">{error}</p>}
      <ul className="people">
        {people.map((p) => (
          <li key={p.id}>
            <button disabled={busy} onClick={() => pick(p)}>
              <Avatar user={p} size={32} /> <span>{p.name}</span>
            </button>
          </li>
        ))}
        {people.length === 0 && <li className="muted-sm people-empty">No one found.</li>}
      </ul>
      <button className="link-btn" onClick={onClose}>Cancel</button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Composer attachment preview                                         */
/* ------------------------------------------------------------------ */
function FilePreview({ file, onClear, disabled }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  return (
    <div className="attach">
      {url && (file.type.startsWith('video/') ? <video src={url} muted /> : <img src={url} alt="" />)}
      <span className="attach-name">{file.name}</span>
      <button type="button" className="toast-x" onClick={onClear} disabled={disabled} aria-label="Remove attachment">×</button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One open conversation                                               */
/* ------------------------------------------------------------------ */
function Thread({ conversation, online }) {
  const { user } = useAuth();
  const socket = useSocket();
  const id = conversation.id;

  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(null); // null = idle, 0-100 = sending

  const bottomRef = useRef(null);
  const stick = useRef(true); // keep the view pinned to the newest message
  const typingSent = useRef(false);
  const typingTimer = useRef(null);
  const typingHide = useRef(null);

  const markRead = useCallback(() => api.post(`/chat/conversations/${id}/read`).catch(() => {}), [id]);

  const loadLatest = useCallback(async () => {
    const res = await api.get(`/chat/conversations/${id}/messages`);
    stick.current = true;
    setMessages(res.data.data);
    setHasMore(res.data.hasMore);
  }, [id]);

  // History + mark as read when the conversation opens.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadLatest()
      .then(markRead)
      .catch((e) => alive && setError(parseError(e).message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [loadLatest, markRead]);

  // Realtime events.
  useEffect(() => {
    if (!socket) return undefined;
    const onMessage = (m) => {
      if (m.conversationId !== id) return;
      stick.current = true;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      if (m.senderId !== user.id) { setTyping(false); markRead(); }
    };
    const onTyping = (t) => {
      if (t.conversationId !== id) return;
      setTyping(t.isTyping);
      clearTimeout(typingHide.current);
      if (t.isTyping) typingHide.current = setTimeout(() => setTyping(false), 4000); // safety net if "stopped" is lost
    };
    const onReconnect = () => loadLatest().then(markRead).catch(() => {}); // catch up on anything missed offline
    socket.on('message:new', onMessage);
    socket.on('typing', onTyping);
    socket.on('connect', onReconnect);
    return () => {
      socket.off('message:new', onMessage);
      socket.off('typing', onTyping);
      socket.off('connect', onReconnect);
      clearTimeout(typingHide.current);
    };
  }, [socket, id, user.id, markRead, loadLatest]);

  const scrollDown = useCallback(() => {
    if (stick.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, []);
  useEffect(scrollDown, [messages, typing, scrollDown]);

  const loadOlder = async () => {
    if (!messages.length) return;
    stick.current = false;
    try {
      const res = await api.get(`/chat/conversations/${id}/messages`, { params: { before: messages[0].id } });
      setMessages((prev) => [...res.data.data, ...prev]);
      setHasMore(res.data.hasMore);
    } catch (err) {
      setError(parseError(err).message);
    }
  };

  /* ---- typing indicator (sent once when you start, cleared 1.5s after you stop) ---- */
  const stopTyping = useCallback(() => {
    clearTimeout(typingTimer.current);
    if (typingSent.current) {
      socket?.emit('typing', { conversationId: id, isTyping: false });
      typingSent.current = false;
    }
  }, [socket, id]);
  useEffect(() => stopTyping, [stopTyping]);

  const onType = (e) => {
    setText(e.target.value);
    if (!socket) return;
    if (!typingSent.current) {
      socket.emit('typing', { conversationId: id, isTyping: true });
      typingSent.current = true;
    }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 1500);
  };

  /* ---- attachments ---- */
  const pickFile = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const isImage = f.type.startsWith('image/');
    const isVideo = f.type.startsWith('video/');
    if (!isImage && !isVideo) return setError('Choose an image or a video.');
    if (isImage && f.size > MAX_IMAGE) return setError('Images must be 5 MB or smaller.');
    if (isVideo && f.size > MAX_VIDEO) return setError('Videos must be 50 MB or smaller.');
    setError('');
    setFile(f);
  };

  const send = async (e) => {
    e.preventDefault();
    const content = text.trim();
    if ((!content && !file) || progress !== null) return;

    setError('');
    setProgress(0);
    stopTyping();
    const form = new FormData();
    if (content) form.append('content', content);
    if (file) form.append('media', file);
    try {
      const res = await api.post(`/chat/conversations/${id}/messages`, form, {
        onUploadProgress: (p) => p.total && setProgress(Math.round((p.loaded / p.total) * 100)),
      });
      setText('');
      setFile(null);
      // The socket normally delivers it first; this is the fallback if it's disconnected.
      stick.current = true;
      const sent = res.data.message;
      if (sent) setMessages((prev) => (prev.some((x) => x.id === sent.id) ? prev : [...prev, sent]));
    } catch (err) {
      setError(parseError(err).message); // keep the text/file so nothing is lost
    } finally {
      setProgress(null);
    }
  };

  const lastMineId = [...messages].reverse().find((m) => m.senderId === user.id)?.id;
  const seenAt = conversation.otherLastReadAt ? new Date(conversation.otherLastReadAt) : null;
  const sending = progress !== null;

  return (
    <div className="thread">
      <header className="thread-head">
        <Link to="/chat" className="thread-back" aria-label="Back to conversations">‹</Link>
        <Avatar user={conversation.other} size={38} />
        <div>
          <strong>{conversation.other.name}</strong>
          <span className={`presence ${online ? 'on' : ''}`}>{typing ? 'typing…' : online ? 'Online' : 'Offline'}</span>
        </div>
      </header>

      <div className="messages">
        {loading && <p className="muted-sm center">Loading…</p>}
        {hasMore && <button className="link-btn load-older" onClick={loadOlder}>Load earlier messages</button>}
        {!loading && messages.length === 0 && <p className="muted-sm center">No messages yet. Say hello 👋</p>}

        {messages.map((m) => {
          const mine = m.senderId === user.id;
          return (
            <div key={m.id} className={`bubble-row ${mine ? 'mine' : ''}`}>
              <div className="bubble">
                {m.type === 'IMAGE' && (
                  <a href={m.mediaUrl} target="_blank" rel="noreferrer">
                    <img src={m.mediaUrl} alt="Shared" loading="lazy" onLoad={scrollDown} />
                  </a>
                )}
                {m.type === 'VIDEO' && <video src={m.mediaUrl} controls preload="metadata" onLoadedMetadata={scrollDown} />}
                {m.content && <p>{m.content}</p>}
                <span className="bubble-time">
                  {clock(m.createdAt)}
                  {mine && m.id === lastMineId && seenAt && seenAt >= new Date(m.createdAt) && ' · Seen'}
                </span>
              </div>
            </div>
          );
        })}
        {typing && <div className="bubble-row"><div className="bubble typing-dots" aria-label="typing"><i /><i /><i /></div></div>}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={send}>
        {error && <p className="error-text composer-error" role="alert">{error}</p>}
        {file && <FilePreview file={file} onClear={() => setFile(null)} disabled={sending} />}
        <div className="composer-row">
          <label className={`btn btn-outline attach-btn ${sending ? 'disabled' : ''}`} title="Attach a photo or video">
            📎
            <input hidden type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={pickFile} disabled={sending} />
          </label>
          <input className="composer-input" value={text} onChange={onType} placeholder="Type a message" maxLength={4000} aria-label="Message" />
          <button className="btn btn-primary" disabled={sending || (!text.trim() && !file)}>
            {sending ? (file ? `${progress}%` : '…') : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page: inbox + open conversation                                     */
/* ------------------------------------------------------------------ */
export default function Chat() {
  const { conversationId } = useParams();
  const { user } = useAuth();
  const socket = useSocket();
  const navigate = useNavigate();

  const [conversations, setConversations] = useState(null);
  const [online, setOnline] = useState({});
  const [error, setError] = useState('');
  const [newOpen, setNewOpen] = useState(false);

  const listRef = useRef(null);
  listRef.current = conversations;
  const activeRef = useRef(conversationId);
  activeRef.current = conversationId;

  const fetchPresence = useCallback((list) => {
    if (!socket || !list.length) return;
    socket.emit('presence:get', list.map((c) => c.other.id), (map) => setOnline((o) => ({ ...o, ...map })));
  }, [socket]);

  const loadConversations = useCallback(async () => {
    const res = await api.get('/chat/conversations');
    const list = res.data.data;
    // The conversation that's open right now has no unread messages (the thread marks it read).
    setConversations(list.map((c) => (c.id === activeRef.current ? { ...c, unread: 0 } : c)));
    return list;
  }, []);

  // Inbox (reloaded after a reconnect to catch up).
  useEffect(() => {
    let alive = true;
    const reload = () =>
      loadConversations()
        .then((list) => alive && fetchPresence(list))
        .catch((e) => { if (alive) { setError(parseError(e).message); setConversations((c) => c ?? []); } });
    reload();
    socket?.on('connect', reload);
    return () => { alive = false; socket?.off('connect', reload); };
  }, [socket, loadConversations, fetchPresence]);

  // Realtime: new messages, read receipts, presence.
  useEffect(() => {
    if (!socket) return undefined;

    const onMessage = (m) => {
      if (!listRef.current?.some((c) => c.id === m.conversationId)) {
        loadConversations().then(fetchPresence).catch(() => {}); // a brand-new conversation someone started with you
        return;
      }
      setConversations((list) => {
        const i = list.findIndex((c) => c.id === m.conversationId);
        if (i === -1) return list;
        const countsAsUnread = m.senderId !== user.id && activeRef.current !== m.conversationId;
        const updated = { ...list[i], lastMessage: m, unread: list[i].unread + (countsAsUnread ? 1 : 0) };
        return [updated, ...list.filter((_, j) => j !== i)];
      });
    };
    const onRead = ({ conversationId: cid }) =>
      setConversations((list) => (list ? list.map((c) => (c.id === cid ? { ...c, otherLastReadAt: new Date().toISOString() } : c)) : list));
    const onPresence = ({ userId, online: isOn }) => setOnline((o) => ({ ...o, [userId]: isOn }));

    socket.on('message:new', onMessage);
    socket.on('message:read', onRead);
    socket.on('presence:update', onPresence);
    return () => {
      socket.off('message:new', onMessage);
      socket.off('message:read', onRead);
      socket.off('presence:update', onPresence);
    };
  }, [socket, user.id, loadConversations, fetchPresence]);

  // Opening a conversation clears its unread badge.
  useEffect(() => {
    // `list` is still null while the inbox is loading (e.g. arriving from a notification), so keep it as-is then.
    if (conversationId) setConversations((list) => (list ? list.map((c) => (c.id === conversationId ? { ...c, unread: 0 } : c)) : list));
  }, [conversationId]);

  const openConversation = async (id) => {
    const list = await loadConversations();
    fetchPresence(list);
    setNewOpen(false);
    navigate(`/chat/${id}`);
  };

  const active = conversations?.find((c) => c.id === conversationId);

  return (
    <div className={`chat ${conversationId ? 'has-active' : ''}`}>
      <aside className="chat-list">
        <div className="chat-list-head">
          <h1>Messages</h1>
          <button className="btn btn-primary btn-sm" onClick={() => setNewOpen((o) => !o)}>New chat</button>
        </div>
        {newOpen && <NewChat onPick={openConversation} onClose={() => setNewOpen(false)} />}
        {error && <p className="error-text">{error}</p>}

        {conversations === null ? (
          <p className="muted-sm pad">Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="muted-sm pad">No conversations yet. Start one with “New chat”.</p>
        ) : (
          <ul className="convos">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link to={`/chat/${c.id}`} className={`convo ${c.id === conversationId ? 'active' : ''}`}>
                  <span className="avatar-wrap">
                    <Avatar user={c.other} size={42} />
                    {online[c.other.id] && <i className="dot" title="Online" />}
                  </span>
                  <span className="convo-text">
                    <span className="convo-top">
                      <strong>{c.other.name}</strong>
                      {c.lastMessage && <time>{dayLabel(c.lastMessage.createdAt)}</time>}
                    </span>
                    <span className="convo-bottom">
                      <span className={`convo-preview ${c.unread ? 'strong' : ''}`}>
                        {c.lastMessage?.senderId === user.id && 'You: '}{previewOf(c.lastMessage)}
                      </span>
                      {c.unread > 0 && <span className="badge inline">{c.unread > 99 ? '99+' : c.unread}</span>}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="chat-main">
        {active ? (
          <Thread key={active.id} conversation={active} online={!!online[active.other.id]} />
        ) : conversationId && conversations !== null ? (
          <div className="chat-empty"><p>This conversation doesn't exist.</p><Link to="/chat">Back to messages</Link></div>
        ) : (
          <div className="chat-empty"><p>Select a conversation, or start a new one.</p></div>
        )}
      </section>
    </div>
  );
}
