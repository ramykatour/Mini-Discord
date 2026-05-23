(function () {
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    localStorage.setItem('token', urlToken);
    history.replaceState(null, '', location.pathname);
  }
})();

const state = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  rooms: [], currentRoom: null, currentDm: null,
  onlineUsers: new Set(), members: [],
  typingTimeout: null, voiceRoom: null, dmOpen: true,
  muted: false, deafened: false,
  membersVisible: true, pendingBanUserId: null,
};

(async () => {
  if (!state.token) return (location.href = '/login');
  const me = await api('GET', '/auth/me');
  if (!me?.user) return logout();
  state.user = me.user;
  localStorage.setItem('user', JSON.stringify(state.user));
  renderSelf();
  initSocket();
  await loadRooms();
  initEmojiPicker();
  initInputHandlers();
  initMobileMenu();
})();

async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json();
  } catch (e) { return null; }
}

let socket;
function initSocket() {
  socket = io({ auth: { token: state.token } });
  socket.on('connect_error', (e) => {
    if (e.message.startsWith('Banned')) { toast(e.message, 'error'); setTimeout(logout, 2000); }
  });
  socket.on('banned', ({ reason }) => { toast(`You were banned: ${reason}`, 'error'); setTimeout(logout, 2000); });
  socket.on('users:online', (ids) => { state.onlineUsers = new Set(ids); renderMembers(); });
  socket.on('user:status', ({ userId, status }) => {
    if (status === 'offline') {
      state.onlineUsers.delete(userId);
      renderMembers();
    } else {
      state.onlineUsers.add(userId);
      const known = state.members.find(u => u.id === userId);
      if (!known) {
        loadMembers(); 
      } else {
        renderMembers();
      }
    }
  });
  socket.on('message:new', (msg) => { if (msg.room_id == state.currentRoom?.id) appendMessage(msg); });
  socket.on('message:deleted', ({ messageId, deletedBy }) => {
    const el = document.querySelector(`[data-msg-id="${messageId}"] .msg-text`);
    if (el) { el.textContent = `[Deleted by ${deletedBy}]`; el.style.opacity='.5'; el.style.fontStyle='italic'; }
    document.querySelector(`[data-msg-id="${messageId}"] .msg-hover-actions`)?.remove();
  });
  socket.on('room:cleared', ({ roomId, by }) => {
    if (roomId == state.currentRoom?.id) { document.getElementById('messages').innerHTML=''; appendSystemMsg(`Chat cleared by ${by}`, 'sys-clear'); }
  });
  socket.on('reaction:update', ({ messageId, reactions }) => {
    const el = document.querySelector(`[data-msg-id="${messageId}"] .msg-reactions`);
    if (el) el.innerHTML = buildReactionsHTML(messageId, reactions);
  });
  socket.on('room:typing', ({ username }) => showTyping(`${username} is typing...`));
  socket.on('dm:new', (msg) => {
    const fromMe = msg.sender_id == state.user?.id;
    const otherUserId = fromMe ? msg.receiver_id : msg.sender_id;

    if (state.currentDm && state.currentDm.id == otherUserId) {
      appendMessage(msg, true);
      const container = document.getElementById('messages');
      container.scrollTop = container.scrollHeight;
    }

    const existingInList = document.querySelector(`[data-dm-uid="${otherUserId}"]`);
    if (!existingInList) {
      loadDmList();
      if (!state.members.find(u => u.id == otherUserId)) loadMembers();
      if (!state.dmOpen) toggleDmSection();
    } else if (!fromMe && !(state.currentDm && state.currentDm.id == otherUserId)) {
      let b = existingInList.querySelector('.badge');
      if (!b) { b = document.createElement('span'); b.className = 'badge'; existingInList.appendChild(b); }
      b.textContent = (parseInt(b.textContent || 0) + 1);
    }

    if (!fromMe && !(state.currentDm && state.currentDm.id == otherUserId)) {
      const senderName = msg.sender_username || msg.username || 'Someone';
      const preview = msg.type === 'gif' ? '🖼 GIF' : (msg.content || '').slice(0, 40);
      toast(`💬 ${senderName}: ${preview}`, 'info');
    }
  });
  socket.on('dm:typing', ({ fromUsername }) => { if (state.currentDm) showTyping(`${fromUsername} is typing...`); });
  socket.on('system:message', ({ text, type }) => appendSystemMsg(text, type==='ban'?'sys-ban':type==='mod'?'sys-mod':''));
  socket.on('role:update', ({ role }) => { state.user.role=role; localStorage.setItem('user',JSON.stringify(state.user)); renderSelf(); toast(`You are now a ${role}!`,'success'); });
  socket.on('voice:peers',       (d) => voiceOnPeers(d));
  socket.on('voice:user-joined', (d) => voiceOnUserJoined(d));
  socket.on('voice:user-left',   (d) => voiceOnUserLeft(d));
  socket.on('voice:offer',       (d) => voiceOnOffer(d));
  socket.on('voice:answer',      (d) => voiceOnAnswer(d));
  socket.on('voice:ice',         (d) => voiceOnIce(d));
  socket.on('voice:members',     (d) => renderVoiceMembers(d));
  socket.on('voice:mute-update', (d) => voiceOnMuteUpdate(d));
}

async function loadRooms() {
  const rooms = await api('GET', '/api/rooms');
  if (!rooms) return;
  state.rooms = rooms;
  renderChannelList();
  const first = rooms.find((r) => r.type === 'text');
  if (first) selectRoom(first);
}

