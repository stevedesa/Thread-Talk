import { useEffect, useState, useRef } from 'react';
import io, { Socket } from 'socket.io-client';

const socket: Socket = io('http://localhost:8000', {
  transports: ['websocket'],
  autoConnect: false
});

// Types
type ChatMsg = { from: string, text: string };
type Group = { gid: string, name: string, members: string[] };

function App() {
  // Auth State
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Data State
  const [usersList, setUsersList] = useState<string[]>([]);
  const [myGroups, setMyGroups] = useState<Record<string, Group>>({});
  
  // UI State
  const [activeChat, setActiveChat] = useState<{ type: 'private'|'group', id: string } | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMsg[]>([]);
  const [message, setMessage] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [userToAdd, setUserToAdd] = useState("");

  // Voice State
  const [incomingCall, setIncomingCall] = useState<{from: string, offer: any} | null>(null);
  const [inCall, setInCall] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    socket.on('connect', () => console.log("Connected"));

    // 1. Receive Message
    socket.on('receive_message', (data) => {
      // Only update UI if the message belongs to the currently open chat
      if (activeChat && data.targetId === activeChat.id) {
        setChatHistory(prev => [...prev, { from: data.from, text: data.text }]);
      }
    });

    // 2. Group Updates
    socket.on('group_created', (group: Group) => {
      setMyGroups(prev => ({ ...prev, [group.gid]: group }));
    });

    // 3. Voice Signals
    socket.on('incoming_call', async (data) => {
      setIncomingCall(data);
    });

    socket.on('call_answered', async (data) => {
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    socket.on('ice_candidate', async (data) => {
      if (pcRef.current && data.candidate) {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    });

    return () => { socket.off(); }
  }, [activeChat]);

  // --- Actions ---

  const handleLogin = () => {
    socket.connect();
    socket.emit('login', { username, password }, (res: any) => {
      if (res.status === 'ok') {
        setIsLoggedIn(true);
        setUsersList(res.users);
        setMyGroups(res.groups);
      } else {
        alert(res.msg);
      }
    });
  };

  const openChat = (type: 'private'|'group', id: string) => {
    setActiveChat({ type, id });
    setChatHistory([]); // Clear previous
    // Fetch persistence
    socket.emit('fetch_history', { targetType: type, targetId: id }, (history: any[]) => {
      setChatHistory(history);
    });
  };

  const sendMessage = () => {
    if (!message || !activeChat) return;
    socket.emit('send_message', {
      targetType: activeChat.type,
      targetId: activeChat.id,
      text: message
    });
    setMessage("");
  };

  const createGroup = () => {
    if (!newGroupName) return;
    socket.emit('create_new_group', { name: newGroupName });
    setNewGroupName("");
  };

  const addUserToGroup = () => {
    if (!activeChat || activeChat.type !== 'group') return;
    socket.emit('add_member', { gid: activeChat.id, username: userToAdd });
    setUserToAdd("");
  };

  // --- Voice Logic (P2P) ---

  const setupPeerConnection = async (targetUser: string) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    
    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice_candidate', { target: targetUser, candidate: event.candidate });
      }
    };

    // Handle Audio Stream
    pc.ontrack = (event) => {
      const audio = new Audio();
      audio.srcObject = event.streams[0];
      audio.play();
    };

    // Get Local Stream
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
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
    // Switch view to the caller
    openChat('private', incomingCall.from); 
  };

  // --- Render ---

  if (!isLoggedIn) {
    return (
      <div style={{ padding: 50 }}>
        <h2>Login / Register</h2>
        <input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} />
        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
        <button onClick={handleLogin}>Enter</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* SIDEBAR */}
      <div style={{ width: '30%', borderRight: '1px solid #ccc', padding: 10, background: '#f5f5f5' }}>
        <h3>Logged as: {username}</h3>
        
        <h4>Groups</h4>
        {Object.values(myGroups).map(g => (
          <div key={g.gid} onClick={() => openChat('group', g.gid)} 
              style={{cursor: 'pointer', fontWeight: activeChat?.id === g.gid ? 'bold' : 'normal'}}>
            # {g.name}
          </div>
        ))}
        <div style={{marginTop: 5}}>
          <input placeholder="New Group Name" size={10} value={newGroupName} onChange={e => setNewGroupName(e.target.value)} />
          <button onClick={createGroup}>+</button>
        </div>

        <hr />
        
        <h4>Users</h4>
        {usersList.filter(u => u !== username).map(u => (
          <div key={u} onClick={() => openChat('private', u)}
               style={{cursor: 'pointer', fontWeight: activeChat?.id === u ? 'bold' : 'normal'}}>
            @ {u}
          </div>
        ))}
      </div>

      {/* CHAT AREA */}
      <div style={{ width: '70%', padding: 20, display: 'flex', flexDirection: 'column' }}>
        {activeChat ? (
          <>
            <div style={{borderBottom: '1px solid #ddd', paddingBottom: 10, marginBottom: 10, display: 'flex', justifyContent: 'space-between'}}>
              <h3>{activeChat.type === 'group' ? `Group: ${myGroups[activeChat.id]?.name}` : `Chat: ${activeChat.id}`}</h3>
              
              {/* Voice Call Button (Private Only) */}
              {activeChat.type === 'private' && !inCall && (
                <button onClick={startCall} style={{background: 'green', color: 'white'}}>Call User</button>
              )}
              {inCall && <button disabled>Call in Progress...</button>}
            </div>

            {/* Chat History */}
            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #eee', padding: 10, borderRadius: 5 }}>
              {chatHistory.map((m, i) => (
                <div key={i} style={{ textAlign: m.from === username ? 'right' : 'left', margin: '5px 0' }}>
                  <span style={{ background: m.from === username ? '#d1e8ff' : '#eee', padding: '5px 10px', borderRadius: 10 }}>
                    <b>{m.from}:</b> {m.text}
                  </span>
                </div>
              ))}
            </div>

            {/* Input Area */}
            <div style={{ marginTop: 10, display: 'flex' }}>
              <input style={{flex: 1}} value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()} />
              <button onClick={sendMessage}>Send</button>
            </div>

            {/* Add User to Group Control */}
            {activeChat.type === 'group' && (
              <div style={{marginTop: 10, fontSize: '0.9em'}}>
                Add user: <input value={userToAdd} onChange={e => setUserToAdd(e.target.value)} size={10} />
                <button onClick={addUserToGroup}>Add</button>
              </div>
            )}
          </>
        ) : (
          <div>Select a chat to begin</div>
        )}
      </div>

      {/* INCOMING CALL MODAL */}
      {incomingCall && (
        <div style={{position: 'absolute', top: 20, right: 20, background: 'white', border: '2px solid red', padding: 20, boxShadow: '0 0 10px rgba(0,0,0,0.5)'}}>
          <h4>Incoming Call from {incomingCall.from}</h4>
          <button onClick={answerCall}>Accept</button>
          <button onClick={() => setIncomingCall(null)}>Reject</button>
        </div>
      )}
    </div>
  );
}

export default App;