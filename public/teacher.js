// =============================================================================
// TEACHER — WebRTC Audio Classroom
// =============================================================================

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room") || "test";
document.getElementById("roomDisplay").textContent = roomId;

const socket = io({ transports: ["websocket", "polling"], upgrade: true });

// ── DOM refs ──────────────────────────────────────────────────────────────
const connectionStatus    = document.getElementById("connectionStatus");
const startAudioBtn       = document.getElementById("startAudioBtn");
const stopAudioBtn        = document.getElementById("stopAudioBtn");
const micStatus           = document.getElementById("micStatus");
const broadcastStatus     = document.getElementById("broadcastStatus");
const visualizer          = document.getElementById("audioVisualizer");
const studentCountEl      = document.getElementById("studentCount");
const studentsList        = document.getElementById("studentsList");
const pendingRequestsList = document.getElementById("pendingRequestsList");
const activeSpeakerDisplay= document.getElementById("activeSpeakerDisplay");
const revokeSpeakerBtn    = document.getElementById("revokeSpeakerBtn");
const fileInput           = document.getElementById("fileInput");
const uploadBtn           = document.getElementById("uploadMaterial");
const clearMaterialBtn    = document.getElementById("clearMaterial");
const materialImg         = document.getElementById("material");
const noMaterial          = document.getElementById("noMaterial");
const penToggle           = document.getElementById("penToggle");
const penNormalBtn        = document.getElementById("penNormal");
const penBoldBtn          = document.getElementById("penBold");
const colorPicker         = document.getElementById("colorPicker");
const clearCanvasBtn      = document.getElementById("clearCanvas");
const canvas              = document.getElementById("materialCanvas");
const ctx                 = canvas.getContext("2d");

// ── ICE configuration ─────────────────────────────────────────────────────
// Using Metered.ca free TURN — reliable, no sign-up needed for the demo key.
// For production replace with your own credentials from dashboard.metered.ca
const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    // Metered.ca free TURN — works cross-network, covers symmetric NAT & cellular
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

// ── Opus SDP helper ───────────────────────────────────────────────────────
function preferOpus(sdp) {
  const lines = sdp.split("\r\n");
  let opusPayload = null;
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+) opus\/48000/i);
    if (m) { opusPayload = m[1]; break; }
  }
  if (!opusPayload) return sdp;

  const result = [];
  for (const line of lines) {
    if (line.startsWith("m=audio")) {
      const parts = line.split(" ");
      const payloads = parts.slice(3).filter(p => p !== opusPayload);
      result.push([...parts.slice(0, 3), opusPayload, ...payloads].join(" "));
      continue;
    }
    if (line.startsWith(`a=fmtp:${opusPayload}`)) {
      result.push(`a=fmtp:${opusPayload} minptime=10;useinbandfec=1;stereo=0;maxaveragebitrate=32000`);
      continue;
    }
    result.push(line);
  }
  if (!sdp.includes(`a=fmtp:${opusPayload}`)) {
    const idx = result.findIndex(l => l.startsWith(`a=rtpmap:${opusPayload}`));
    if (idx !== -1) result.splice(idx + 1, 0, `a=fmtp:${opusPayload} minptime=10;useinbandfec=1;stereo=0;maxaveragebitrate=32000`);
  }
  return result.join("\r\n");
}

// ── State ─────────────────────────────────────────────────────────────────
let localStream    = null;
let isBroadcasting = false;

// outboundPeers: Map<studentId, { pc, iceBuf[] }>  teacher→student audio
const outboundPeers = new Map();
// inboundPeers:  Map<studentId, { pc, iceBuf[] }>  approved student→teacher
const inboundPeers  = new Map();
// inboundAudio:  Map<studentId, HTMLAudioElement>
const inboundAudio  = new Map();

const pendingRequests = new Map();

let canDraw = false, penWidth = 2, currentColor = "#ff0000", drawing = false;
let audioCtxViz = null, analyser = null, animFrame = null;

// ── Socket ────────────────────────────────────────────────────────────────
socket.on("connect", () => {
  connectionStatus.textContent = "Connected";
  connectionStatus.className = "status-badge connected";
  socket.emit("join-as-teacher", roomId);
});

socket.on("disconnect", () => {
  connectionStatus.textContent = "Disconnected";
  connectionStatus.className = "status-badge disconnected";
  stopBroadcasting();
});

socket.on("teacher-joined", () => {
  startAudioBtn.disabled = false;
  setActiveSpeakerUI("teacher", "Teacher");
});