function renderChannelList() {
  const list = document.getElementById('channelList');
  const textRooms  = state.rooms.filter((r) => r.type !== 'voice');
  const voiceRooms2 = state.rooms.filter((r) => r.type === 'voice');
  let html = `<div class="ch-category"><span>📝 Text Channels</span>${isAdmin()?`<button class="ch-action-btn" onclick="openModal('createRoomModal')"><i class="ti ti-plus"></i></button>`:''}</div>`;
  textRooms.forEach((r) => {
    html += `<div class="ch-item${state.currentRoom?.id===r.id?' active':''}" onclick="selectRoom(${JSON.stringify(r).replace(/"/g,'&quot;')})" data-room-id="${r.id}">
      <i class="ti ${r.type==='announcement'?'ti-speakerphone':'ti-hash'}"></i><span class="ch-name">${r.name}</span>
      <div class="ch-actions">${isModPlus()?`<button class="ch-action-btn" onclick="event.stopPropagation();clearRoom(${r.id})" title="Clear"><i class="ti ti-trash"></i></button>`:''}</div>
    </div>`;
  });
  html += `<div class="ch-category" style="margin-top:16px"><span>🔊 Voice Channels</span>${isAdmin()?`<button class="ch-action-btn" onclick="openModal('createRoomModal')"><i class="ti ti-plus"></i></button>`:''}</div>`;
  voiceRooms2.forEach((r) => {
    html += `<div class="ch-item" onclick="selectVoiceRoom(${JSON.stringify(r).replace(/"/g,'&quot;')})" data-room-id="${r.id}"><i class="ti ti-volume"></i><span class="ch-name">${r.name}</span></div><div class="vc-users" id="vc-users-${r.id}"></div>`;
  });
  html += `<div class="ch-category" style="margin-top:16px" onclick="toggleDmSection()" style="cursor:pointer">
    <span>💬 Direct Messages</span>
    <button class="ch-action-btn" id="dmToggleBtn" title="Toggle DMs">
      <i class="ti ${state.dmOpen ? 'ti-chevron-down' : 'ti-chevron-right'}"></i>
    </button>
  </div>
  <div id="dmList" style="display:${state.dmOpen ? 'block' : 'none'}"></div>`;
  if (isModPlus()) html += `<div class="ch-category" style="margin-top:16px"><span>⚙️ Admin</span></div><div class="ch-item" onclick="openAdminPanel()"><i class="ti ti-shield"></i><span class="ch-name">Admin Panel</span></div>`;
  list.innerHTML = html;
  loadDmList();
  loadMembers();
}

async function selectRoom(room) {
  if (state.currentRoom) socket.emit('room:leave', state.currentRoom.id);
  state.currentRoom = typeof room === 'string' ? JSON.parse(room) : room;
  state.currentDm = null;
  document.querySelectorAll('.ch-item').forEach((el) => el.classList.remove('active'));
  document.querySelector(`[data-room-id="${state.currentRoom.id}"]`)?.classList.add('active');
  document.getElementById('headerIcon').className = `ti ${state.currentRoom.type==='announcement'?'ti-speakerphone':'ti-hash'}`;
  document.getElementById('headerName').textContent = state.currentRoom.name;
  document.getElementById('headerDesc').textContent = state.currentRoom.description ? `| ${state.currentRoom.description}` : '';
  document.getElementById('voiceJoinBtn').style.display = 'none';
  document.getElementById('chatInput').placeholder = `Message #${state.currentRoom.name}`;
  document.getElementById('inputArea').style.display = '';
  const closeDmBtn = document.getElementById('closeDmBtn');
  if (closeDmBtn) closeDmBtn.style.display = 'none';
  socket.emit('room:join', state.currentRoom.id);
  autoCloseMobileMenu();
  const msgs = await api('GET', `/api/rooms/${state.currentRoom.id}/messages`);
  const container = document.getElementById('messages');
  container.innerHTML = '';
  if (msgs && Array.isArray(msgs)) msgs.forEach((m) => appendMessage(m));
  container.scrollTop = container.scrollHeight;
  loadMembers();
}

function selectVoiceRoom(room) {
  state.currentRoom = typeof room === 'string' ? JSON.parse(room) : room;
  document.getElementById('headerIcon').className = 'ti ti-volume';
  document.getElementById('headerName').textContent = state.currentRoom.name;
  document.getElementById('headerDesc').textContent = '| Voice Channel';
  document.getElementById('voiceJoinBtn').style.display = '';
  document.getElementById('inputArea').style.display = 'none';
  document.getElementById('messages').innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-4)"><div style="font-size:56px;margin-bottom:16px">🎙️</div><div style="font-size:20px;font-weight:700;color:var(--text-2)">${state.currentRoom.name}</div><div style="margin-top:8px;font-size:14px">Click the phone icon above to join</div></div>`;
}

function appendMessage(msg, isDm=false) {
  const container = document.getElementById('messages');
  const isBottom = container.scrollHeight - container.clientHeight - container.scrollTop < 80;
  const color = msg.avatar_color || '#5865F2';
  const initials2 = msg.avatar_initials || (msg.sender_username||msg.username||'??').slice(0,2).toUpperCase();
  const avatarContent = msg.avatar_url
    ? `<img src="${msg.avatar_url}" alt="${initials2}" />`
    : initials2;
  const username = msg.sender_username || msg.username || 'Unknown';
  const role = msg.role || 'user';
  const roleClass = role !== 'user' ? `role-${role}` : '';
  const roleBadge = role !== 'user' ? `<span class="role-badge rb-${role}">${role}</span>` : '';
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const deleteBtn = isModPlus() ? `<button class="msg-action-btn" onclick="deleteMsg(${msg.id},${msg.room_id||state.currentRoom?.id})" title="Delete"><i class="ti ti-trash"></i></button>` : '';
  let content = msg.type==='gif'&&msg.gif_url ? `<div class="msg-gif"><img src="${msg.gif_url}" alt="GIF" loading="lazy"/></div>` : `<div class="msg-text">${escapeHTML(msg.content)}</div>`;
  let reactions = '';
  try { const r = typeof msg.reactions==='string'?JSON.parse(msg.reactions):msg.reactions; if(r&&r.length) reactions=buildReactionsHTML(msg.id,r); } catch(e){}
  const el = document.createElement('div');
  el.className = 'msg-group'; el.dataset.msgId = msg.id;
  el.innerHTML = `<div class="msg-cont-avatar" style="background:${msg.avatar_url?'transparent':color}">${avatarContent}</div>
    <div class="msg-body">
      <div class="msg-header">
        <span class="msg-author ${roleClass}" onclick="openUserCtx(event,${msg.sender_id||0},'${escapeHTML(username)}')">${escapeHTML(username)} ${roleBadge}</span>
        <span class="msg-time">${time}</span>
      </div>
      ${content}
      <div class="msg-reactions">${reactions}</div>
    </div>
    <div class="msg-hover-actions">
      <button class="msg-action-btn" onclick="openReactPicker(event,${msg.id})" title="React"><i class="ti ti-mood-happy"></i></button>
      ${deleteBtn}
    </div>`;
  container.appendChild(el);
  if (isBottom) container.scrollTop = container.scrollHeight;
}

