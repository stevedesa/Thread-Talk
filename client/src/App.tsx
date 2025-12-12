import { useEffect, useState, useRef, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';
import './index.css';

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

  // UI State for Members Popup
  const [showMembers, setShowMembers] = useState(false);


  // Refs
  const chatContainerRef = useRef<HTMLDivElement | null>(null);

  // auto-scroll chat to bottom
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
      const timestamp = data.timestamp || Date.now();
      const msg: ChatMsg = { 
        from: data.from, 
        text: data.text, 
        ts: timestamp,
        timeString: formatTime(timestamp)
      };

      if (activeChat && data.targetId === activeChat.id) {
        setChatHistory((prev) => [...prev, msg]);
        setTimeout(scrollToBottom, 50);
      }
    });

    // Group updates
    socket.on('group_created', (group: any) => {
      const g: Group = { gid: group.gid, name: group.name, members: group.members || [] };
      setMyGroups((prev) => ({ ...prev, [g.gid]: g }));
    });

    socket.on('member_added', (data: { group: any }) => {
      if (data.group) {
        const g: Group = { gid: data.group.gid, name: data.group.name, members: data.group.members || [] };
        setMyGroups((prev) => ({ ...prev, [g.gid]: g }));
      }
    });
    
    return () => {
      // remove listeners we added
      socket.off('connect');
      socket.off('receive_message');
      socket.off('group_created');
      socket.off('member_added');
    };
  }, [activeChat, username, scrollToBottom]);

  // Whenever activeChat changes, fetch history
  useEffect(() => {
    if (!activeChat) return;
    setChatHistory([]);
    // fetch history
    socket.emit('fetch_history', { targetType: activeChat.type, targetId: activeChat.id }, (history: any[]) => {
      const msgs = history.map((m) => ({ 
        from: m.from, 
        text: m.text, 
        ts: m.timestamp || Date.now(),
        timeString: formatTime(m.timestamp || Date.now())
      }));
      setChatHistory(msgs);
      setTimeout(scrollToBottom, 50);
    });
  }, [activeChat, scrollToBottom]);

  // --- Actions ---

  const handleLogin = () => {
    socket.connect();
    socket.emit('login', { username, password }, (res: any) => {
      if (res.status === 'ok') {
        setIsLoggedIn(true);
        setUsersList(res.users || []);
    
        const groupsRaw = res.groups || {};
        const normalizedGroups: Record<string, Group> = {};
        Object.entries(groupsRaw).forEach(([gid, group]: [string, any]) => {
          normalizedGroups[gid] = { gid, name: group.name, members: group.members || [] };
        });
        setMyGroups(normalizedGroups);
      } else {
        alert(res.msg);
      }
    });
  };

  const openChat = (type: 'private' | 'group', id: string) => {
    setActiveChat({ type, id });
    setChatHistory([]);
  };

  const formatTime = (ts: number) => {
    const timestampInMs = ts < 10000000000 ? ts * 1000 : ts;
    const date = new Date(timestampInMs);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const sendMessage = () => {
    if (!message.trim() || !activeChat) return;

    const payload = {
      targetType: activeChat.type,
      targetId: activeChat.id,
      text: message.trim(),
    };
  
    socket.emit('send_message', payload);
    setMessage('');
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

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
  };

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
                className={`cursor-pointer px-3 py-2 rounded-lg transition-colors hover:bg-gray-700 ${
                  activeChat?.id === g.gid ? 'bg-gray-700 font-semibold' : ''
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
              className="bg-gray-700 text-white px-3 py-2 rounded hover:bg-gray-500 transition-colors"
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
                  className={`cursor-pointer px-3 py-2 rounded-lg transition-colors hover:bg-gray-700 flex justify-between items-center ${
                    activeChat?.id === u ? 'bg-gray-300 font-semibold text-gray-900' : ''
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
              <div className="flex items-center gap-4">
                <h3 className="text-xl font-bold">
                  {activeChat.type === 'group' ? `Group: ${myGroups[activeChat.id]?.name}` : `Chat: ${activeChat.id}`}
                </h3>
                {/* MEMBERS BUTTON */}
                {activeChat.type === 'group' && (
                  <button
                    onClick={() => setShowMembers(true)}
                    className="bg-gray-700 px-3 py-1 rounded hover:bg-gray-600 text-sm"
                  >
                    Members
                  </button>
                )}
              </div>

              {/* Add User to Group */}
              {activeChat.type === 'group' && (
                <div className="flex items-center gap-2 text-sm">
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
                    +
                  </button>
                </div>
              )}
            </div>

            {/* MEMBERS POPUP */}
            {showMembers && activeChat?.type === 'group' && (
              <div className="absolute inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
                <div className="bg-gray-800 p-6 rounded-xl shadow-xl w-80">
                  <h3 className="text-xl font-bold mb-4">Members</h3>

                  <div className="flex flex-col gap-2 max-h-60 overflow-y-auto">
                    {myGroups[activeChat.id]?.members?.map((m) => (
                      <div
                        key={m}
                        className="bg-gray-700 px-3 py-2 rounded text-gray-100"
                      >
                        {m}
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={() => setShowMembers(false)}
                    className="mt-4 w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}

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

            {/* Input Box */}
            <div className="mt-4 flex gap-3 items-end">
              <textarea
                className="bg-gray-700 border border-gray-600 text-gray-100 rounded-lg px-3 py-2 flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none overflow-hidden max-h-48"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDownCapture={(e) => {if(e.key === 'Enter') sendMessage()}}
                placeholder="Message... "
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
          </>
        ) : (
          <div className="text-gray-400 text-center mt-20 text-lg">Select a chat to begin</div>
        )}
      </div>
    </div>
  );
}

export default App;
