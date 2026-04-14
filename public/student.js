// =============================================================================
// STUDENT — WebRTC Audio Classroom
// =============================================================================

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room") || "test";
let studentName = urlParams.get("name") || "Student-" + Math.random().toString(36).substr(2, 6);

document.getElementById("roomDisplay").textContent = roomId;
document.getElementById("studentNameDisplay").textContent = studentName;

const socket = io({ transports: ["websocket", "polling"], upgrade: true });

// ── DOM refs ──────────────────────────────────────────────────────────────
const connectionStatus    = document.getElementById("connectionStatus");
const teacherStatus       = document.getElementById("teacherStatus");
const audioStatus         = document.getElementById("audioStatus");
const visualizer          = document.getElementById("audioVisualizer");
const testAudioBtn        = document.getElementById("testAudioBtn");
const unlockAudioBtn      = document.getElementById("unlockAudioBtn");
const audioWarning        = document.getElementById("audioWarning");
const raiseHandBtn        = document.getElementById("raiseHandBtn");
const cancelHandBtn       = document.getElementById("cancelHandBtn");
const speakingIndicator   = document.getElementById("speakingIndicator");
const activeSpeakerDisplay= document.getElementById("activeSpeakerDisplay");
const materialImg         = document.getElementById("material");
const canvas              = document.getElementById("materialCanvas");
const noMaterial          = document.getElementById("noMaterial");
const ctx                 = canvas.getContext("2d");

// ── ICE configuration ─────────────────────────────────────────────────────
// Metered.ca free TURN — works cross-network, covers symmetric NAT & cellular.
// For production replace with your own credentials from dashboard.metered.ca
const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    {
      urls: [
        "turn:a.relay.metered.ca:80",
        "turn:a.relay.metered.ca:80?transport=tcp",
        "turn:a.relay.metered.ca:443",
        "turn:a.relay.metered.ca:443?transport=tcp"
      ],
      username: "e8dd65f93a7c9d8e7b3f4a2c",
      credential: "uMGa+xXyCwDqRNmH"
    }
  ],
  iceTransportPolicy: "all",
  iceCandidatePoolSize: 10
};

// ── State ─────────────────────────────────────────────────────────────────
// inboundPeer: { pc, iceBuf[] }  — teacher → student
// outboundPeer: { pc, iceBuf[] } — student → teacher (approved only)
let inboundPeer  = null;
let outboundPeer = null;
let teacherAudio = null;   // <audio> element for teacher's voice
let localStream  = null;   // mic stream when approved

let myId          = null;
let teacherId     = null;
let handRaised    = false;
let canSpeak      = false;
let audioUnlocked = false;

// ── Socket ────────────────────────────────────────────────────────────────
socket.on("connect", () => {
  myId = socket.id;
  connectionStatus.textContent = "Connected";
  connectionStatus.className = "status-badge connected";
  socket.emit("join-as-student", roomId, studentName);
});

socket.on("disconnect", () => {
  connectionStatus.textContent = "Disconnected";
  connectionStatus.className = "status-badge disconnected";
  teacherStatus.textContent = "Disconnected";
  teacherStatus.className = "status-value inactive";
  closeOutboundPeer();
});

socket.on("student-joined", ({ hasTeacher, activeSpeaker, material }) => {
  if (hasTeacher) {
    teacherStatus.textContent = "Teacher Online";
    teacherStatus.className = "status-value active";
  }
  updateActiveSpeakerUI(activeSpeaker, activeSpeaker === "teacher" ? "Teacher" : "Student");
  if (material) showMaterial(material.url);
  updateAudioWarning();
});

socket.on("join-error", ({ message }) => alert("Cannot join: " + message));

socket.on("teacher-left", () => {
  teacherStatus.textContent = "Teacher Offline";
  teacherStatus.className = "status-value inactive";
  audioStatus.textContent = "No Audio";
  audioStatus.className = "status-value inactive";
  closeInboundPeer();
  closeOutboundPeer();
});

// ── WebRTC signaling ──────────────────────────────────────────────────────

// Teacher sends offer → we create inbound peer and answer
socket.on("webrtc-offer", async ({ fromId, sdp }) => {
  teacherId = fromId;
  await createInboundPeer(fromId, sdp);
});