function appendSystemMsg(text, cls='') {
  const container = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = `sys-msg ${cls}`;
  el.innerHTML = `<i class="ti ti-info-circle"></i><span>${escapeHTML(text)}</span>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function buildReactionsHTML(msgId, reactions) {
  if (!reactions||!reactions.length) return '';
  return reactions.filter(Boolean).map((r) => {
    const mine = r.mine==1||r.mine===true;
    return `<button class="reaction-btn${mine?' mine':''}" onclick="toggleReaction(${msgId},'${r.emoji}')">${r.emoji}<span>${r.count}</span></button>`;
  }).join('');
}

function sendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!state.currentRoom && !state.currentDm) return;
  if (state.currentDm) {
    socket.emit('dm:send', { toUserId: state.currentDm.id, content: text, type: 'text' });
  } else {
    socket.emit('message:send', { roomId: state.currentRoom.id, content: text, type: 'text' });
  }
  input.value = ''; input.style.height = 'auto';
  closeGifPicker(); closeEmojiPicker();
}

function initInputHandlers() {
  const input = document.getElementById('chatInput');
  input.addEventListener('keydown', (e) => { if (e.key==='Enter'&&!e.shiftKey) { e.preventDefault(); sendMessage(); } });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    if (!state.currentRoom&&!state.currentDm) return;
    if (state.currentDm) socket.emit('dm:typing', { toUserId: state.currentDm.id });
    else socket.emit('room:typing', { roomId: state.currentRoom.id });
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => showTyping(''), 3000);
  });
}

function showTyping(text) {
  document.getElementById('typingIndicator').textContent = text;
  if (text) { clearTimeout(state.typingTimeout); state.typingTimeout = setTimeout(() => showTyping(''), 3000); }
}

async function loadDmList() {
  const convos = await api('GET', '/api/dm');
  const list = document.getElementById('dmList');
  if (!list||!convos) return;
  list.innerHTML = convos.map((u) => `
    <div class="ch-item" data-dm-uid="${u.id}" onclick="openDm(${JSON.stringify(u).replace(/"/g,'&quot;')})">
      <div style="width:20px;height:20px;border-radius:50%;background:${u.avatar_color};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;flex-shrink:0;position:relative">
        ${u.avatar_initials}<div class="u-dot dot-${state.onlineUsers.has(u.id)?'online':'offline'}" style="width:8px;height:8px;border-width:1.5px"></div>
      </div>
      <span class="ch-name">${escapeHTML(u.username)}</span>
      ${u.unread>0?`<span class="badge">${u.unread}</span>`:''}
    </div>`).join('');
}

function toggleDmSection() {
  state.dmOpen = !state.dmOpen;
  const list = document.getElementById('dmList');
  const btn  = document.getElementById('dmToggleBtn');
  if (list) list.style.display = state.dmOpen ? 'block' : 'none';
  if (btn)  btn.innerHTML = `<i class="ti ${state.dmOpen ? 'ti-chevron-down' : 'ti-chevron-right'}"></i>`;
}

async function openDm(user) {
  user = typeof user === 'string' ? JSON.parse(user) : user;
  if (state.currentRoom) { socket.emit('room:leave', state.currentRoom.id); state.currentRoom = null; }
  state.currentDm = user;
  document.querySelectorAll('.ch-item').forEach((el) => el.classList.remove('active'));
  document.querySelector(`[data-dm-uid="${user.id}"]`)?.classList.add('active');
  document.getElementById('headerIcon').className = 'ti ti-user';
  document.getElementById('headerName').textContent = user.username;
  document.getElementById('headerDesc').textContent = '';
  document.getElementById('voiceJoinBtn').style.display = 'none';
  document.getElementById('inputArea').style.display = '';
  document.getElementById('chatInput').placeholder = `Message ${user.username}`;
  let closeDmBtn = document.getElementById('closeDmBtn');
  if (!closeDmBtn) {
    closeDmBtn = document.createElement('button');
    closeDmBtn.id = 'closeDmBtn';
    closeDmBtn.className = 'btn-action';
    closeDmBtn.style.cssText = 'font-size:13px;padding:5px 12px;background:rgba(237,66,69,0.2);color:var(--danger);border:none;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:5px;';
    closeDmBtn.innerHTML = '<i class="ti ti-x"></i> close';
    closeDmBtn.onclick = closeDm;
    document.querySelector('.header-actions').prepend(closeDmBtn);
  }
  closeDmBtn.style.display = '';
  document.querySelector(`[data-dm-uid="${user.id}"] .badge`)?.remove();
  autoCloseMobileMenu();
  const msgs = await api('GET', `/api/dm/${user.id}`);
  const container = document.getElementById('messages');
  container.innerHTML = '';
  if (msgs && Array.isArray(msgs)) msgs.forEach((m) => appendMessage(m, true));
  container.scrollTop = container.scrollHeight;
}

async function loadMembers() {
  const users = await api('GET', '/api/rooms/members');
  if (!users || !Array.isArray(users)) return;
  state.members = users;
  renderMembers();
}

function renderMembers() {
  const panel = document.getElementById('membersPanel');
  if (!state.members.length) return;
  const admins = state.members.filter((u) => u.role==='admin');
  const mods   = state.members.filter((u) => u.role==='moderator');
  const online = state.members.filter((u) => u.role==='user' && state.onlineUsers.has(u.id));
  const offline= state.members.filter((u) => u.role==='user' && !state.onlineUsers.has(u.id));
  const renderGroup = (title, members) => {
    if (!members.length) return '';
    return `<div class="members-cat">${title} — ${members.length}</div>` +
      members.map((u) => {
        const online2 = state.onlineUsers.has(u.id);
        const nc = u.role==='admin'?'color:var(--red)':u.role==='moderator'?'color:var(--yellow)':'';
        return `<div class="member-item${!online2&&u.role==='user'?' offline':''}" onclick="openUserCtx(event,${u.id},'${escapeHTML(u.username)}')" data-uid="${u.id}">
          <div class="u-avatar" style="background:${u.avatar_color||'#5865F2'};width:32px;height:32px;font-size:12px;border-radius:50%">
            ${u.avatar_initials||u.username.slice(0,2).toUpperCase()}
            <div class="u-dot dot-${online2?'online':'offline'}"></div>
          </div>
          <div><div class="m-name" style="${nc}">${escapeHTML(u.username)}</div>${u.is_guest?'<div class="m-role">Guest</div>':''}</div>
        </div>`;
      }).join('');
  };
  panel.innerHTML = renderGroup('ADMIN',admins)+renderGroup('MODERATORS',mods)+renderGroup('ONLINE',online)+renderGroup('OFFLINE',offline);
}

function toggleMembers() {
  if (window.innerWidth <= 768) {
    document.getElementById('membersPanel').classList.toggle('mobile-open');
  } else {
    state.membersVisible = !state.membersVisible;
    document.getElementById('membersPanel').classList.toggle('hidden', !state.membersVisible);
  }
}

let gifDebounce;
function toggleGifPicker() {
  const p = document.getElementById('gifPicker');
  const open = p.classList.contains('open');
  closeEmojiPicker();
  if (open) { p.classList.remove('open'); return; }
  p.classList.add('open');
  loadGifs('trending');
  document.getElementById('gifSearch').value = '';
  document.getElementById('gifSearch').oninput = (e) => { clearTimeout(gifDebounce); gifDebounce = setTimeout(() => loadGifs(e.target.value||'trending'), 400); };
}
function closeGifPicker() { document.getElementById('gifPicker').classList.remove('open'); }

async function loadGifs(query) {
  const grid = document.getElementById('gifGrid');
  grid.innerHTML = '<div style="color:var(--text-4);font-size:13px;grid-column:1/-1;padding:8px">Loading...</div>';
  const endpoint = query==='trending'?'/api/gifs/trending':`/api/gifs/search?q=${encodeURIComponent(query)}`;
  const gifs = await api('GET', endpoint);
  if (!gifs||!gifs.length) { grid.innerHTML = '<div style="color:var(--text-4);font-size:13px;grid-column:1/-1;padding:8px">No GIFs found</div>'; return; }
  grid.innerHTML = gifs.map((g) => `<div class="gif-item" onclick="sendGif('${g.url}')"><img src="${g.preview||g.url}" loading="lazy" alt="GIF"/></div>`).join('');
}

function sendGif(url) {
  if (!state.currentRoom&&!state.currentDm) return;
  if (state.currentDm) socket.emit('dm:send', { toUserId: state.currentDm.id, type: 'gif', gifUrl: url });
  else socket.emit('message:send', { roomId: state.currentRoom.id, type: 'gif', gifUrl: url });
  closeGifPicker();
}

const EMOJIS = {
  '😀':['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','😗','😙','😚','🙂','🤗','🤩','🤔','😐','😑','😶','🙄','😏','😣','😥','😮','😯','😪','😫','🥱','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑','😲','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳','😵','😠','😡','🤬'],
  '👍':['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👋','🤚','🖐️','✋','🖖','👏','🙌','🤝','🙏','💪','👀','💋'],
  '❤️':['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝'],
  '🎉':['🎉','🎊','🎈','🎁','🎀','🏆','🥇','🥈','🥉','🏅','🎯','🎮','🕹️','🎲','🧩','🎭','🎨','🎬','🎤','🎧','🎵','🎶'],
  '🐶':['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🦆','🦉','🐺'],
  '🍕':['🍕','🍔','🌮','🌯','🥪','🥗','🍜','🍝','🍛','🍲','🍱','🍣','🍙','🍚','🧁','🎂','🍰','🍩','🍪','🍫','🍬','🍭','☕','🍵','🍺','🍻'],
};
let reactingMsgId = null;

function initEmojiPicker() {
  const cats = document.getElementById('emojiCats');
  cats.innerHTML = Object.keys(EMOJIS).map((k,i) => `<button class="emoji-cat-btn${i===0?' active':''}" onclick="showEmojiCat('${k}',this)">${k}</button>`).join('');
  showEmojiCat(Object.keys(EMOJIS)[0]);
  document.getElementById('emojiSearch').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    if (!q) { showEmojiCat(Object.keys(EMOJIS)[0]); return; }
    const all = Object.values(EMOJIS).flat();
    document.getElementById('emojiGrid').innerHTML = all.map((em) => `<button class="emoji-btn" onclick="insertEmoji('${em}')">${em}</button>`).join('');
  };
}

function showEmojiCat(cat, btn) {
  document.querySelectorAll('.emoji-cat-btn').forEach((b) => b.classList.remove('active'));
  btn?.classList.add('active');
  document.getElementById('emojiGrid').innerHTML = (EMOJIS[cat]||[]).map((em) => `<button class="emoji-btn" onclick="insertEmoji('${em}')">${em}</button>`).join('');
}

function insertEmoji(em) {
  if (reactingMsgId) {
    socket.emit('reaction:toggle', { messageId: reactingMsgId, emoji: em, roomId: state.currentRoom?.id });
    closeEmojiPicker(); reactingMsgId = null; return;
  }
  const input = document.getElementById('chatInput');
  const pos = input.selectionStart;
  input.value = input.value.slice(0,pos)+em+input.value.slice(pos);
  input.focus(); input.selectionStart = input.selectionEnd = pos+em.length;
  closeEmojiPicker();
}

function toggleEmojiPicker() {
  const p = document.getElementById('emojiPicker');
  const open = p.classList.contains('open');
  closeGifPicker(); reactingMsgId = null;
  if (open) { p.classList.remove('open'); return; }
  p.classList.add('open');
}
function closeEmojiPicker() { document.getElementById('emojiPicker').classList.remove('open'); reactingMsgId=null; }

function openReactPicker(event, msgId) {
  event.stopPropagation(); reactingMsgId = msgId;
  closeGifPicker(); document.getElementById('emojiPicker').classList.add('open');
}

function toggleReaction(msgId, emoji) {
  if (!state.currentRoom?.id) return;
  socket.emit('reaction:toggle', { messageId: msgId, emoji, roomId: state.currentRoom.id });
}

function deleteMsg(msgId, roomId) { socket.emit('message:delete', { messageId: msgId, roomId: roomId||state.currentRoom?.id }); }
function clearRoom(roomId) { if (!confirm('Clear all messages in this channel?')) return; socket.emit('room:clear', { roomId }); }

async function createRoom() {
  const name = document.getElementById('newRoomName').value.trim();
  const desc = document.getElementById('newRoomDesc').value.trim();
  const type = document.getElementById('newRoomType').value;
  if (!name) return;
  const result = await api('POST', '/api/rooms', { name, description: desc, type });
  if (result?.id) { closeModal('createRoomModal'); await loadRooms(); toast('Channel created!','success'); }
  else toast(result?.error||'Failed','error');
}

function openUserCtx(event, userId, username) {
  event.preventDefault(); event.stopPropagation();
  if (!userId || userId == state.user.id) return;
  const menu = document.getElementById('ctxMenu');
  let items = `<div class="ctx-item" onclick="openDmByInfo(${userId},'${username}')">💬 Send DM</div>`;
  if (isModPlus()) {
    items += `<div class="ctx-sep"></div>`;
    if (isAdmin()) items += `<div class="ctx-item" onclick="assignMod(${userId},'${username}')">⭐ Make Moderator</div>`;
    items += `<div class="ctx-item danger" onclick="openBanModal(${userId},'${username}')">🔨 Ban User</div>`;
  }
  menu.innerHTML = items;
  menu.style.left = Math.min(event.clientX, window.innerWidth-180)+'px';
  menu.style.top  = Math.min(event.clientY, window.innerHeight-200)+'px';
  menu.classList.add('open');
}

function openDmByInfo(userId, username) {
  closeCtx();
  const user = state.members.find((u) => u.id==userId) || { id:userId, username, avatar_color:'#5865F2', avatar_initials: username.slice(0,2).toUpperCase() };
  openDm(user);
}

function openBanModal(userId, username) {
  closeCtx();
  state.pendingBanUserId = userId;
  document.getElementById('banModalTitle').textContent = `Ban ${username}`;
  document.getElementById('banReason').value = '';
  document.getElementById('banDuration').value = '';
  openModal('banModal');
}

function confirmBan() {
  if (!state.pendingBanUserId) return;
  const reason = document.getElementById('banReason').value.trim();
  const dur = document.getElementById('banDuration').value;
  socket.emit('admin:ban', { userId: state.pendingBanUserId, reason, duration: dur ? parseInt(dur) : null });
  closeModal('banModal'); state.pendingBanUserId = null;
  toast('User banned','success');
}

function assignMod(userId, username) {
  closeCtx();
  if (!confirm(`Make ${username} a Moderator?`)) return;
  socket.emit('admin:set-mod', { userId });
}

function closeCtx() { document.getElementById('ctxMenu').classList.remove('open'); }

document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctxMenu')) closeCtx();
  if (!e.target.closest('#gifPicker')&&!e.target.closest('.ti-gif')?.closest('.input-icon')) closeGifPicker();
  if (!e.target.closest('#emojiPicker')&&!e.target.closest('.ti-mood-happy')?.closest('.input-icon')&&!e.target.closest('.msg-action-btn')) closeEmojiPicker();
});

let adminSearch = '';
let adminCurrentTab = 'users';
let adminAllUsers = [];

async function openAdminPanel() {
  openModal('adminModal');
  await adminTab('users', document.querySelector('#adminModal .tab-btn'));
}

async function adminTab(tab, btn) {
  adminCurrentTab = tab;
  document.querySelectorAll('#adminModal .tab-btn').forEach((b) => b.classList.remove('active'));
  btn?.classList.add('active');
  const content = document.getElementById('adminContent');
  content.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;padding:32px;color:var(--text-muted)"><i class="ti ti-loader" style="font-size:22px;animation:spin 1s linear infinite"></i></div>`;

  if (tab === 'users') {
    const users = await api('GET', '/api/admin/users');
    if (!users || users.error) { content.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger)">Failed to load users</div>`; return; }
    adminAllUsers = users;
    adminSearch = '';
    renderAdminUsers(users);

  } else if (tab === 'bans') {
    const bans = await api('GET', '/api/admin/bans');
    if (!bans || bans.error) { content.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger)">Failed to load bans</div>`; return; }
    renderAdminBans(bans);

  } else if (tab === 'rooms') {
    const rooms = await api('GET', '/api/rooms');
    if (!rooms || rooms.error) { content.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger)">Failed to load rooms</div>`; return; }
    renderAdminRooms(rooms);
  }
}

