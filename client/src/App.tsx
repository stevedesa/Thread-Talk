import { useEffect, useState, useRef, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';
import './index.css'; // tailwind or your css

const socket: Socket = io('http://localhost:8000', {
  transports: ['websocket'],
  autoConnect: false
});

// Types
type ChatMsg = { from: string; text: string; ts: number; timeString: string;};
type Group = { gid: string; name: string; members: string[] };

function App() {
  // Auth State
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Data State
  const [usersList, setUsersList] = useState<string[]>([]);
  const [myGroups, setMyGroups] = useState<Record<string, Group>>({});

  // UI State
  const [activeChat, setActiveChat] = useState<{ type: 'private' | 'group'; id: string } | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMsg[]>([]);
  const [message, setMessage] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [userToAdd, setUserToAdd] = useState('');

  // Voice State (kept as-is)
  const [incomingCall, setIncomingCall] = useState<{ from: string; offer: any } | null>(null);
  const [inCall, setInCall] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // Typing state: map user -> boolean
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const lastEmitTypingRef = useRef<number>(0);

  // Helper: auto-scroll chat to bottom
  const scrollToBottom = useCallback(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, []);

  // socket setup & listeners
  useEffect(() => {
    socket.on('connect', () => console.log('Connected'));

    // Incoming messages
    socket.on('receive_message', (data: any) => {
      // Normalize message -> include ts if not provided
      const ts = data.ts ?? Date.now();
      const msg: ChatMsg = { from: data.from, text: data.text, ts, timeString: formatTime(ts)};

      // update only if belongs to active chat OR if you'd like, store globally (here we only show when open)
      if (activeChat && data.targetId === activeChat.id) {
        setChatHistory((prev) => [...prev, msg]);
        setTimeout(scrollToBottom, 50);
      } else {
        // Could increment unread counters (placeholder static for now)
      }
    });

    // Group updates
    socket.on('group_created', (group: Group) => {
      setMyGroups((prev) => ({ ...prev, [group.gid]: group }));
    });

    // Add this listener alongside the 'group_created' one
    socket.on('member_added', (data: { group: Group }) => {
      if (data.group) {
        setMyGroups((prev) => ({ ...prev, [data.group.gid]: data.group }));
      }
    });

    // Or if the server sends you joined event
    socket.on('group_joined', (group: Group) => {
      setMyGroups((prev) => ({ ...prev, [group.gid]: group }));
    });

    // Typing indicator (server should forward typing events to other clients)
    socket.on('typing', (payload: { from: string; to: string; isTyping: boolean }) => {
      // Only care about typing events for the chat we're currently in
      if (!activeChat) return;
      if (activeChat.type !== 'private') return;
      // only set typing when the event is for the currently active private chat and not from me
      const otherUser = activeChat.id;
      if (payload.from === otherUser && payload.to === username) {
        setTypingUsers((prev) => ({ ...prev, [payload.from]: payload.isTyping }));
      }
    });

    // Voice signals
    socket.on('incoming_call', async (data) => {
      setIncomingCall(data);
    });

    socket.on('call_answered', async (data) => {
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    socket.on("call_rejected", (data) => {
      setInCall(false);

      // Close peer connection if any
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }

      alert(`Call was rejected by ${data.from}.`);
    });

    socket.on('ice_candidate', async (data) => {
      if (pcRef.current && data.candidate) {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    });

    return () => {
      // remove listeners we added
      socket.off('connect');
      socket.off('receive_message');
      socket.off('group_created');
      socket.off('typing');
      socket.off('incoming_call');
      socket.off('call_answered');
      socket.off('ice_candidate');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat, username, scrollToBottom]);

  // Whenever activeChat changes, fetch history and reset typing flags
  useEffect(() => {
    if (!activeChat) return;
    setChatHistory([]);
    setTypingUsers({});
    // fetch history
    socket.emit('fetch_history', { targetType: activeChat.type, targetId: activeChat.id }, (history: any[]) => {
      // map/normalize history messages to ChatMsg with ts
      const msgs = history.map((m) => ({ from: m.from, text: m.text, ts: m.ts ?? Date.now(), timeString: formatTime(m.ts ?? Date.now()) }));
      setChatHistory(msgs);
      setTimeout(scrollToBottom, 50);
    });
  }, [activeChat, scrollToBottom]);

  // Emit typing events when the local user is typing (private chats only)
  useEffect(() => {
    if (!activeChat) return;
    if (activeChat.type !== 'private') return;

    const now = Date.now();
    const THROTTLE_MS = 800; // don't spam server
    if (now - lastEmitTypingRef.current > THROTTLE_MS) {
      socket.emit('typing', { to: activeChat.id, from: username, isTyping: message.trim().length > 0 });
      lastEmitTypingRef.current = now;
    }

    // Clear typing flag after a short idle timeout
    if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      socket.emit('typing', { to: activeChat.id, from: username, isTyping: false });
    }, 1500);

    return () => {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  // --- Actions ---

  const handleLogin = () => {
    socket.connect();
    socket.emit('login', { username, password }, (res: any) => {
      if (res.status === 'ok') {
        setIsLoggedIn(true);
        setUsersList(res.users || []);
        setMyGroups(res.groups || {});
      } else {
        alert(res.msg);
      }
    });
  };

  const openChat = (type: 'private' | 'group', id: string) => {
    setActiveChat({ type, id });
    setChatHistory([]);
    // fetch_history handled by effect
  };

    // format timestamp to readable time
  const formatTime = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const sendMessage = () => {
    if (!message.trim() || !activeChat) return;

    const ts = Date.now();

    const payload = {
      targetType: activeChat.type,
      targetId: activeChat.id,
      text: message.trim(),
      ts
    };

    // emit to server
    socket.emit('send_message', payload);

    // Add formatted time here
    setChatHistory((prev) => [
      ...prev,
      {
        from: username,
        text: payload.text,
        ts,
        timeString: formatTime(ts)   // <-- store static formatted time
      }
    ]);

    setMessage('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setTimeout(scrollToBottom, 50);

    if (activeChat.type === 'private') {
      socket.emit('typing', { to: activeChat.id, from: username, isTyping: false });
    }
  };

  const createGroup = () => {
    if (!newGroupName.trim()) return;
    socket.emit('create_new_group', { name: newGroupName.trim() });
    setNewGroupName('');
  };

  const addUserToGroup = () => {
    if (!activeChat || activeChat.type !== 'group' || !userToAdd.trim()) return;
    socket.emit('add_member', { gid: activeChat.id, username: userToAdd.trim() });
    setUserToAdd('');
  };

  // --- Voice logic kept as before (omitted here for brevity) ---
  const setupPeerConnection = async (targetUser: string) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice_candidate', { target: targetUser, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const audio = new Audio();
      audio.srcObject = event.streams[0];
      audio.play();
    };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    localStreamRef.current = stream;
    pcRef.current = pc;
    return pc;
  };

  const startCall = async () => {
    if (!activeChat || activeChat.type !== 'private') return;
    const targetUser = activeChat.id;

    const pc = await setupPeerConnection(targetUser);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('call_user', { target: targetUser, offer });
    setInCall(true);
  };

  const answerCall = async () => {
    if (!incomingCall) return;
    const pc = await setupPeerConnection(incomingCall.from);

    await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('answer_call', { target: incomingCall.from, answer });
    setIncomingCall(null);
    setInCall(true);
    openChat('private', incomingCall.from);
  };

  // textarea auto resize
  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`; // cap height
  };

  // handle keydown: Enter send, Shift+Enter newline
  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // --- Render ---

  if (!isLoggedIn) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="bg-gray-800 p-10 rounded-2xl shadow-2xl w-96 flex flex-col gap-6">
          <h2 className="text-3xl font-bold text-white text-center">Login / Register</h2>

          <input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="bg-gray-700 text-gray-100 px-4 py-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
          />

          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="bg-gray-700 text-gray-100 px-4 py-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
          />

          <button
            onClick={handleLogin}
            className="bg-blue-600 text-white px-4 py-3 rounded-lg hover:bg-blue-700 transition-colors font-semibold shadow-md"
          >
            Enter
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen font-sans text-gray-100 bg-gray-900">

      {/* SIDEBAR */}
      <div className="w-1/4 bg-gray-800 border-r border-gray-700 p-6 flex flex-col gap-6">
        <h3 className="text-xl font-bold mb-4">
          Logged in as: <span className="text-blue-400">{username}</span>
        </h3>

        {/* Groups */}
        <div>
          <h4 className="text-lg font-semibold mb-2 flex items-center justify-between">
            <span>Groups</span>
            {/* static unread badge placeholder */}
            <span className="text-sm bg-blue-600 text-white px-2 py-0.5 rounded">1</span>
          </h4>
          <div className="flex flex-col gap-2">
            {Object.values(myGroups).map((g) => (
              <div
                key={g.gid}
                onClick={() => openChat('group', g.gid)}
                className={`cursor-pointer px-3 py-2 rounded-lg transition-colors hover:bg-blue-700 ${
                  activeChat?.id === g.gid ? 'bg-blue-600 font-semibold' : ''
                }`}
              >
                <div className="flex justify-between items-center">
                  <span className="truncate"># {g.name}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              placeholder="New Group Name"
              className="border border-gray-300 rounded px-3 py-2 w-full focus:outline-none focus:ring-2 focus:ring-blue-400 text-gray-900"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
            />
            <button
              onClick={createGroup}
              className="bg-blue-500 text-white px-3 rounded hover:bg-blue-600 transition-colors"
            >
              +
            </button>
          </div>
        </div>

        <hr className="border-gray-700" />

        {/* Users */}
        <div>
          <h4 className="text-lg font-semibold mb-2 flex items-center justify-between">
            <span>Users</span>
            {/* static unread badge placeholder */}
            <span className="text-sm bg-blue-600 text-white px-2 py-0.5 rounded">
              {usersList.filter((u) => u !== username).length}
            </span>
          </h4>
          <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
            {usersList
              .filter((u) => u !== username)
              .map((u) => (
                <div
                  key={u}
                  onClick={() => openChat('private', u)}
                  className={`cursor-pointer px-3 py-2 rounded-lg transition-colors hover:bg-blue-100 flex justify-between items-center ${
                    activeChat?.id === u ? 'bg-blue-200 font-semibold' : ''
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {/* initials avatar */}
                    <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white font-semibold">
                      {u.slice(0, 1).toUpperCase()}
                    </div>
                    <span className="truncate">@ {u}</span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* CHAT AREA */}
      <div className="flex-1 p-6 flex flex-col">
        {activeChat ? (
          <>
            <div className="flex justify-between items-center border-b border-gray-700 pb-4 mb-4">
              <div>
                <h3 className="text-xl font-bold">
                  {activeChat.type === 'group' ? `Group: ${myGroups[activeChat.id]?.name}` : `Chat: ${activeChat.id}`}
                </h3>
                {/* Typing indicator (private chats only) */}
                {activeChat.type === 'private' && typingUsers[activeChat.id] && (
                  <div className="text-sm text-green-300 mt-1">{activeChat.id} is typing...</div>
                )}
              </div>

              <div className="flex items-center gap-3">
                {activeChat.type === 'private' && !inCall && (
                  <button
                    onClick={startCall}
                    className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors shadow"
                  >
                    Call User
                  </button>
                )}

                {inCall && (
                  <button disabled className="bg-gray-400 px-4 py-2 rounded-lg text-white cursor-not-allowed">
                    Call in Progress...
                  </button>
                )}
              </div>
            </div>

            {/* Chat History */}
            <div
              ref={chatContainerRef}
              className="flex-1 overflow-y-auto p-4 bg-gray-800 rounded-lg flex flex-col gap-3"
              style={{ minHeight: 200 }}
            >
              {chatHistory.map((m, i) => {
                const mine = m.from === username;
                return (
                  <div key={i} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] break-words px-4 py-2 rounded-2xl relative ${
                      mine ? 'bg-blue-600 text-white rounded-br-none' : 'bg-gray-700 text-gray-100 rounded-bl-none'
                    }`}>
                      <div className="text-sm"><strong className="mr-2">{m.from}</strong></div>
                      <div className="mt-1 whitespace-pre-wrap">{m.text}</div>
                      <div className="text-xs text-gray-300 mt-2 text-right">{formatTime(m.ts)}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Typing indicator below chat */}
            {activeChat.type === 'private' && typingUsers[activeChat.id] && (
              <div className="text-sm text-green-300 mt-2">{activeChat.id} is typing...</div>
            )}

            {/* Input Box */}
            <div className="mt-4 flex gap-3 items-end">
              <textarea
                ref={textareaRef}
                className="bg-gray-700 border border-gray-600 text-gray-100 rounded-lg px-3 py-2 flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none overflow-hidden max-h-48"
                value={message}
                onChange={handleTextareaInput}
                onKeyDown={handleTextareaKeyDown}
                placeholder="Message... (Enter to send, Shift+Enter for newline)"
                rows={1}
                style={{ minHeight: 40 }}
              />

              <button
                onClick={sendMessage}
                className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 transition-colors shadow"
              >
                Send
              </button>
            </div>

            {/* Add User to Group */}
            {activeChat.type === 'group' && (
              <div className="mt-3 flex items-center gap-2 text-sm">
                <span>Add user:</span>
                <input
                  className="border border-gray-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400 text-gray-900"
                  value={userToAdd}
                  onChange={(e) => setUserToAdd(e.target.value)}
                />
                <button
                  onClick={addUserToGroup}
                  className="bg-blue-500 text-white px-3 py-1 rounded-lg hover:bg-blue-600 transition-colors"
                >
                  Add
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="text-gray-400 text-center mt-20 text-lg">Select a chat to begin</div>
        )}
      </div>

      {/* INCOMING CALL MODAL */}
      {incomingCall && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl p-6 shadow-2xl border border-red-600 w-96 text-center text-gray-100">
            <h4 className="text-lg font-bold mb-4">Incoming call from {incomingCall.from}</h4>
            <div className="flex justify-center gap-4">
              <button
                onClick={answerCall}
                className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors shadow"
              >
                Accept
              </button>
              <button
                onClick={() => {
                  socket.emit("reject_call", { target: incomingCall.from });
                  setIncomingCall(null);
                }}
                className="bg-red-500 text-white px-4 py-2 rounded-lg hover:bg-red-600 transition-colors shadow"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