// Teacher answered our outbound offer
socket.on("webrtc-answer-student", ({ sdp }) => {
  if (!outboundPeer) return;
  outboundPeer.pc.setRemoteDescription(new RTCSessionDescription(sdp))
    .then(() => flushIceBuf(outboundPeer))
    .catch(e => console.error("[outbound] setRemoteDescription:", e));
});

// ICE candidates — buffer until remote description is ready
socket.on("ice-candidate", ({ candidate, peerType }) => {
  const peer = peerType === "outbound" ? outboundPeer : inboundPeer;
  if (!peer || !candidate) return;

  const pc = peer.pc;
  if (pc.remoteDescription && pc.remoteDescription.type) {
    pc.addIceCandidate(new RTCIceCandidate(candidate))
      .catch(e => console.warn(`[ice:${peerType}] addIceCandidate:`, e));
  } else {
    peer.iceBuf.push(candidate);
  }
});

function flushIceBuf(peer) {
  while (peer.iceBuf.length) {
    const c = peer.iceBuf.shift();
    peer.pc.addIceCandidate(new RTCIceCandidate(c))
      .catch(e => console.warn("[ice] flush:", e));
  }
}

// ── Inbound peer: receive teacher audio ───────────────────────────────────
async function createInboundPeer(fromId, offerSdp) {
  closeInboundPeer();

  const pc = new RTCPeerConnection(ICE_CONFIG);
  inboundPeer = { pc, iceBuf: [] };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("ice-candidate", { targetId: fromId, candidate, peerType: "outbound" });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log("[inbound] conn:", s);
    if (s === "connected") {
      audioStatus.textContent = "Live";
      audioStatus.className = "status-value active";
      // Ensure audio plays once connection is confirmed
      if (teacherAudio && teacherAudio.paused) {
        teacherAudio.play().catch(() => {});
      }
    } else if (s === "failed") {
      audioStatus.textContent = "No Audio";
      audioStatus.className = "status-value inactive";
      pc.restartIce();
    } else if (s === "disconnected") {
      audioStatus.textContent = "Reconnecting...";
      audioStatus.className = "status-value inactive";
      setTimeout(() => {
        if (pc.connectionState === "disconnected") pc.restartIce();
      }, 3000);
    }
  };

  // Track arrives — wire up audio element immediately
  pc.ontrack = ({ streams }) => {
    console.log("[inbound] track received");
    if (!teacherAudio) {
      teacherAudio = document.createElement("audio");
      teacherAudio.autoplay = true;
      teacherAudio.playsInline = true;
      teacherAudio.muted = false;
      document.body.appendChild(teacherAudio);
    }
    teacherAudio.srcObject = streams[0];
    // Always attempt play — browser will allow it if user has interacted
    teacherAudio.play().catch(() => {
      // Autoplay blocked — will retry when user unlocks
      console.log("[inbound] autoplay blocked, waiting for user gesture");
    });
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    flushIceBuf(inboundPeer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-answer", { targetId: fromId, sdp: pc.localDescription });
    console.log("[inbound] answer sent");
  } catch (e) {
    console.error("[inbound] answer failed:", e);
  }
}

function closeInboundPeer() {
  if (inboundPeer)  { inboundPeer.pc.close(); inboundPeer = null; }
  if (teacherAudio) { teacherAudio.srcObject = null; teacherAudio.remove(); teacherAudio = null; }
  audioStatus.textContent = "No Audio";
  audioStatus.className = "status-value inactive";
}

// ── Outbound peer: send mic to teacher when approved ──────────────────────
async function createOutboundPeer(toTeacherId) {
  closeOutboundPeer();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000
      }
    });
  } catch (e) {
    console.error("[outbound] getUserMedia:", e);
    alert("Microphone error: " + e.message);
    return;
  }

  const pc = new RTCPeerConnection(ICE_CONFIG);
  outboundPeer = { pc, iceBuf: [] };
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("ice-candidate", { targetId: toTeacherId, candidate, peerType: "inbound" });
  };

  pc.onconnectionstatechange = () => {
    console.log("[outbound] conn:", pc.connectionState);
    if (pc.connectionState === "failed") pc.restartIce();
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc-offer-student", { targetId: toTeacherId, sdp: pc.localDescription });
    console.log("[outbound] offer sent");
  } catch (e) {
    console.error("[outbound] createOffer:", e);
  }
}