function renderAdminUsers(users) {
  const content = document.getElementById('adminContent');
  const total   = users.length;
  const admins  = users.filter(u => u.role === 'admin').length;
  const mods    = users.filter(u => u.role === 'moderator').length;
  const guests  = users.filter(u => u.is_guest).length;
  const online  = users.filter(u => u.status === 'online').length;

  const filtered = adminSearch
    ? users.filter(u => u.username?.toLowerCase().includes(adminSearch) || u.email?.toLowerCase().includes(adminSearch))
    : users;

  content.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      ${statChip('ti-users','Total',total,'var(--accent)')}
      ${statChip('ti-circle-check','Online',online,'var(--success)')}
      ${statChip('ti-shield','Admins',admins,'var(--danger)')}
      ${statChip('ti-star','Mods',mods,'var(--warning)')}
      ${statChip('ti-user-question','Guests',guests,'var(--text-muted)')}
    </div>
    <div style="position:relative;margin-bottom:12px">
      <i class="ti ti-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:14px;pointer-events:none"></i>
      <input id="adminSearchInput" value="${escapeHTML(adminSearch)}"
        placeholder="Search by username or email…"
        oninput="adminSearch=this.value.toLowerCase();renderAdminUsers(adminAllUsers)"
        style="width:100%;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:8px 10px 8px 32px;color:var(--text-primary);font-size:13px;font-family:var(--font);outline:none"/>
    </div>
    <div style="max-height:320px;overflow-y:auto">
      ${filtered.length === 0
        ? `<div style="padding:24px;text-align:center;color:var(--text-muted)">No users found</div>`
        : filtered.map(u => adminUserRow(u)).join('')}
    </div>`;
}

function statChip(icon, label, val, color) {
  return `<div style="display:flex;align-items:center;gap:6px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;color:var(--text-secondary)">
    <i class="ti ${icon}" style="color:${color};font-size:14px"></i>
    <span style="color:var(--text-muted)">${label}</span>
    <span style="font-weight:700;color:var(--text-primary)">${val}</span>
  </div>`;
}

function adminUserRow(u) {
  const isSelf   = u.id === state.user?.id;
  const isAdminU = u.role === 'admin';
  const roleColor = u.role==='admin' ? 'var(--danger)' : u.role==='moderator' ? 'var(--warning)' : 'var(--text-muted)';
  const roleIcon  = u.role==='admin' ? 'ti-shield-filled' : u.role==='moderator' ? 'ti-star-filled' : 'ti-user';
  const statusDot = {online:'var(--success)',idle:'var(--warning)',dnd:'var(--danger)',offline:'#4e5058'}[u.status]||'#4e5058';
  const joinDate  = u.created_at ? new Date(u.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const avatarContent = u.avatar_url
    ? `<img src="${u.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover"/>`
    : `<span>${u.avatar_initials||u.username?.slice(0,2).toUpperCase()||'??'}</span>`;

  return `<div class="admin-user-row" style="display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:8px;transition:background 0.1s" onmouseover="this.style.background='rgba(255,255,255,0.04)'" onmouseout="this.style.background='transparent'">
    <div style="position:relative;flex-shrink:0">
      <div style="width:36px;height:36px;border-radius:50%;background:${u.avatar_url?'transparent':u.avatar_color||'#5865F2'};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;overflow:hidden">${avatarContent}</div>
      <div style="position:absolute;bottom:-1px;right:-1px;width:10px;height:10px;border-radius:50%;background:${statusDot};border:2px solid var(--bg-secondary)"></div>
    </div>
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:13px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${escapeHTML(u.username||'?')}</span>
        ${u.is_guest?`<span style="font-size:10px;background:rgba(255,255,255,0.08);color:var(--text-muted);border-radius:4px;padding:1px 5px">Guest</span>`:''}
        ${isSelf?`<span style="font-size:10px;background:rgba(88,101,242,0.2);color:var(--accent);border-radius:4px;padding:1px 5px">You</span>`:''}
      </div>
      <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px">${u.email||'No email'}</div>
    </div>
    <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
      <i class="ti ${roleIcon}" style="font-size:13px;color:${roleColor}"></i>
      <span style="font-size:11px;font-weight:600;color:${roleColor};text-transform:capitalize">${u.role}</span>
    </div>
    <div style="font-size:11px;color:var(--text-muted);flex-shrink:0;min-width:70px;text-align:right">${joinDate}</div>
    ${!isSelf && !isAdminU && isAdmin() ? `
    <div style="display:flex;gap:4px;flex-shrink:0">
      ${u.role==='user'
        ? `<button class="admin-btn admin-btn-mod" title="Promote to Moderator" onclick="adminPromoteMod(${u.id},'${escapeHTML(u.username)}')"><i class="ti ti-star" style="font-size:11px"></i> +Mod</button>`
        : `<button class="admin-btn" style="background:rgba(240,177,50,0.15);color:var(--warning)" title="Remove Moderator" onclick="adminRemoveMod(${u.id},'${escapeHTML(u.username)}')"><i class="ti ti-star-off" style="font-size:11px"></i> -Mod</button>`
      }
      <button class="admin-btn admin-btn-ban" title="Ban User" onclick="closeModal('adminModal');openBanModal(${u.id},'${escapeHTML(u.username)}')"><i class="ti ti-ban" style="font-size:11px"></i> Ban</button>
    </div>` : !isSelf && isModPlus() && u.role==='user' ? `
    <div style="display:flex;gap:4px;flex-shrink:0">
      <button class="admin-btn admin-btn-ban" title="Ban User" onclick="closeModal('adminModal');openBanModal(${u.id},'${escapeHTML(u.username)}')"><i class="ti ti-ban" style="font-size:11px"></i> Ban</button>
    </div>` : `<div style="width:60px"></div>`}
  </div>`;
}

function renderAdminBans(bans) {
  const content = document.getElementById('adminContent');
  if (!bans.length) {
    content.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 0;gap:12px;color:var(--text-muted)">
      <i class="ti ti-confetti" style="font-size:40px;color:var(--success)"></i>
      <div style="font-size:15px;font-weight:600;color:var(--text-secondary)">No active bans</div>
      <div style="font-size:13px">Everyone is behaving 🎉</div>
    </div>`;
    return;
  }
  content.innerHTML = `<div style="max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:4px">` +
    bans.map(b => {
      const expires = b.is_permanent ? null : (b.expires_at ? new Date(b.expires_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '?');
      return `<div class="admin-ban-row" style="display:flex;align-items:center;gap:10px;padding:10px;border-radius:8px;background:rgba(237,66,69,0.05);border:1px solid rgba(237,66,69,0.12)">
        <div style="width:36px;height:36px;border-radius:50%;background:rgba(237,66,69,0.2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="ti ti-ban" style="color:var(--danger);font-size:16px"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700;color:var(--text-primary)">${escapeHTML(b.banned_username||'Deleted User')}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
            <span style="color:var(--text-secondary)">By ${escapeHTML(b.banned_by_username||'?')}</span>
            ${b.reason ? ` · <span style="font-style:italic">${escapeHTML(b.reason)}</span>` : ''}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          ${b.is_permanent
            ? `<span style="font-size:11px;font-weight:700;background:rgba(237,66,69,0.2);color:var(--danger);border-radius:6px;padding:3px 8px">🔴 Permanent</span>`
            : `<span style="font-size:11px;background:rgba(240,177,50,0.15);color:var(--warning);border-radius:6px;padding:3px 8px">⏱ Until ${expires}</span>`}
        </div>
        ${isAdmin() ? `<button class="admin-btn admin-btn-unban" onclick="adminUnban(${b.user_id})"><i class="ti ti-user-check" style="font-size:11px"></i> Unban</button>` : ''}
      </div>`;
    }).join('') + `</div>`;
}

