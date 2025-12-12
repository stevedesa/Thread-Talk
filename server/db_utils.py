import json
import os
import uuid
from datetime import datetime

# --- FS Setup ---

DATA_DIR = "data"
MSG_DIR = os.path.join(DATA_DIR, "messages")
USERS_FILE = os.path.join(DATA_DIR, "users.json")
GROUPS_FILE = os.path.join(DATA_DIR, "groups.json")

# Ensure directories exist
os.makedirs(MSG_DIR, exist_ok=True)

# --- JSON helpers ---

def _load_json(path, default):
    """
    Try to load JSON from a file.
    """
    if not os.path.exists(path):
        return default
    try:
        with open(path, 'r') as f: return json.load(f)
    except:
        return default

def _save_json(path, data):
    """
    Save JSON to a file.
    """
    with open(path, 'w') as f: json.dump(data, f, indent=2)

# --- Users ---

def get_users():
    """
    Returns the full user dictionary stored in USERS_FILE.
    """
    return _load_json(USERS_FILE, {})

def get_user_list_public():
    """
    Returns a list of all usernames stored in USERS_FILE.
    """
    return list(get_users().keys())

# --- Groups ---

def get_groups():
    """
    Returns the full group dictionary stored in GROUPS_FILE.
    """
    return _load_json(GROUPS_FILE, {})

def create_group(name, creator):
    """
    Creates a new group and returns its ID and data.
    """
    groups = get_groups()

    gid = str(uuid.uuid4())[:8]

    groups[gid] = {
        "name": name,
        "members": [creator],
    }
    _save_json(GROUPS_FILE, groups)

    return gid, groups[gid]

def add_member_to_group(gid, username):
    """
    Adds a user to a group and returns True if successful, False otherwise.
    """
    groups = get_groups()

    if gid in groups and username not in groups[gid]['members']:
        groups[gid]['members'].append(username)
        _save_json(GROUPS_FILE, groups)
        return True
    
    return False

# --- Messages ---

def _get_chat_filename(target_type, u1, u2_or_gid):
    """
    Returns the filename for a given chat.
    """
    if target_type == "group":
        return os.path.join(MSG_DIR, f"group_{u2_or_gid}.json")
    else:
        # Sort names to ensure alice and bob & bob and alice share the same file
        participants = sorted([u1, u2_or_gid])
        return os.path.join(MSG_DIR, f"private_{participants[0]}_{participants[1]}.json")

def save_message(target_type, sender, target_id, text):
    """
    Save a message to a chat.
    """
    filepath = _get_chat_filename(target_type, sender, target_id)
    history = _load_json(filepath, [])

    msg = {
        "from": sender,
        "text": text,
        "timestamp": datetime.now().timestamp(),
    }

    history.append(msg)
    _save_json(filepath, history)
    return msg

def load_history(target_type, username, target_id):
    """
    Load all messages from a chat.
    """
    filepath = _get_chat_filename(target_type, username, target_id)
    return _load_json(filepath, [])