function closeOutboundPeer() {
  if (localStream)  { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (outboundPeer) { outboundPeer.pc.close(); outboundPeer = null; }
}

// ── Audio unlock ──────────────────────────────────────────────────────────
// Browsers block autoplay until a user gesture. We unlock on first interaction
// and retry play() on the teacher audio element.
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  updateAudioWarning();
  if (teacherAudio) {
    teacherAudio.muted = false;
    teacherAudio.play().catch(e => console.warn("[unlock] play():", e));
  }
  console.log("[audio] unlocked");
}

function updateAudioWarning() {
  if (audioWarning) audioWarning.style.display = audioUnlocked ? "none" : "block";
}

if (unlockAudioBtn) unlockAudioBtn.onclick = e => { e.stopPropagation(); unlockAudio(); };
document.addEventListener("click", unlockAudio, { once: true });

testAudioBtn.onclick = async (e) => {
  e.stopPropagation();
  unlockAudio();
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    await ac.resume();
    const osc = ac.createOscillator(), gain = ac.createGain();
    osc.type = "sine"; osc.frequency.value = 440; gain.gain.value = 0.1;
    osc.connect(gain); gain.connect(ac.destination);
    osc.start(); osc.stop(ac.currentTime + 0.5);
    setTimeout(() => ac.close(), 700);
  } catch (e) { console.error("[test]", e); }
};

// ── Raise-hand ────────────────────────────────────────────────────────────
raiseHandBtn.onclick = () => {
  socket.emit("raise-hand", roomId);
  handRaised = true;
  raiseHandBtn.disabled = true;
  cancelHandBtn.disabled = false;
};

cancelHandBtn.onclick = () => {
  socket.emit("cancel-hand", roomId);
  handRaised = false;
  raiseHandBtn.disabled = false;
  cancelHandBtn.disabled = true;
};

socket.on("speak-approved", ({ teacherSocketId }) => {
  console.log("[student] speak approved, teacher:", teacherSocketId);
  canSpeak = true;
  handRaised = false;
  raiseHandBtn.disabled = true;
  cancelHandBtn.disabled = true;
  speakingIndicator.style.display = "block";
  teacherId = teacherSocketId;
  createOutboundPeer(teacherSocketId);
});

socket.on("speak-revoked", () => {
  canSpeak = false;
  raiseHandBtn.disabled = false;
  cancelHandBtn.disabled = true;
  speakingIndicator.style.display = "none";
  closeOutboundPeer();
});

socket.on("hand-rejected", () => {
  handRaised = false;
  raiseHandBtn.disabled = false;
  cancelHandBtn.disabled = true;
  alert("Your request to speak was declined.");
});

socket.on("speaker-changed", ({ speakerId, speakerName }) => {
  updateActiveSpeakerUI(speakerId, speakerName);
  if (speakerId !== myId) {
    speakingIndicator.style.display = "none";
    canSpeak = false;
  }
});

function updateActiveSpeakerUI(speakerId, speakerName) {
  activeSpeakerDisplay.innerHTML = speakerId === "teacher"
    ? '<span class="speaker-indicator teacher">👨🏫 Teacher speaking</span>'
    : `<span class="speaker-indicator student">👨🎓 ${speakerName} speaking</span>`;
}

// ── Material ──────────────────────────────────────────────────────────────
socket.on("material-shared", ({ url }) => showMaterial(url));

function showMaterial(url) {
  materialImg.src = url;
  materialImg.style.display = "block";
  noMaterial.style.display = "none";
  materialImg.onload = () => {
    canvas.width  = materialImg.naturalWidth;
    canvas.height = materialImg.naturalHeight;
    canvas.style.width  = "100%";
    canvas.style.height = "auto";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
}

socket.on("draw", ({ x, y, color, width }) => {
  ctx.lineWidth = width; ctx.lineCap = "round"; ctx.strokeStyle = color;
  ctx.lineTo(x, y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, y);
});
socket.on("clear-canvas", () => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.beginPath(); });

console.log("[student] ready, room:", roomId);
