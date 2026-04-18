/**
 * student.js
 * - Gets student camera/mic
 * - Connects to teacher via WebRTC
 * - Connects to classmates via WebRTC
 * - Sends frames for AI engagement analysis
 * - Updates status UI
 */

const socket    = io();
const ICE_CONFIG = {
  iceServers: (window.ICE_SERVERS && window.ICE_SERVERS.length)
    ? window.ICE_SERVERS
    : [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ── State ─────────────────────────────────────────────────────────────────────
let localStream   = null;
let teacherSid    = null;
let captureTimer  = null;
let isCapturing   = true;
let isMuted       = false;
let isCamPaused   = false;
let analysisInFlight = false;
let analysisTimeout = null;
const peerConns = {};
const peerStreams = {};
const peerMeta = {};
const CAPTURE_MS  = 1500;
const ANALYSIS_MAX_WIDTH = 480;
const ANALYSIS_JPEG_QUALITY = 0.4;

// ── DOM ───────────────────────────────────────────────────────────────────────
const studentVideo = document.getElementById('student-video');
const teacherVideo = document.getElementById('teacher-video');
const canvas       = document.getElementById('capture-canvas');
const ctx          = canvas.getContext('2d');
const statusPill   = document.getElementById('status-pill');
const overlayText  = document.getElementById('overlay-text');
const statusEl     = document.getElementById('engagement-status');
const earEl        = document.getElementById('ear-value');
const alertList    = document.getElementById('alert-list');
const noAlertsMsg  = document.getElementById('no-alerts-msg');
const toggleCamBtn = document.getElementById('btn-toggle-cam');
const toggleMicBtn = document.getElementById('btn-toggle-mic');
const peerGrid     = document.getElementById('student-peer-grid');
const peerWaitingMsg = document.getElementById('peer-waiting-msg');

// ── Status labels ─────────────────────────────────────────────────────────────
const STATUS_LABELS = {
  engaged:   'Engaged',
  writing:   'Taking notes',
  sleeping:  'Sleeping',
  away:      'Looking away',
  phone_usage: 'Possible phone usage',
  no_face:   'Not visible',
  unknown:   '— Unknown',
  connected: 'Connected',
  error:     'Error',
};
const PILL_CLASS = {
  engaged:   'pill-engaged',
  writing:   'pill-engaged',
  sleeping:  'pill-sleeping',
  away:      'pill-away',
  phone_usage: 'pill-away',
  no_face:   'pill-alert',
};

function setStatusUI(status, ear) {
  const label = STATUS_LABELS[status] || status;
  statusPill.textContent = label;
  statusPill.className = 'room-status-pill ' + (PILL_CLASS[status] || '');
  statusEl.textContent = label;
  if (overlayText) {
    overlayText.textContent = (status === 'engaged' || status === 'connected') ? '' : label;
  }
  earEl.textContent = ear != null ? ear.toFixed(3) : '—';
}

// ── Camera / mic ──────────────────────────────────────────────────────────────
async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    studentVideo.srcObject = localStream;
    return true;
  } catch (err) {
    statusPill.textContent = 'Camera error';
    alert('Cannot access camera/mic: ' + err.message);
    return false;
  }
}

// ── Peer cards ────────────────────────────────────────────────────────────────
function ensurePeerCard(sid, name = 'Classmate') {
  if (!peerGrid) return null;
  let card = document.getElementById(`peer-card-${sid}`);
  if (!card) {
    card = document.createElement('div');
    card.id = `peer-card-${sid}`;
    card.className = 'student-card peer-card';
    card.innerHTML = `
      <div class="sc-video-wrap peer-video-wrap">
        <video id="peer-video-${sid}" autoplay playsinline muted class="sc-video"></video>
        <div class="sc-video-label"></div>
      </div>
    `;
    peerGrid.appendChild(card);
  }
  card.querySelector('.sc-video-label').textContent = name;
  if (peerWaitingMsg) peerWaitingMsg.style.display = 'none';
  return card;
}