function renderAdminRooms(rooms) {
  const content = document.getElementById('adminContent');
  const typeIcon = { text:'ti-hash', announcement:'ti-speakerphone', voice:'ti-volume' };
  const typeColor = { text:'var(--text-muted)', announcement:'var(--warning)', voice:'var(--success)' };
  content.innerHTML = `
    ${isAdmin() ? `<div style="margin-bottom:12px">
      <button class="btn-action" style="font-size:13px;padding:7px 14px" onclick="closeModal('adminModal');openModal('createRoomModal')">
        <i class="ti ti-plus"></i> New Channel
      </button>
    </div>` : ''}
    <div style="max-height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:4px">
    ${rooms.map(r => `
      <div style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;background:var(--bg-tertiary);border:1px solid var(--border)">
        <i class="ti ${typeIcon[r.type]||'ti-hash'}" style="font-size:18px;color:${typeColor[r.type]||'var(--text-muted)'};flex-shrink:0;width:20px;text-align:center"></i>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${escapeHTML(r.name)}</div>
          ${r.description ? `<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHTML(r.description)}</div>` : ''}
        </div>
        <span style="font-size:10px;text-transform:uppercase;font-weight:700;color:${typeColor[r.type]||'var(--text-muted)'};background:rgba(255,255,255,0.06);border-radius:4px;padding:2px 7px">${r.type}</span>
        ${isModPlus() ? `<button class="admin-btn" style="background:rgba(237,66,69,0.15);color:var(--danger)" onclick="adminDeleteRoom(${r.id},'${escapeHTML(r.name)}')"><i class="ti ti-trash" style="font-size:11px"></i> Delete</button>` : ''}
      </div>`).join('')}
    </div>`;
}

