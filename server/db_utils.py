import json
import os
import uuid
from datetime import datetime

DATA_DIR = "data"
MSG_DIR = os.path.join(DATA_DIR, "messages")
USERS_FILE = os.path.join(DATA_DIR, "users.json")
GROUPS_FILE = os.path.join(DATA_DIR, "groups.json")

# Ensure directories exist
os.makedirs(MSG_DIR, exist_ok=True)

def _load_json(path, default):
    if not os.path.exists(path): return default
    try:
        with open(path, 'r') as f: return json.load(f)
    except: return default

def _save_json(path, data):
    with open(path, 'w') as f: json.dump(data, f, indent=2)

# --- Users ---
def get_users():
    return _load_json(USERS_FILE, {})

def get_user_list_public():
    # Return list of usernames without passwords
    return list(get_users().keys())

# --- Groups ---
def get_groups():
    return _load_json(GROUPS_FILE, {})

def create_group(name, creator):
    groups = get_groups()
    gid = str(uuid.uuid4())[:8]
    groups[gid] = {"name": name, "members": [creator]}
    _save_json(GROUPS_FILE, groups)
    return gid, groups[gid]

def add_member_to_group(gid, username):
    groups = get_groups()
    if gid in groups and username not in groups[gid]['members']:
        groups[gid]['members'].append(username)
        _save_json(GROUPS_FILE, groups)
        return True
    return False

# --- Messages ---
def _get_chat_filename(target_type, u1, u2_or_gid):
    if target_type == "group":
        return os.path.join(MSG_DIR, f"group_{u2_or_gid}.json")
    else:
        # Sort names to ensure alice+bob and bob+alice share the same file
        participants = sorted([u1, u2_or_gid])
        return os.path.join(MSG_DIR, f"private_{participants[0]}_{participants[1]}.json")

def save_message(target_type, sender, target_id, text):
    filepath = _get_chat_filename(target_type, sender, target_id)
    history = _load_json(filepath, [])
    msg = {"from": sender, "text": text, "timestamp": datetime.now().timestamp()}
    history.append(msg)
    _save_json(filepath, history)
    return msg

def load_history(target_type, username, target_id):
    filepath = _get_chat_filename(target_type, username, target_id)
    return _load_json(filepath, [])