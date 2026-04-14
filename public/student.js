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
// Multiple verified free TURN providers for redundancy.
// If one fails auth, the next will be tried automatically.
const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "turn:global.relay.metered.ca:80",                    username: "c42ac28730f2eccb2531db32", credential: "Os9aeQUDwLn1A7Qw" },
    { urls: "turn:global.relay.metered.ca:80?transport=tcp",      username: "c42ac28730f2eccb2531db32", credential: "Os9aeQUDwLn1A7Qw" },
    { urls: "turn:global.relay.metered.ca:443",                   username: "c42ac28730f2eccb2531db32", credential: "Os9aeQUDwLn1A7Qw" },
    { urls: "turns:global.relay.metered.ca:443?transport=tcp",    username: "c42ac28730f2eccb2531db32", credential: "Os9aeQUDwLn1A7Qw" }
  ],
  iceTransportPolicy: "all",
  iceCandidatePoolSize: 10
};

// ── ICE diagnostic logger ─────────────────────────────────────────────────
function logCandidate(label, c) {
  if (!c) return;
  const type = c.type || "?";
  const proto = c.protocol || "?";
  const addr = c.address || c.ip || "?";
  const port = c.port || "?";
  console.log(`[ICE][${label}] ${type} ${proto} ${addr}:${port}`);
  if (type === "relay") console.log(`%c[ICE][${label}] ✅ TURN relay candidate gathered`, "color:green;font-weight:bold");
  if (type === "srflx") console.log(`%c[ICE][${label}] ✅ STUN srflx candidate gathered`, "color:blue");
}

// ── State ─────────────────────────────────────────────────────────────────
let inboundPeer  = null;   // { pc, iceBuf[], restartTimer }
let outboundPeer = null;   // { pc, iceBuf[] }
let teacherAudio = null;
let localStream  = null;

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
  console.log("[student] socket connected:", socket.id);
});

socket.on("disconnect", () => {
  connectionStatus.textContent = "Disconnected";
  connectionStatus.className = "status-badge disconnected";
  teacherStatus.textContent = "Disconnected";
  teacherStatus.className = "status-value inactive";
  closeOutboundPeer();
});

socket.on("student-joined", ({ hasTeacher, activeSpeaker, material }) => {
  console.log("[student] joined room. hasTeacher:", hasTeacher, "activeSpeaker:", activeSpeaker);
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
  console.log("[student] teacher left");
  teacherStatus.textContent = "Teacher Offline";
  teacherStatus.className = "status-value inactive";
  setAudioStatus("No Audio", false);
  closeInboundPeer();
  closeOutboundPeer();
});

// ── WebRTC signaling ──────────────────────────────────────────────────────
socket.on("webrtc-offer", async ({ fromId, sdp }) => {
  console.log("[student] received webrtc-offer from teacher:", fromId.substr(0,6));
  teacherId = fromId;
  await createInboundPeer(fromId, sdp);
});

socket.on("webrtc-answer-student", ({ sdp }) => {
  if (!outboundPeer) return;
  console.log("[outbound] received answer from teacher");
  outboundPeer.pc.setRemoteDescription(new RTCSessionDescription(sdp))
    .then(() => {
      console.log("[outbound] remote desc set, flushing", outboundPeer.iceBuf.length, "buffered candidates");
      flushIceBuf(outboundPeer, "outbound");
    })
    .catch(e => console.error("[outbound] setRemoteDescription:", e));
});

// ICE candidates — buffer until remote description is ready
socket.on("ice-candidate", ({ candidate, peerType }) => {
  const peer = peerType === "outbound" ? outboundPeer : inboundPeer;
  if (!peer || !candidate) return;

  const label = peerType === "outbound" ? "outbound" : "inbound";
  const pc = peer.pc;
  if (pc.remoteDescription && pc.remoteDescription.type) {
    pc.addIceCandidate(new RTCIceCandidate(candidate))
      .catch(e => console.warn(`[ice:${label}] addIceCandidate:`, e));
  } else {
    console.log(`[ice:${label}] buffering candidate (no remote desc yet)`);
    peer.iceBuf.push(candidate);
  }
});

function flushIceBuf(peer, label) {
  while (peer.iceBuf.length) {
    const c = peer.iceBuf.shift();
    peer.pc.addIceCandidate(new RTCIceCandidate(c))
      .catch(e => console.warn(`[ice:${label}] flush:`, e));
  }
}