// ── Student lifecycle ─────────────────────────────────────────────────────
socket.on("student-connected", ({ studentId, studentName, totalStudents }) => {
  studentCountEl.textContent = totalStudents;
  addStudentRow(studentId, studentName);
  if (isBroadcasting && localStream) createOutboundPeer(studentId);
});

socket.on("student-left", ({ studentId, totalStudents }) => {
  studentCountEl.textContent = totalStudents;
  removeStudentRow(studentId);
  pendingRequests.delete(studentId);
  renderPendingRequests();
  closeOutboundPeer(studentId);
  closeInboundPeer(studentId);
});

// ── WebRTC signaling ──────────────────────────────────────────────────────

socket.on("webrtc-answer", ({ fromId, sdp }) => {
  const entry = outboundPeers.get(fromId);
  if (!entry) return;
  entry.pc.setRemoteDescription(new RTCSessionDescription(sdp))
    .then(() => flushIceBuf(entry))
    .catch(e => console.error("[outbound] setRemoteDescription:", e));
});

socket.on("webrtc-offer-student", async ({ fromId, sdp }) => {
  await createInboundPeer(fromId, sdp);
});

// ICE candidates — buffer until remote description is set
socket.on("ice-candidate", ({ fromId, candidate, peerType }) => {
  const entry = peerType === "inbound"
    ? inboundPeers.get(fromId)
    : outboundPeers.get(fromId);
  if (!entry || !candidate) return;

  const pc = entry.pc;
  if (pc.remoteDescription && pc.remoteDescription.type) {
    pc.addIceCandidate(new RTCIceCandidate(candidate))
      .catch(e => console.warn(`[ice:${peerType}] addIceCandidate:`, e));
  } else {
    entry.iceBuf.push(candidate);
  }
});

function flushIceBuf(entry) {
  while (entry.iceBuf.length) {
    const c = entry.iceBuf.shift();
    entry.pc.addIceCandidate(new RTCIceCandidate(c))
      .catch(e => console.warn("[ice] flush addIceCandidate:", e));
  }
}

// ── Outbound peer: teacher → student ─────────────────────────────────────
async function createOutboundPeer(studentId) {
  closeOutboundPeer(studentId);

  const pc = new RTCPeerConnection(ICE_CONFIG);
  const entry = { pc, iceBuf: [] };
  outboundPeers.set(studentId, entry);

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("ice-candidate", { targetId: studentId, candidate, peerType: "inbound" });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log(`[out→${studentId.substr(0,6)}] conn: ${s}`);
    if (s === "failed") {
      // Full re-offer with ICE restart — picks up TURN candidates
      pc.createOffer({ iceRestart: true })
        .then(o => { o.sdp = preferOpus(o.sdp); return pc.setLocalDescription(o); })
        .then(() => socket.emit("webrtc-offer", { targetId: studentId, sdp: pc.localDescription }))
        .catch(e => console.error("[outbound] ICE restart:", e));
    }
    if (s === "disconnected") {
      setTimeout(() => {
        if (pc.connectionState === "disconnected") {
          pc.createOffer({ iceRestart: true })
            .then(o => { o.sdp = preferOpus(o.sdp); return pc.setLocalDescription(o); })
            .then(() => socket.emit("webrtc-offer", { targetId: studentId, sdp: pc.localDescription }))
            .catch(() => {});
        }
      }, 3000);
    }
  };

  try {
    const offer = await pc.createOffer();
    offer.sdp = preferOpus(offer.sdp);
    await pc.setLocalDescription(offer);
    socket.emit("webrtc-offer", { targetId: studentId, sdp: pc.localDescription });
  } catch (e) {
    console.error("[outbound] createOffer:", e);
  }
}

function closeOutboundPeer(studentId) {
  const entry = outboundPeers.get(studentId);
  if (entry) { entry.pc.close(); outboundPeers.delete(studentId); }
}