function attachPeerStream(sid) {
  const video = document.getElementById(`peer-video-${sid}`);
  const stream = peerStreams[sid];
  if (!video || !stream) return;
  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
  video.muted = true;
  video.play().catch(() => {});
}

function removePeerCard(sid) {
  delete peerMeta[sid];
  delete peerStreams[sid];
  document.getElementById(`peer-card-${sid}`)?.remove();
  updatePeerWaiting();
}

function updatePeerWaiting() {
  if (!peerWaitingMsg || !peerGrid) return;
  const hasCards = !!peerGrid.querySelector('.peer-card');
  peerWaitingMsg.style.display = hasCards ? 'none' : '';
}

// ── WebRTC helpers ────────────────────────────────────────────────────────────
function createPeerConnection(remoteSid, role = 'student') {
  if (peerConns[remoteSid]) {
    return peerConns[remoteSid];
  }

  const pc = new RTCPeerConnection(ICE_CONFIG);
  peerConns[remoteSid] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.ontrack = (event) => {
    const stream = event.streams && event.streams[0] ? event.streams[0] : null;
    if (!stream) return;

    if (role === 'teacher' || remoteSid === teacherSid) {
      teacherVideo.srcObject = stream;
    } else {
      peerStreams[remoteSid] = stream;
      ensurePeerCard(remoteSid, peerMeta[remoteSid]?.name || 'Classmate');
      attachPeerStream(remoteSid);
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc_ice', {
        target_sid: remoteSid,
        candidate: event.candidate,
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if ((role === 'teacher' || remoteSid === teacherSid) && pc.connectionState === 'connected') {
      statusPill.textContent = 'Connected';
      statusPill.className = 'room-status-pill pill-engaged';
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (remoteSid !== teacherSid) {
        removePeerCard(remoteSid);
      }
    }
  };

  return pc;
}

async function createOfferForPeer(remoteSid, role = 'student') {
  const pc = createPeerConnection(remoteSid, role);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc_offer', {
    target_sid: remoteSid,
    sdp: offer,
  });
}

async function handleIncomingOffer(data) {
  const remoteSid = data.from_sid;
  const isTeacher = teacherSid === remoteSid || !teacherSid;
  if (isTeacher) {
    teacherSid = remoteSid;
  }
  const role = remoteSid === teacherSid ? 'teacher' : 'student';
  const pc = createPeerConnection(remoteSid, role);
  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc_answer', {
    target_sid: remoteSid,
    sdp: answer,
  });
}

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('connect', async () => {
  const ok = await startLocalMedia();
  if (!ok) return;

  socket.emit('student_join', {
    meeting_code: MEETING_CODE,
    name: STUDENT_NAME,
  });
});

socket.on('joined_ok', () => {
  startCapture();
});

socket.on('student_roster', async (data) => {
  const peers = data.students || [];
  for (const peer of peers) {
    if (!peer.sid || peer.sid === socket.id) continue;
    peerMeta[peer.sid] = { name: peer.name || 'Classmate' };
    ensurePeerCard(peer.sid, peerMeta[peer.sid].name);
    await createOfferForPeer(peer.sid, 'student');
  }
  updatePeerWaiting();
});

socket.on('student_joined', (data) => {
  if (!data?.sid || data.sid === socket.id) return;
  peerMeta[data.sid] = { name: data.name || 'Classmate' };
  ensurePeerCard(data.sid, peerMeta[data.sid].name);
  updatePeerWaiting();
});

// Teacher is already in the room — wait for their offer
socket.on('teacher_present', (data) => {
  teacherSid = data.host_sid;
  statusPill.textContent = 'Teacher connected';
});

socket.on('webrtc_offer', async (data) => {
  await handleIncomingOffer(data);
});

socket.on('webrtc_answer', async (data) => {
  const pc = peerConns[data.from_sid];
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  }
});

