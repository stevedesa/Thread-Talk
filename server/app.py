import socketio
import uvicorn
from fastapi import FastAPI
from datetime import datetime
import db_utils

# --- Socket.IO + FastAPI setup ---

# Create an async Socket.IO server that runs on ASGI and accepts all CORS origins.
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')

# Base FastAPI app (we can still use normal HTTP routes if we want).
app = FastAPI()

# Wrap the FastAPI app with Socket.IO’s ASGI adapter so both live together.
app = socketio.ASGIApp(sio, other_asgi_app=app)

# --- In‑memory connection tracking ---
# These are just simple maps we keep in memory to know who's online.

connected_users = {}  # username -> sid (Socket.IO session ID)
sid_to_user = {}      # sid -> username


# --- Connection lifecycle ---

@sio.event
async def connect(sid, environ):
    # Runs whenever a new client connects via Socket.IO
    print(f"Connected: {sid}")


@sio.event
async def disconnect(sid):
    # Runs when a client disconnects; clean up our maps
    if sid in sid_to_user:
        user = sid_to_user.pop(sid)
        # Only remove if this sid is still the active one for this user
        if connected_users.get(user) == sid:
            connected_users.pop(user, None)
            print(f"Disconnected: {user}")


# --- Auth & Initial data ---

@sio.event
async def login(sid, data):
    """
    Simple login endpoint.

    - If the user does not exist, we auto‑register them.
    - On success, we return:
      - list of all public users
      - groups that this user is a member of
    """
    users = db_utils.get_users()
    u, p = data.get('username'), data.get('password')

    # Auto-register if user doesn't exist yet
    if u not in users:
        users[u] = p
        db_utils._save_json(db_utils.USERS_FILE, users)

    # Basic password check
    if users[u] == p:
        # Track the connection in both maps
        connected_users[u] = sid
        sid_to_user[sid] = u

        # Build initial state for the frontend
        all_users = db_utils.get_user_list_public()
        all_groups = db_utils.get_groups()

        # Only send back groups that this user is actually in
        my_groups = {
            gid: g
            for gid, g in all_groups.items()
            if u in g['members']
        }

        return {
            "status": "ok",
            "users": all_users,
            "groups": my_groups,
        }

    # Wrong password (or user not found but not auto‑registered for some reason)
    return {"status": "error", "msg": "Invalid credentials"}


# --- Chat history & messaging ---

@sio.event
async def fetch_history(sid, data):
    """
    Fetch message history.

    Expected data:
      {
        "targetType": "private" | "group",
        "targetId": "bob" | "some-group-id"
      }
    """
    user = sid_to_user[sid]
    history = db_utils.load_history(
        data['targetType'],
        user,
        data['targetId']
    )
    return history


@sio.event
async def send_message(sid, data):
    """
    Send a message either to:
      - a single user (private), or
      - a group.

    Expected data:
      {
        "targetType": "private" | "group",
        "targetId": "username-or-group-id",
        "text": "message text"
      }
    """
    sender = sid_to_user[sid]
    target_type = data['targetType']  # "private" | "group"
    target_id = data['targetId']      # username | group_id
    text = data['text']

    # Persist the message somewhere (file/db managed by db_utils)
    msg_obj = db_utils.save_message(target_type, sender, target_id, text)

    # Common payload for all recipients
    response = {
        # For private chats, we treat the "conversation id" as the sender,
        # for group chats it'll be the group id.
        "targetId": target_id if target_type == 'group' else sender,
        "from": sender,
        "text": text,
        "timestamp": msg_obj.get("timestamp", datetime.now().timestamp()),
        "type": target_type,
    }

    if target_type == 'private':
        # Echo back to sender (with the actual target as targetId)
        await sio.emit(
            'receive_message',
            {**response, "targetId": target_id},
            to=sid
        )

        # If the other user is online, send it to them as well
        if target_id in connected_users:
            await sio.emit(
                'receive_message',
                response,
                to=connected_users[target_id]
            )

    elif target_type == 'group':
        # We'll need the group members for broadcasting
        groups = db_utils.get_groups()

        # First, confirm to the sender that their message went through
        await sio.emit(
            'receive_message',
            {**response, "targetId": target_id},
            to=sid
        )

        # Now fan out to other group members
        if target_id in groups:
            for member in groups[target_id]['members']:
                # Skip sender, we've already sent to them
                if member in connected_users and member != sender:
                    await sio.emit(
                        'receive_message',
                        {**response, "targetId": target_id},
                        to=connected_users[member]
                    )


# --- Group management ---

@sio.event
async def create_new_group(sid, data):
    """
    Create a new group owned by the current user.

    Expected data:
      { "name": "Cool Group Name" }
    """
    creator = sid_to_user[sid]
    gid, g_data = db_utils.create_group(data['name'], creator)

    # Let the creator know the group is ready on the server
    await sio.emit(
        'group_created',
        {"gid": gid, "name": g_data['name'], "members": g_data['members']},
        to=sid
    )


@sio.event
async def add_member(sid, data):
    """
    Add a user to an existing group.

    Expected data:
      {
        "gid": "group-id",
        "username": "new-member-username"
      }
    """
    gid = data['gid']
    new_user = data['username']

    # If db_utils says the add worked, update everyone who's affected
    if db_utils.add_member_to_group(gid, new_user):
        groups = db_utils.get_groups()
        group = groups[gid]

        # If the newly added user is online, send them the group info
        if new_user in connected_users:
            await sio.emit(
                'group_created',
                {"gid": gid, "name": group['name'], "members": group['members']},
                to=connected_users[new_user]
            )

        # Notify all current group members that someone was added
        for member in group['members']:
            if member in connected_users:
                await sio.emit(
                    'member_added',
                    {
                        "group": {
                            "gid": gid,
                            "name": group['name'],
                            "members": group['members'],
                        }
                    },
                    to=connected_users[member]
                )

        return {"status": "ok"}

    return {"status": "error"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)