async function adminPromoteMod(userId, username) {
  if (!confirm(`Promote ${username} to Moderator?`)) return;
  socket.emit('admin:set-mod', { userId });
  await api('POST', '/api/admin/moderator', { userId });
  toast(`${username} is now a Moderator`, 'success');
  const users = await api('GET', '/api/admin/users');
  if (users) { adminAllUsers = users; renderAdminUsers(users); }
}

async function adminRemoveMod(userId, username) {
  if (!confirm(`Remove Moderator from ${username}?`)) return;
  const res = await api('POST', '/api/admin/remove-mod', { userId });
  if (res?.success) {
    toast(`${username} is no longer a Moderator`, 'success');
    const users = await api('GET', '/api/admin/users');
    if (users) { adminAllUsers = users; renderAdminUsers(users); }
  } else {
    toast('Failed to remove moderator', 'error');
  }
}

async function adminUnban(userId) {
  const res = await api('POST', '/api/admin/unban', { userId });
  if (res?.success) {
    toast('User unbanned', 'success');
    const bans = await api('GET', '/api/admin/bans');
    if (bans) renderAdminBans(bans);
  } else {
    toast('Failed to unban', 'error');
  }
}

async function adminDeleteRoom(roomId, name) {
  if (!confirm(`Delete channel "${name}"? This cannot be undone.`)) return;
  const res = await api('DELETE', `/api/rooms/${roomId}`);
  if (res?.success) {
    toast(`#${name} deleted`, 'success');
    await loadRooms();
    const rooms = await api('GET', '/api/rooms');
    if (rooms) renderAdminRooms(rooms);
  } else {
    toast('Failed to delete room', 'error');
  }
}

