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

// ── ICE configuration — must match teacher.js ─────────────────────────────
// STUN: free public servers, discovers public IP behind NAT.
// TURN: relay for strict NAT / cellular. Add credentials when available.
// See teacher.js for full explanation and TURN provider links.
const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" }
    // ── Uncomment and fill in when you have TURN credentials ──────────────
    // { urls: "turn:YOUR_TURN_HOST:3478",             username: "USER", credential: "PASS" },
    // { urls: "turn:YOUR_TURN_HOST:443?transport=tcp", username: "USER", credential: "PASS" },
    // { urls: "turns:YOUR_TURN_HOST:443",              username: "USER", credential: "PASS" }
  ],
  iceTransportPolicy: "all",
  iceCandidatePoolSize: 10
};

// ── State ─────────────────────────────────────────────────────────────────
let inboundPc    = null;   // RTCPeerConnection: teacher → this student
let outboundPc   = null;   // RTCPeerConnection: this student → teacher (approved only)
let teacherAudio = null;   // <audio> playing teacher's voice
let localStream  = null;   // mic stream when approved to speak

let myId          = null;
let teacherId     = null;  // stored when server sends it with speak-approved
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

// ── WebRTC: inbound (teacher → student) ──────────────────────────────────

socket.on("webrtc-offer", async ({ fromId, sdp }) => {
  teacherId = fromId; // store teacher's socket ID for later use
  await createInboundPeer(fromId, sdp);
});

// Teacher answered our outbound offer (student mic → teacher)
socket.on("webrtc-answer-student", ({ sdp }) => {
  if (!outboundPc) return;
  outboundPc.setRemoteDescription(new RTCSessionDescription(sdp))
    .catch(e => console.error("[outbound] setRemoteDescription:", e));
});

// ICE candidate routing:
//   peerType "inbound"  → add to inboundPc  (teacher→student stream)
//   peerType "outbound" → add to outboundPc (student→teacher stream)
socket.on("ice-candidate", ({ candidate, peerType }) => {
  const pc = peerType === "outbound" ? outboundPc : inboundPc;
  if (pc && candidate) {
    pc.addIceCandidate(new RTCIceCandidate(candidate))
      .catch(e => console.warn(`[ice:${peerType}] addIceCandidate:`, e));
  }
});

// ── Create inbound peer (receive teacher audio) ───────────────────────────
async function createInboundPeer(fromId, offerSdp) {
  closeInboundPeer();

  inboundPc = new RTCPeerConnection(ICE_CONFIG);

  // peerType "inbound" = teacher's perspective: these are outbound candidates
  // but from OUR perspective they go to our inbound peer
  inboundPc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit("ice-candidate", { targetId: fromId, candidate, peerType: "outbound" });
    }
  };

  inboundPc.oniceconnectionstatechange = () => {
    const s = inboundPc.iceConnectionState;
    console.log("[inbound] ICE:", s);
    if (s === "connected" || s === "completed") {
      audioStatus.textContent = "Live";
      audioStatus.className = "status-value active";
    } else if (s === "failed") {
      audioStatus.textContent = "No Audio";
      audioStatus.className = "status-value inactive";
      inboundPc.restartIce();
    } else if (s === "disconnected") {
      audioStatus.textContent = "Reconnecting...";
      audioStatus.className = "status-value inactive";
      setTimeout(() => {
        if (inboundPc && inboundPc.iceConnectionState === "disconnected") inboundPc.restartIce();
      }, 4000);
    }
  };

  // Teacher's audio track arrives — attach to <audio> element and play
  inboundPc.ontrack = ({ streams }) => {
    console.log("[inbound] teacher audio track received");
    if (!teacherAudio) {
      teacherAudio = document.createElement("audio");
      teacherAudio.autoplay = true;
      teacherAudio.playsInline = true;
      document.body.appendChild(teacherAudio); // must be in DOM for iOS Safari
    }
    teacherAudio.srcObject = streams[0];

    if (audioUnlocked) {
      teacherAudio.play().catch(e => console.warn("[inbound] play():", e));
    }
  };

  try {
    await inboundPc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    const answer = await inboundPc.createAnswer();
    await inboundPc.setLocalDescription(answer);
    socket.emit("webrtc-answer", { targetId: fromId, sdp: inboundPc.localDescription });
    console.log("[inbound] answer sent");
  } catch (e) {
    console.error("[inbound] answer failed:", e);
  }
}

function closeInboundPeer() {
  if (inboundPc)    { inboundPc.close(); inboundPc = null; }
  if (teacherAudio) { teacherAudio.srcObject = null; teacherAudio.remove(); teacherAudio = null; }
}

// ── Create outbound peer (send student mic to teacher when approved) ───────
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

  outboundPc = new RTCPeerConnection(ICE_CONFIG);
  localStream.getTracks().forEach(track => outboundPc.addTrack(track, localStream));

  // peerType "inbound" = teacher's perspective: these go to their inbound peer
  outboundPc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit("ice-candidate", { targetId: toTeacherId, candidate, peerType: "inbound" });
    }
  };

  outboundPc.oniceconnectionstatechange = () => {
    console.log("[outbound] ICE:", outboundPc.iceConnectionState);
    if (outboundPc.iceConnectionState === "failed") outboundPc.restartIce();
  };

  try {
    const offer = await outboundPc.createOffer();
    await outboundPc.setLocalDescription(offer);
    socket.emit("webrtc-offer-student", { targetId: toTeacherId, sdp: outboundPc.localDescription });
    console.log("[outbound] offer sent to teacher");
  } catch (e) {
    console.error("[outbound] createOffer:", e);
  }
}

function closeOutboundPeer() {
  if (localStream)  { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (outboundPc)   { outboundPc.close(); outboundPc = null; }
}

// ── Audio unlock ──────────────────────────────────────────────────────────
// Browsers require a user gesture before playing audio.
// We unlock on first click/tap anywhere on the page.
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

if (unlockAudioBtn) unlockAudioBtn.onclick = (e) => { e.stopPropagation(); unlockAudio(); };
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

// Server sends teacherId alongside speak-approved so we don't need a round trip
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
