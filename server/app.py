import socketio
import uvicorn
from fastapi import FastAPI
import db_utils

# Setup
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')
app = FastAPI()
app = socketio.ASGIApp(sio, other_asgi_app=app)

# Maps
connected_users = {} # username -> sid
sid_to_user = {}     # sid -> username

@sio.event
async def connect(sid, environ):
    print(f"Connected: {sid}")

@sio.event
async def disconnect(sid):
    if sid in sid_to_user:
        user = sid_to_user.pop(sid)
        connected_users.pop(user, None)
        print(f"Disconnected: {user}")

# --- Auth & Init ---
@sio.event
async def login(sid, data):
    users = db_utils.get_users()
    u, p = data.get('username'), data.get('password')
    
    # Auto-register if user doesn't exist (for simplicity based on your file DB request)
    if u not in users:
        users[u] = p
        db_utils._save_json(db_utils.USERS_FILE, users)
    
    if users[u] == p:
        connected_users[u] = sid
        sid_to_user[sid] = u
        
        # Send initial state
        all_users = db_utils.get_user_list_public()
        all_groups = db_utils.get_groups()
        # Filter groups this user is in
        my_groups = {gid: g for gid, g in all_groups.items() if u in g['members']}
        
        return {"status": "ok", "users": all_users, "groups": my_groups}
    return {"status": "error", "msg": "Invalid credentials"}

# --- Chat & History ---
@sio.event
async def fetch_history(sid, data):
    # data: { targetType: 'private'|'group', targetId: 'bob'|'groupId' }
    user = sid_to_user[sid]
    history = db_utils.load_history(data['targetType'], user, data['targetId'])
    return history

@sio.event
async def send_message(sid, data):
    sender = sid_to_user[sid]
    target_type = data['targetType'] # 'private' or 'group'
    target_id = data['targetId']     # username or group_id
    text = data['text']

    # Save to file
    msg_obj = db_utils.save_message(target_type, sender, target_id, text)

    # Emit to recipient(s)
    response = {
        "targetId": target_id if target_type == 'group' else sender, 
        "from": sender, 
        "text": text,
        "type": target_type
    }

    if target_type == 'private':
        # Send to sender (so they see it)
        await sio.emit('receive_message', {**response, "targetId": target_id}, to=sid)
        # Send to receiver
        if target_id in connected_users:
            await sio.emit('receive_message', response, to=connected_users[target_id])
            
    elif target_type == 'group':
        # Get members
        groups = db_utils.get_groups()
        if target_id in groups:
            for member in groups[target_id]['members']:
                if member in connected_users:
                    # 'targetId' helps client know which chat window to update
                    await sio.emit('receive_message', {**response, "targetId": target_id}, to=connected_users[member])

# --- Group Management ---
@sio.event
async def create_new_group(sid, data):
    creator = sid_to_user[sid]
    gid, g_data = db_utils.create_group(data['name'], creator)
    # Notify creator (and potentially others if you implement invite immediately)
    await sio.emit('group_created', {"gid": gid, "name": g_data['name'], "members": g_data['members']}, to=sid)

@sio.event
async def add_member(sid, data):
    gid = data['gid']
    new_user = data['username']
    if db_utils.add_member_to_group(gid, new_user):
        # Notify the new user if they are online
        groups = db_utils.get_groups()
        if new_user in connected_users:
             await sio.emit('group_created', {"gid": gid, "name": groups[gid]['name'], "members": groups[gid]['members']}, to=connected_users[new_user])
        return {"status": "ok"}
    return {"status": "error"}

# --- Voice Signaling (P2P Relay) ---
# Relay these events directly between two users
@sio.event
async def call_user(sid, data):
    # data: { target: 'bob', offer: SDP }
    caller = sid_to_user[sid]
    target = data['target']
    if target in connected_users:
        await sio.emit('incoming_call', {
            "from": caller,
            "offer": data['offer']
        }, to=connected_users[target])

@sio.event
async def answer_call(sid, data):
    # data: { target: 'alice', answer: SDP }
    target = data['target']
    if target in connected_users:
        await sio.emit('call_answered', {
            "answer": data['answer']
        }, to=connected_users[target])

@sio.event
async def reject_call(sid, data):
    # data: { target: 'bob' }
    caller = sid_to_user[sid]
    target = data['target']

    if target in connected_users:
        await sio.emit('call_rejected', {
            "from": caller
        }, to=connected_users[target])

@sio.event
async def ice_candidate(sid, data):
    target = data['target']
    if target in connected_users:
        await sio.emit('ice_candidate', {
            "candidate": data['candidate']
        }, to=connected_users[target])

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)