async function unbanUser(userId) {
  await adminUnban(userId);
}

function joinVoice() {
  if (!state.currentRoom) return;
  initVoice(socket, state.currentRoom.id, state.user);
  state.voiceRoom = state.currentRoom.id;
  document.getElementById('voicePanel').classList.add('active');
  document.getElementById('voiceRoomName').textContent = state.currentRoom.name;
}

function leaveVoice() {
  disconnectVoice(socket, state.voiceRoom);
  state.voiceRoom = null;
  document.getElementById('voicePanel').classList.remove('active');
  document.getElementById('voiceUsersList').innerHTML = '';
}

function toggleMute() {
  state.muted = !state.muted; setVoiceMute(state.muted);
  const btn = document.getElementById('muteBtn');
  btn.classList.toggle('active', state.muted);
  btn.querySelector('i').className = state.muted ? 'ti ti-microphone-off' : 'ti ti-microphone';
  if (state.voiceRoom) socket.emit('voice:mute', { roomId: state.voiceRoom, muted: state.muted });
}

function toggleDeafen() {
  state.deafened = !state.deafened; setVoiceDeafen(state.deafened);
  const btn = document.getElementById('deafenBtn');
  btn.classList.toggle('active', state.deafened);
  btn.querySelector('i').className = state.deafened ? 'ti ti-headphones-off' : 'ti ti-headphones';
}