socket.on('webrtc_ice', async (data) => {
  const pc = peerConns[data.from_sid];
  if (pc && data.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (e) {
      console.warn('ICE error', e);
    }
  }
});

socket.on('analysis_result', (result) => {
  analysisInFlight = false;
  clearTimeout(analysisTimeout);
  analysisTimeout = null;
  setStatusUI(result.status, result.ear);
  if (result.alert) addAlert(result.alert, result.alert_type);
});

socket.on('student_left', (data) => {
  const sid = data?.sid;
  if (!sid) return;
  peerConns[sid]?.close();
  delete peerConns[sid];
  removePeerCard(sid);
});

socket.on('meeting_ended', () => {
  analysisInFlight = false;
  stopCapture();
  alert('The teacher has ended this meeting.');
  window.location.href = '/student';
});

socket.on('teacher_left', () => {
  if (teacherVideo) teacherVideo.srcObject = null;
  if (teacherSid && peerConns[teacherSid]) {
    peerConns[teacherSid].close();
    delete peerConns[teacherSid];
  }
  teacherSid = null;
  statusPill.textContent = 'Teacher disconnected';
  statusPill.className = 'room-status-pill';
});

socket.on('disconnect', () => {
  analysisInFlight = false;
  stopCapture();
  statusPill.textContent = 'Disconnected';
});

// ── Frame capture for AI ──────────────────────────────────────────────────────
function captureAndSend() {
  if (!localStream || !isCapturing || analysisInFlight || !socket.connected) return;
  const w = studentVideo.videoWidth;
  const h = studentVideo.videoHeight;
  if (!w || !h) return;

  const scale = Math.min(1, ANALYSIS_MAX_WIDTH / w);
  const scaledW = Math.max(1, Math.round(w * scale));
  const scaledH = Math.max(1, Math.round(h * scale));

  canvas.width = scaledW;
  canvas.height = scaledH;
  ctx.drawImage(studentVideo, 0, 0, scaledW, scaledH);
  const dataUrl = canvas.toDataURL('image/jpeg', ANALYSIS_JPEG_QUALITY);

  analysisInFlight = true;
  analysisTimeout = setTimeout(() => {
    analysisInFlight = false;
    analysisTimeout = null;
  }, 6000);

  socket.emit('frame_analysis', {
    meeting_code: MEETING_CODE,
    frame: dataUrl,
  });
}

function startCapture() {
  if (captureTimer) return;
  captureTimer = setInterval(captureAndSend, CAPTURE_MS);
}

function stopCapture() {
  clearInterval(captureTimer);
  captureTimer = null;
  clearTimeout(analysisTimeout);
  analysisTimeout = null;
  analysisInFlight = false;
}

// ── Controls ──────────────────────────────────────────────────────────────────
toggleCamBtn.addEventListener('click', () => {
  isCamPaused = !isCamPaused;
  localStream.getVideoTracks().forEach((t) => { t.enabled = !isCamPaused; });
  toggleCamBtn.textContent = isCamPaused ? 'Resume Cam' : 'Pause Cam';
  if (isCamPaused) stopCapture(); else startCapture();
});

toggleMicBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !isMuted; });
  toggleMicBtn.textContent = isMuted ? 'Unmute' : 'Mute';
  toggleMicBtn.classList.toggle('btn-danger', isMuted);
});

// ── Alert panel ───────────────────────────────────────────────────────────────
const shownAlerts = new Set();

function addAlert(message, type) {
  const key = `${type}:${message}`;
  if (shownAlerts.has(key)) return;
  shownAlerts.add(key);
  setTimeout(() => shownAlerts.delete(key), 8000);

  if (noAlertsMsg) noAlertsMsg.style.display = 'none';
  const item = document.createElement('div');
  item.className = `alert-item type-${type || 'unknown'}`;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  item.innerHTML = `<div class="alert-msg">${message}</div><div class="alert-time">${time}</div>`;
  alertList.prepend(item);
}
