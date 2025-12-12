import socketio
import uvicorn
from fastapi import FastAPI
from datetime import datetime
import db_utils

# Setup
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')
app = FastAPI()
app = socketio.ASGIApp(sio, other_asgi_app=app)

# Maps
connected_users = {}
sid_to_user = {}

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
    
    # Auto-register if user doesn't exist
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
    target_type = data['targetType'] # private/group
    target_id = data['targetId']     # username/group_id
    text = data['text']

    # Save to file
    msg_obj = db_utils.save_message(target_type, sender, target_id, text)

    # Emit to recipients
    response = {
        "targetId": target_id if target_type == 'group' else sender, 
        "from": sender, 
        "text": text,
        "timestamp": msg_obj.get("timestamp", datetime.now().timestamp()),
        "type": target_type
    }

    if target_type == 'private':
        # Send to sender
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
                    await sio.emit('receive_message', {**response, "targetId": target_id}, to=connected_users[member])

# --- Group Management ---
@sio.event
async def create_new_group(sid, data):
    creator = sid_to_user[sid]
    gid, g_data = db_utils.create_group(data['name'], creator)

    # Notify creator
    await sio.emit('group_created', {"gid": gid, "name": g_data['name'], "members": g_data['members']}, to=sid)

@sio.event
async def add_member(sid, data):
    gid = data['gid']
    new_user = data['username']
    if db_utils.add_member_to_group(gid, new_user):
        # Notify new user if they are online
        groups = db_utils.get_groups()
        if new_user in connected_users:
            await sio.emit('group_created', {"gid": gid, "name": groups[gid]['name'], "members": groups[gid]['members']}, to=connected_users[new_user])
        return {"status": "ok"}
    return {"status": "error"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)