function toggleMic() { toggleMute(); }

function renderVoiceMembers({ roomId, members }) {
  const el = document.getElementById(`vc-users-${roomId}`);
  if (el) el.innerHTML = members.map((u) => `<div class="vc-user-item"><i class="ti ti-microphone" style="font-size:13px"></i>${escapeHTML(u.username)}</div>`).join('');
  if (state.voiceRoom==roomId) {
    document.getElementById('voiceUsersList').innerHTML = members.map((u) => `<div class="voice-user-chip"><div class="va" style="background:var(--accent)">${u.username.slice(0,2).toUpperCase()}</div>${escapeHTML(u.username)}</div>`).join('');
  }
}

function openStatusMenu(e) { e.stopPropagation(); openModal('settingsModal'); }
function setStatus(status) {
  socket.emit('status:set', { status });
  const dot = { online:'dot-online', idle:'dot-idle', dnd:'dot-dnd' }[status]||'dot-offline';
  document.getElementById('selfDot').className = `u-dot ${dot}`;
  document.getElementById('selfStatus').textContent = { online:'Online', idle:'Idle', dnd:'Do Not Disturb' }[status]||status;
}

function renderSelf() {
  const u = state.user; if (!u) return;
  const av = document.getElementById('selfAvatar');
  av.style.background = u.avatar_color||'#5865F2';
  av.innerHTML = `${u.avatar_initials||u.username.slice(0,2).toUpperCase()}<div class="u-dot dot-online" id="selfDot"></div>`;
  document.getElementById('selfName').textContent = u.username;
  document.getElementById('selfStatus').textContent = u.is_guest ? 'Guest' : 'Online';
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach((el) => el.addEventListener('click', (e) => { if (e.target===el) el.classList.remove('open'); }));

function logout() { localStorage.removeItem('token'); localStorage.removeItem('user'); location.href='/login'; }

function isAdmin()   { return state.user?.role==='admin'; }
function isModPlus() { return ['admin','moderator'].includes(state.user?.role); }

function initMobileMenu() {
  const overlay = document.createElement('div');
  overlay.className = 'mobile-overlay';
  overlay.id = 'mobileOverlay';
  overlay.onclick = closeMobileMenu;
  document.body.appendChild(overlay);

  const menuBtn = document.createElement('div');
  menuBtn.className = 'mobile-menu-btn';
  menuBtn.innerHTML = '<i class="ti ti-menu-2"></i>';
  menuBtn.onclick = toggleMobileMenu;
  const header = document.querySelector('.chat-header');
  header.insertBefore(menuBtn, header.firstChild);
}

function toggleMobileMenu() {
  const channels = document.querySelector('.channels');
  const overlay = document.getElementById('mobileOverlay');
  channels.classList.toggle('open');
  overlay.classList.toggle('show', channels.classList.contains('open'));
}

function closeMobileMenu() {
  document.querySelector('.channels').classList.remove('open');
  document.getElementById('mobileOverlay').classList.remove('show');
  document.getElementById('membersPanel').classList.remove('mobile-open');
}

function autoCloseMobileMenu() {
  if (window.innerWidth <= 768) closeMobileMenu();
}

function closeDm() {
  state.currentDm = null;
  const closeDmBtn = document.getElementById('closeDmBtn');
  if (closeDmBtn) closeDmBtn.style.display = 'none';
  document.querySelectorAll('.ch-item').forEach((el) => el.classList.remove('active'));
  document.getElementById('headerIcon').className = 'ti ti-hash';
  document.getElementById('headerName').textContent = 'Select a channel';
  document.getElementById('headerDesc').textContent = '';
  document.getElementById('inputArea').style.display = 'none';
  document.getElementById('messages').innerHTML = `<div class="welcome-msg"><i class="ti ti-hash" style="font-size:48px;color:#5865F2;margin-bottom:8px"></i><h2>Welcome to ChatRoom!</h2><p>Select a channel or DM to start chatting.</p></div>`;
}
function escapeHTML(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function toast(msg, type='') {
  const el = document.createElement('div'); el.className=`toast ${type}`; el.textContent=msg;
  document.body.appendChild(el); setTimeout(()=>el.remove(), 3500);
}