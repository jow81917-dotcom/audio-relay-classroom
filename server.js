const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs-extra");
const multer = require("multer");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
  allowUpgrades: true
});

const uploadsDir = path.join(__dirname, "uploads");
const publicUploadsDir = path.join(__dirname, "public", "uploads");
fs.ensureDirSync(uploadsDir);
fs.ensureDirSync(publicUploadsDir);

app.use(express.static("public"));
app.use(express.json({ limit: "50mb" }));

// ── File upload (images only) ──────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith("image/") ? cb(null, true) : cb(new Error("Images only"))
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const target = path.join(publicUploadsDir, req.file.filename);
  fs.move(req.file.path, target, { overwrite: true })
    .then(() => res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename }))
    .catch(() => res.status(500).json({ error: "File processing failed" }));
});

// ── Room state ─────────────────────────────────────────────────────────────
// rooms: Map<roomId, {
//   teacherSocketId: string | null,
//   students: Map<socketId, { name, handRaised, approved }>,
//   activeSpeaker: "teacher" | socketId,
//   material: object | null
// }>
const rooms = new Map();

function getRoom(roomId) { return rooms.get(roomId); }

// ── Socket.IO signaling ────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── Teacher joins ──────────────────────────────────────────────────────
  socket.on("join-as-teacher", (roomId) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = "teacher";

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        teacherSocketId: socket.id,
        students: new Map(),
        activeSpeaker: "teacher",
        material: null
      });
    } else {
      const room = rooms.get(roomId);
      room.teacherSocketId = socket.id;
      room.activeSpeaker = "teacher";
    }

    socket.emit("teacher-joined", { roomId });
    console.log(`[teacher] ${socket.id} → room ${roomId}`);
  });

  // ── Student joins ──────────────────────────────────────────────────────
  socket.on("join-as-student", (roomId, studentName = "Student") => {
    const room = getRoom(roomId);
    if (!room) { socket.emit("join-error", { message: "Room does not exist" }); return; }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = "student";

    room.students.set(socket.id, { name: studentName, handRaised: false, approved: false });

    socket.emit("student-joined", {
      roomId,
      hasTeacher: !!room.teacherSocketId,
      activeSpeaker: room.activeSpeaker,
      material: room.material
    });

    if (room.material) socket.emit("material-shared", room.material);

    // Tell teacher a new student arrived so teacher can initiate WebRTC offer
    if (room.teacherSocketId) {
      io.to(room.teacherSocketId).emit("student-connected", {
        studentId: socket.id,
        studentName,
        totalStudents: room.students.size
      });
    }

    console.log(`[student] ${socket.id} (${studentName}) → room ${roomId}`);
  });

  // ── WebRTC signaling relay ─────────────────────────────────────────────
  // All SDP and ICE messages are forwarded to the specified target socket.
  // The server never inspects audio — it only routes envelopes.

  // Teacher → Student: offer for teacher-to-student stream
  socket.on("webrtc-offer", ({ targetId, sdp }) => {
    io.to(targetId).emit("webrtc-offer", { fromId: socket.id, sdp });
  });

  // Student → Teacher: answer for teacher-to-student stream
  socket.on("webrtc-answer", ({ targetId, sdp }) => {
    io.to(targetId).emit("webrtc-answer", { fromId: socket.id, sdp });
  });

  // Student → Teacher: offer for student-to-teacher stream (when approved)
  socket.on("webrtc-offer-student", ({ targetId, sdp }) => {
    io.to(targetId).emit("webrtc-offer-student", { fromId: socket.id, sdp });
  });

  // Teacher → Student: answer for student-to-teacher stream
  socket.on("webrtc-answer-student", ({ targetId, sdp }) => {
    io.to(targetId).emit("webrtc-answer-student", { fromId: socket.id, sdp });
  });

  // ICE candidates — relay to target, preserving peerType so receiver
  // knows which RTCPeerConnection (inbound vs outbound) to add it to
  socket.on("ice-candidate", ({ targetId, candidate, peerType }) => {
    io.to(targetId).emit("ice-candidate", { fromId: socket.id, candidate, peerType });
  });

  // ── Raise-hand system ──────────────────────────────────────────────────
  socket.on("raise-hand", (roomId) => {
    const room = getRoom(roomId);
    if (!room || socket.role !== "student") return;
    const student = room.students.get(socket.id);
    if (!student || student.approved) return;

    student.handRaised = true;
    if (room.teacherSocketId) {
      io.to(room.teacherSocketId).emit("hand-raised", { studentId: socket.id, studentName: student.name });
    }
  });

  socket.on("cancel-hand", (roomId) => {
    const room = getRoom(roomId);
    if (!room || socket.role !== "student") return;
    const student = room.students.get(socket.id);
    if (!student) return;

    student.handRaised = false;
    if (room.teacherSocketId) {
      io.to(room.teacherSocketId).emit("hand-cancelled", { studentId: socket.id });
    }
  });

  // Teacher approves student → student will initiate a new peer connection to teacher
  socket.on("approve-speaker", ({ roomId, studentId }) => {
    const room = getRoom(roomId);
    if (!room || socket.role !== "teacher") return;
    const student = room.students.get(studentId);
    if (!student) return;

    student.approved = true;
    student.handRaised = false;
    room.activeSpeaker = studentId;

    io.to(roomId).emit("speaker-changed", {
      speakerId: studentId,
      speakerName: student.name,
      isTeacher: false
    });

    // Tell the student they can now open their mic and send an offer.
    // Include teacherSocketId so student can send the WebRTC offer directly
    // without a separate get-teacher-id round trip.
    io.to(studentId).emit("speak-approved", { teacherSocketId: socket.id });
    console.log(`[approve] ${student.name} approved in ${roomId}`);
  });

  // Teacher rejects hand raise
  socket.on("reject-hand", ({ roomId, studentId }) => {
    const room = getRoom(roomId);
    if (!room || socket.role !== "teacher") return;
    const student = room.students.get(studentId);
    if (student) student.handRaised = false;
    io.to(studentId).emit("hand-rejected");
  });

  // Teacher revokes speaking permission
  socket.on("revoke-speaker", (roomId) => {
    const room = getRoom(roomId);
    if (!room || socket.role !== "teacher") return;

    const prevSpeaker = room.activeSpeaker;
    room.activeSpeaker = "teacher";

    if (prevSpeaker !== "teacher") {
      const student = room.students.get(prevSpeaker);
      if (student) { student.approved = false; }
      io.to(prevSpeaker).emit("speak-revoked");
    }

    io.to(roomId).emit("speaker-changed", { speakerId: "teacher", speakerName: "Teacher", isTeacher: true });
    console.log(`[revoke] speaker revoked in ${roomId}`);
  });

  // ── Teacher requests current student list (after mic starts) ───────────
  socket.on("teacher-broadcasting", () => {
    const room = getRoom(socket.roomId);
    if (!room || socket.role !== "teacher") return;
    const students = [];
    room.students.forEach((info, id) => students.push({ studentId: id, studentName: info.name }));
    socket.emit("current-students", students);
  });

  // ── Material sharing ───────────────────────────────────────────────────
  socket.on("share-material", ({ roomId, url }) => {
    const room = getRoom(roomId);
    if (!room || socket.role !== "teacher") return;
    const data = { url, sharedAt: Date.now() };
    room.material = data;
    io.to(roomId).emit("material-shared", data);
  });

  socket.on("draw", ({ roomId, x, y, color, width }) => {
    if (socket.roomId) socket.to(roomId).emit("draw", { x, y, color, width });
  });

  socket.on("clear-canvas", (roomId) => {
    if (socket.roomId) io.to(roomId).emit("clear-canvas");
  });

  // ── Disconnect ─────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[disconnect] ${socket.id}`);
    const { roomId, role } = socket;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (role === "teacher") {
      io.to(roomId).emit("teacher-left");
      rooms.delete(roomId);
      console.log(`[room] ${roomId} closed`);
    } else if (role === "student") {
      const student = room.students.get(socket.id);
      const name = student?.name || "Unknown";
      room.students.delete(socket.id);

      if (room.activeSpeaker === socket.id) {
        room.activeSpeaker = "teacher";
        io.to(roomId).emit("speaker-changed", { speakerId: "teacher", speakerName: "Teacher", isTeacher: true });
      }

      if (room.teacherSocketId) {
        io.to(room.teacherSocketId).emit("student-left", {
          studentId: socket.id,
          studentName: name,
          totalStudents: room.students.size
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log("  AUDIO CLASSROOM — WebRTC Signaling Server");
  console.log("=".repeat(60));
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Teacher : http://localhost:${PORT}/teacher.html?room=test`);
  console.log(`  Student : http://localhost:${PORT}/student.html?room=test`);
  console.log("=".repeat(60));
});