// ── Inbound peer: approved student → teacher ─────────────────────────────
async function createInboundPeer(studentId, offerSdp) {
  closeInboundPeer(studentId);

  const pc = new RTCPeerConnection(ICE_CONFIG);
  const entry = { pc, iceBuf: [] };
  inboundPeers.set(studentId, entry);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("ice-candidate", { targetId: studentId, candidate, peerType: "outbound" });
  };

  pc.onconnectionstatechange = () => {
    console.log(`[in←${studentId.substr(0,6)}] conn: ${pc.connectionState}`);
    if (pc.connectionState === "failed") pc.restartIce();
  };

  pc.ontrack = ({ streams }) => {
    let el = inboundAudio.get(studentId);
    if (!el) {
      el = document.createElement("audio");
      el.autoplay = true;
      el.playsInline = true;
      document.body.appendChild(el);
      inboundAudio.set(studentId, el);
    }
    el.srcObject = streams[0];
    el.play().catch(() => {});
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    flushIceBuf(entry);
    const answer = await pc.createAnswer();
    answer.sdp = preferOpus(answer.sdp);
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-answer-student", { targetId: studentId, sdp: pc.localDescription });
  } catch (e) {
    console.error("[inbound] answer:", e);
  }
}

function closeInboundPeer(studentId) {
  const entry = inboundPeers.get(studentId);
  if (entry) { entry.pc.close(); inboundPeers.delete(studentId); }
  const el = inboundAudio.get(studentId);
  if (el) { el.srcObject = null; el.remove(); inboundAudio.delete(studentId); }
}

// ── Mic controls ──────────────────────────────────────────────────────────
startAudioBtn.onclick = async () => {
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

    isBroadcasting = true;
    startAudioBtn.disabled = true;
    stopAudioBtn.disabled = false;
    micStatus.textContent = "Active";
    micStatus.className = "status-value active";
    broadcastStatus.textContent = "Broadcasting";
    broadcastStatus.className = "status-value active";

    setupVisualizer();
    socket.emit("teacher-broadcasting");
  } catch (e) {
    console.error("[teacher] getUserMedia:", e);
    alert("Microphone error: " + e.message);
  }
};

socket.on("current-students", (students) => {
  students.forEach(({ studentId }) => {
    if (isBroadcasting && localStream) createOutboundPeer(studentId);
  });
});

stopAudioBtn.onclick = () => stopBroadcasting();

function stopBroadcasting() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (animFrame)   { cancelAnimationFrame(animFrame); animFrame = null; }
  outboundPeers.forEach((_, id) => closeOutboundPeer(id));
  isBroadcasting = false;
  startAudioBtn.disabled = false;
  stopAudioBtn.disabled = true;
  micStatus.textContent = "Stopped";
  micStatus.className = "status-value inactive";
  broadcastStatus.textContent = "Off";
  broadcastStatus.className = "status-value inactive";
}

// ── Raise-hand / speaker management ──────────────────────────────────────
socket.on("hand-raised", ({ studentId, studentName }) => {
  pendingRequests.set(studentId, studentName);
  renderPendingRequests();
  visualizer.classList.add("warning");
  setTimeout(() => visualizer.classList.remove("warning"), 1000);
});

socket.on("hand-cancelled", ({ studentId }) => {
  pendingRequests.delete(studentId);
  renderPendingRequests();
});

socket.on("speaker-changed", ({ speakerId, speakerName, isTeacher }) => {
  setActiveSpeakerUI(speakerId, speakerName);
  revokeSpeakerBtn.disabled = isTeacher;
});

function approveSpeaker(studentId) {
  socket.emit("approve-speaker", { roomId, studentId });
  pendingRequests.delete(studentId);
  renderPendingRequests();
}

function rejectHand(studentId) {
  socket.emit("reject-hand", { roomId, studentId });
  pendingRequests.delete(studentId);
  renderPendingRequests();
}

revokeSpeakerBtn.onclick = () => {
  socket.emit("revoke-speaker", roomId);
  inboundPeers.forEach((_, id) => closeInboundPeer(id));
};

window.approveSpeaker = approveSpeaker;
window.rejectHand = rejectHand;

function setActiveSpeakerUI(speakerId, speakerName) {
  activeSpeakerDisplay.innerHTML = speakerId === "teacher"
    ? '<span class="speaker-indicator teacher">👨🏫 Teacher</span>'
    : `<span class="speaker-indicator student">👨🎓 ${speakerName}</span>`;
}

function renderPendingRequests() {
  if (!pendingRequestsList) return;
  if (pendingRequests.size === 0) {
    pendingRequestsList.innerHTML = '<li class="no-requests">No pending requests</li>';
    return;
  }
  pendingRequestsList.innerHTML = "";
  pendingRequests.forEach((name, id) => {
    const li = document.createElement("li");
    li.className = "pending-request";
    li.innerHTML = `<span class="student-name">${name}</span>
      <div class="request-actions">
        <button class="approve-btn" onclick="approveSpeaker('${id}')">✓</button>
        <button class="reject-btn"  onclick="rejectHand('${id}')">✗</button>
      </div>`;
    pendingRequestsList.appendChild(li);
  });
}