// ── Inbound peer: receive teacher audio ───────────────────────────────────
async function createInboundPeer(fromId, offerSdp) {
  closeInboundPeer();
  console.log("[inbound] creating peer to receive teacher audio");

  const pc = new RTCPeerConnection(ICE_CONFIG);
  inboundPeer = { pc, iceBuf: [], restartTimer: null };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      logCandidate("inbound", candidate);
      socket.emit("ice-candidate", { targetId: fromId, candidate, peerType: "outbound" });
    } else {
      console.log("[inbound] ICE gathering complete");
    }
  };

  pc.onicegatheringstatechange = () => {
    console.log("[inbound] gathering:", pc.iceGatheringState);
  };

  pc.oniceconnectionstatechange = () => {
    console.log("[inbound] ICE:", pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log("[inbound] conn:", s);

    if (inboundPeer && inboundPeer.restartTimer) {
      clearTimeout(inboundPeer.restartTimer);
      inboundPeer.restartTimer = null;
    }

    if (s === "connected") {
      console.log("%c[inbound] ✅ CONNECTED — audio should be flowing", "color:green;font-weight:bold");
      setAudioStatus("Live", true);
      // Guarantee audio plays once connection is confirmed
      if (teacherAudio) {
        teacherAudio.play().catch(e => console.warn("[inbound] play() on connected:", e));
      }
    }

    if (s === "failed") {
      console.warn("[inbound] ❌ FAILED — restarting ICE");
      setAudioStatus("Reconnecting...", false);
      pc.restartIce();
    }

    if (s === "disconnected") {
      console.warn("[inbound] disconnected — will restart in 4s if not recovered");
      setAudioStatus("Reconnecting...", false);
      inboundPeer.restartTimer = setTimeout(() => {
        if (pc.connectionState !== "connected" && pc.connectionState !== "closed") {
          console.warn("[inbound] still disconnected, forcing ICE restart");
          pc.restartIce();
        }
      }, 4000);
    }
  };

  // Track arrives — wire up audio element
  pc.ontrack = ({ streams }) => {
    console.log("[inbound] track received, streams:", streams.length);
    if (!teacherAudio) {
      teacherAudio = document.createElement("audio");
      teacherAudio.autoplay = true;
      teacherAudio.playsInline = true;
      teacherAudio.muted = false;
      document.body.appendChild(teacherAudio);
      console.log("[inbound] audio element created and appended to DOM");
    }
    teacherAudio.srcObject = streams[0];
    console.log("[inbound] srcObject set, audioUnlocked:", audioUnlocked);
    // Always try play — succeeds if user has interacted, queued otherwise
    teacherAudio.play()
      .then(() => console.log("[inbound] play() succeeded"))
      .catch(e => console.warn("[inbound] play() blocked (needs user gesture):", e.name));
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    console.log("[inbound] remote desc set, flushing", inboundPeer.iceBuf.length, "buffered candidates");
    flushIceBuf(inboundPeer, "inbound");
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-answer", { targetId: fromId, sdp: pc.localDescription });
    console.log("[inbound] answer sent");
  } catch (e) {
    console.error("[inbound] answer failed:", e);
  }
}

function closeInboundPeer() {
  if (inboundPeer) {
    if (inboundPeer.restartTimer) clearTimeout(inboundPeer.restartTimer);
    inboundPeer.pc.close();
    inboundPeer = null;
  }
  if (teacherAudio) {
    teacherAudio.srcObject = null;
    teacherAudio.remove();
    teacherAudio = null;
  }
  setAudioStatus("No Audio", false);
}

// ── Outbound peer: send mic to teacher when approved ──────────────────────
async function createOutboundPeer(toTeacherId) {
  closeOutboundPeer();
  console.log("[outbound] creating peer to send mic to teacher");

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
    console.log("[outbound] mic acquired");
  } catch (e) {
    console.error("[outbound] getUserMedia:", e);
    alert("Microphone error: " + e.message);
    return;
  }

  const pc = new RTCPeerConnection(ICE_CONFIG);
  outboundPeer = { pc, iceBuf: [] };
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      logCandidate("outbound", candidate);
      socket.emit("ice-candidate", { targetId: toTeacherId, candidate, peerType: "inbound" });
    } else {
      console.log("[outbound] ICE gathering complete");
    }
  };

  pc.onicegatheringstatechange = () => {
    console.log("[outbound] gathering:", pc.iceGatheringState);
  };

  pc.oniceconnectionstatechange = () => {
    console.log("[outbound] ICE:", pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log("[outbound] conn:", s);
    if (s === "connected") console.log("%c[outbound] ✅ CONNECTED — mic flowing to teacher", "color:green;font-weight:bold");
    if (s === "failed") { console.warn("[outbound] ❌ FAILED — restarting ICE"); pc.restartIce(); }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc-offer-student", { targetId: toTeacherId, sdp: pc.localDescription });
    console.log("[outbound] offer sent to teacher");
  } catch (e) {
    console.error("[outbound] createOffer:", e);
  }
}

function closeOutboundPeer() {
  if (localStream)  { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (outboundPeer) { outboundPeer.pc.close(); outboundPeer = null; }
}

// ── Audio status helper ───────────────────────────────────────────────────
function setAudioStatus(text, active) {
  audioStatus.textContent = text;
  audioStatus.className = "status-value " + (active ? "active" : "inactive");
}

// ── Audio unlock ──────────────────────────────────────────────────────────
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  updateAudioWarning();
  console.log("[audio] unlocked by user gesture");
  if (teacherAudio) {
    teacherAudio.muted = false;
    teacherAudio.play()
      .then(() => console.log("[audio] play() succeeded after unlock"))
      .catch(e => console.warn("[audio] play() after unlock:", e));
  }
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
