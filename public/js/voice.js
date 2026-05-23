const peers = new Map(); 
let localStream = null;
let voiceRoomId = null;

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
  ],
};

async function initVoice(socket, roomId, user) {
  voiceRoomId = roomId;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    socket.emit('voice:join', { roomId });
  } catch (e) {
    toast('Could not access microphone: ' + e.message, 'error');
    voiceRoomId = null;
  }
}

function disconnectVoice(socket, roomId) {
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  peers.forEach((pc) => pc.close());
  peers.clear();
  document.querySelectorAll('audio[id^="audio-"]').forEach(el => el.remove());
  if (roomId) socket.emit('voice:leave', { roomId });
  voiceRoomId = null;
}


async function voiceOnPeers(peersList) {
  for (const peer of peersList) {
    const pc = createPeer(peer.peerId);
   try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('voice:offer', { toPeerId: peer.peerId, offer });
    } catch (e) {
      console.error('[voice] offer error:', e);
    }
  }
}

async function voiceOnUserJoined({ peerId, userId, username }) {

  if (!peers.has(peerId)) {
    createPeer(peerId);
  }
}

function voiceOnUserLeft({ peerId }) {
  const pc = peers.get(peerId);
  if (pc) { pc.close(); peers.delete(peerId); }
  document.getElementById(`audio-${peerId}`)?.remove();
}

async function voiceOnOffer({ fromPeerId, offer }) {
  let pc = peers.get(fromPeerId);
  if (!pc) pc = createPeer(fromPeerId);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('voice:answer', { toPeerId: fromPeerId, answer });
  } catch (e) {
    console.error('[voice] answer error:', e);
  }
}


async function voiceOnAnswer({ fromPeerId, answer }) {
  const pc = peers.get(fromPeerId);
  if (!pc) return;
  try {
    if (pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  } catch (e) {
    console.error('[voice] setRemoteDescription error:', e);
  }
}

async function voiceOnIce({ fromPeerId, candidate }) {
  const pc = peers.get(fromPeerId);
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
  }
}

function voiceOnMuteUpdate({ userId, muted }) {
  const chip = document.querySelector(`.voice-user-chip[data-uid="${userId}"]`);
  if (chip) chip.style.opacity = muted ? '0.5' : '1';
}

function createPeer(peerId) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(RTC_CONFIG);

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('voice:ice', { toPeerId: peerId, candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    let audio = document.getElementById(`audio-${peerId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${peerId}`;
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
    }
    if (e.streams && e.streams[0]) {
      audio.srcObject = e.streams[0];
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[voice] peer ${peerId} state: ${pc.connectionState}`);
    if (pc.connectionState === 'failed') {
      pc.restartIce();
    }
    if (pc.connectionState === 'closed') {
      peers.delete(peerId);
      document.getElementById(`audio-${peerId}`)?.remove();
    }
  };

  peers.set(peerId, pc);
  return pc;
}

function setVoiceMute(muted) {
  if (localStream) {
    localStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  }
}

function setVoiceDeafen(deafened) {
  document.querySelectorAll('audio[id^="audio-"]').forEach((el) => { el.muted = deafened; });
}