// ── Student list UI ───────────────────────────────────────────────────────
function addStudentRow(studentId, studentName) {
  const li = document.createElement("li");
  li.id = `student-${studentId}`;
  li.className = "student-item";
  li.innerHTML = `<span class="student-name">${studentName}</span>
                  <span class="student-id">(${studentId.substr(0, 6)})</span>`;
  studentsList.appendChild(li);
}
function removeStudentRow(id) { document.getElementById(`student-${id}`)?.remove(); }

// ── Visualizer ────────────────────────────────────────────────────────────
function setupVisualizer() {
  if (!localStream) return;
  audioCtxViz = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtxViz.createAnalyser();
  analyser.fftSize = 256;
  audioCtxViz.createMediaStreamSource(localStream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  (function tick() {
    if (!analyser) return;
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    visualizer.style.setProperty("--width", (avg / 255 * 100) + "%");
    animFrame = requestAnimationFrame(tick);
  })();
}

// ── Material upload ───────────────────────────────────────────────────────
uploadBtn.onclick = async () => {
  const file = fileInput.files[0];
  if (!file) { alert("Select a file"); return; }
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res  = await fetch("/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    materialImg.src = data.url;
    materialImg.style.display = "block";
    noMaterial.style.display = "none";
    socket.emit("share-material", { roomId, url: data.url });
    materialImg.onload = resizeCanvas;
  } catch { alert("Upload failed"); }
};

clearMaterialBtn.onclick = () => {
  materialImg.src = "";
  materialImg.style.display = "none";
  noMaterial.style.display = "block";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canDraw = false;
  penToggle.textContent = "🖊️ Enable Drawing";
  canvas.classList.remove("active");
};

socket.on("material-shared", ({ url }) => {
  materialImg.src = url;
  materialImg.style.display = "block";
  noMaterial.style.display = "none";
  materialImg.onload = resizeCanvas;
});

// ── Drawing ───────────────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = materialImg.naturalWidth;
  canvas.height = materialImg.naturalHeight;
  canvas.style.width  = "100%";
  canvas.style.height = "auto";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

penToggle.onclick    = () => { canDraw = !canDraw; canvas.classList.toggle("active", canDraw); penToggle.textContent = canDraw ? "🖊️ Disable Drawing" : "🖊️ Enable Drawing"; };
penNormalBtn.onclick = () => penWidth = 2;
penBoldBtn.onclick   = () => penWidth = 5;
colorPicker.onchange = e => currentColor = e.target.value;
clearCanvasBtn.onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); socket.emit("clear-canvas", roomId); };

function getPos(e) {
  const r = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  if (e.touches) e.preventDefault();
  return { x: (src.clientX - r.left) * (canvas.width / r.width), y: (src.clientY - r.top) * (canvas.height / r.height) };
}
function drawStroke(e) {
  if (!canDraw) return;
  e.preventDefault();
  const { x, y } = getPos(e);
  ctx.lineWidth = penWidth; ctx.lineCap = "round"; ctx.strokeStyle = currentColor;
  ctx.lineTo(x, y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, y);
  socket.emit("draw", { roomId, x, y, color: currentColor, width: penWidth });
}

canvas.addEventListener("mousedown",  e => { if (!canDraw) return; drawing = true;  ctx.beginPath(); drawStroke(e); });
canvas.addEventListener("mousemove",  e => { if (!canDraw || !drawing) return; drawStroke(e); });
canvas.addEventListener("mouseup",    () => { drawing = false; ctx.beginPath(); });
canvas.addEventListener("mouseout",   () => { drawing = false; ctx.beginPath(); });
canvas.addEventListener("touchstart", e => { e.preventDefault(); if (!canDraw) return; drawing = true;  ctx.beginPath(); drawStroke(e); });
canvas.addEventListener("touchmove",  e => { e.preventDefault(); if (!canDraw || !drawing) return; drawStroke(e); });
canvas.addEventListener("touchend",   e => { e.preventDefault(); drawing = false; ctx.beginPath(); });

socket.on("draw", ({ x, y, color, width }) => {
  ctx.lineWidth = width; ctx.lineCap = "round"; ctx.strokeStyle = color;
  ctx.lineTo(x, y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, y);
});
socket.on("clear-canvas", () => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.beginPath(); });

window.addEventListener("beforeunload", stopBroadcasting);
console.log("[teacher] ready, room:", roomId);
