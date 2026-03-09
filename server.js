const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs-extra");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8, // 100MB max for audio chunks
  pingTimeout: 60000,
  pingInterval: 25000
});

// Create directories
const uploadsDir = path.join(__dirname, "uploads");
const publicUploadsDir = path.join(__dirname, "public", "uploads");

fs.ensureDirSync(uploadsDir);
fs.ensureDirSync(publicUploadsDir);

// Middleware
app.use(express.static("public"));
app.use(express.json({ limit: "50mb" }));

// File upload for materials
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only images allowed"));
    }
  }
});

// Upload endpoint
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const targetPath = path.join(publicUploadsDir, req.file.filename);

  fs.move(req.file.path, targetPath, { overwrite: true })
    .then(() => {
      res.json({
        url: `/uploads/${req.file.filename}`,
        filename: req.file.filename
      });
    })
    .catch(err => {
      console.error("File move failed:", err);
      res.status(500).json({ error: "File processing failed" });
    });
});

// ==================== SOCKET.IO WITH SPEAKER PERMISSION SYSTEM ====================
const rooms = new Map();

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Join as teacher
  socket.on("join-as-teacher", (roomId) => {
    leaveAllRooms(socket);
    
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = "teacher";

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        teacher: socket.id,
        students: new Map(), // Map of studentId -> {socketId, name, handRaised}
        material: null,
        audioActive: false,
        activeSpeaker: "teacher", // "teacher" or student socketId
        pendingRequests: new Set(), // Student IDs with hand raised
        recentChunks: [] // Store recent audio chunks for late joiners
      });
    } else {
      const room = rooms.get(roomId);
      room.teacher = socket.id;
      room.activeSpeaker = "teacher"; // Teacher becomes active speaker by default
    }

    socket.emit("teacher-joined", { roomId, success: true });
    console.log(`Teacher ${socket.id} joined ${roomId}`);
  });

  // Join as student
  socket.on("join-as-student", (roomId, studentName = "Student") => {
    leaveAllRooms(socket);

    if (!rooms.has(roomId)) {
      socket.emit("join-error", { message: "Room does not exist" });
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = "student";

    const room = rooms.get(roomId);
    room.students.set(socket.id, {
      socketId: socket.id,
      name: studentName,
      handRaised: false,
      canSpeak: false
    });

    // Send current room state
    socket.emit("student-joined", {
      roomId,
      hasTeacher: !!room.teacher,
      audioActive: room.audioActive,
      material: room.material,
      activeSpeaker: room.activeSpeaker
    });

    // Send material if exists
    if (room.material) {
      socket.emit("material-shared", room.material);
    }

    // If teacher is currently speaking, send recent chunks for quick sync
    if (room.audioActive && room.activeSpeaker === "teacher" && room.recentChunks && room.recentChunks.length > 0) {
      socket.emit("audio-recent-chunks", room.recentChunks);
    }

    // Notify teacher
    if (room.teacher) {
      io.to(room.teacher).emit("student-connected", {
        studentId: socket.id,
        studentName: studentName,
        totalStudents: room.students.size
      });
    }

    console.log(`Student ${socket.id} (${studentName}) joined ${roomId}`);
  });

  // Student raises hand
  socket.on("raise-hand", (roomId) => {
    if (socket.role !== "student" || socket.roomId !== roomId) return;

    const room = rooms.get(roomId);
    if (!room || !room.teacher) return;

    const student = room.students.get(socket.id);
    if (student) {
      student.handRaised = true;
      room.pendingRequests.add(socket.id);

      // Notify teacher
      io.to(room.teacher).emit("hand-raised", {
        studentId: socket.id,
        studentName: student.name
      });
    }
  });

  // Student cancels hand raise
  socket.on("cancel-hand", (roomId) => {
    if (socket.role !== "student" || socket.roomId !== roomId) return;

    const room = rooms.get(roomId);
    if (!room || !room.teacher) return;

    const student = room.students.get(socket.id);
    if (student) {
      student.handRaised = false;
      room.pendingRequests.delete(socket.id);

      // Notify teacher
      io.to(room.teacher).emit("hand-cancelled", {
        studentId: socket.id
      });
    }
  });

  // Teacher approves student to speak
  socket.on("approve-speaker", (data) => {
    const { roomId, studentId } = data;

    if (socket.role !== "teacher" || socket.roomId !== roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const student = room.students.get(studentId);
    if (!student) return;

    // Set active speaker to this student
    room.activeSpeaker = studentId;
    student.canSpeak = true;
    student.handRaised = false;
    room.pendingRequests.delete(studentId);

    // Notify all students who the new speaker is
    io.to(roomId).emit("speaker-changed", {
      speakerId: studentId,
      speakerName: student.name,
      isTeacher: false
    });

    // Notify the approved student to start broadcasting
    io.to(studentId).emit("speak-approved");

    // Notify teacher that approval was sent
    socket.emit("speaker-approved", { studentId, studentName: student.name });

    console.log(`Teacher approved ${student.name} to speak in ${roomId}`);
  });

  // Teacher revokes student speaking permission
  socket.on("revoke-speaker", (roomId) => {
    if (socket.role !== "teacher" || socket.roomId !== roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const previousSpeaker = room.activeSpeaker;
    
    // Set active speaker back to teacher
    room.activeSpeaker = "teacher";

    // If a student was speaking, update their status
    if (previousSpeaker !== "teacher") {
      const student = room.students.get(previousSpeaker);
      if (student) {
        student.canSpeak = false;
        // Tell that student to stop broadcasting
        io.to(previousSpeaker).emit("speak-revoked");
      }
    }

    // Notify everyone that teacher is now speaking
    io.to(roomId).emit("speaker-changed", {
      speakerId: "teacher",
      speakerName: "Teacher",
      isTeacher: true
    });

    console.log(`Teacher revoked speaking permission in ${roomId}`);
  });

  // Teacher rejects student hand raise
  socket.on("reject-hand", (data) => {
    const { roomId, studentId } = data;

    if (socket.role !== "teacher" || socket.roomId !== roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const student = room.students.get(studentId);
    if (student) {
      student.handRaised = false;
      room.pendingRequests.delete(studentId);

      // Notify student they were rejected
      io.to(studentId).emit("hand-rejected");
    }
  });

  // AUDIO: Audio chunk from current speaker
  socket.on("audio-chunk", (data) => {
    const { roomId, chunk } = data;
    
    const room = rooms.get(roomId);
    if (!room) return;

    // Verify sender is the active speaker
    const isTeacher = socket.role === "teacher" && socket.id === room.teacher;
    const isApprovedStudent = socket.role === "student" && 
                             socket.id === room.activeSpeaker && 
                             room.students.get(socket.id)?.canSpeak === true;

    if (!isTeacher && !isApprovedStudent) {
      return; // Not authorized to send audio
    }

    room.audioActive = true;

    // Store recent chunks for late-joining students (keep last 10 chunks)
    if (!room.recentChunks) room.recentChunks = [];
    room.recentChunks.push({
      chunk: chunk,
      timestamp: Date.now()
    });
    if (room.recentChunks.length > 10) {
      room.recentChunks.shift();
    }

    // Broadcast to everyone EXCEPT the sender
    socket.to(roomId).emit("audio-chunk", {
      chunk: chunk,
      speakerId: socket.id,
      isTeacher: socket.role === "teacher",
      timestamp: Date.now()
    });
  });

  // AUDIO: Speaker started - FIXED: Send proper data object
  socket.on("audio-start", (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Verify sender is the active speaker
    const isTeacher = socket.role === "teacher" && socket.id === room.teacher;
    const isApprovedStudent = socket.role === "student" && 
                             socket.id === room.activeSpeaker && 
                             room.students.get(socket.id)?.canSpeak === true;

    if (!isTeacher && !isApprovedStudent) return;

    room.audioActive = true;
    
    // FIX: Send data object with speaker info
    io.to(roomId).emit("audio-started", {
      speakerId: socket.id,
      isTeacher: socket.role === "teacher",
      timestamp: Date.now()
    });
    
    console.log(`Audio started in ${roomId} by ${socket.role}`);
  });

  // AUDIO: Speaker stopped - FIXED: Send proper data object
  socket.on("audio-stop", (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const isTeacher = socket.role === "teacher" && socket.id === room.teacher;
    const isApprovedStudent = socket.role === "student" && 
                             socket.id === room.activeSpeaker && 
                             room.students.get(socket.id)?.canSpeak === true;

    if (!isTeacher && !isApprovedStudent) return;

    room.audioActive = false;
    room.recentChunks = []; // Clear recent chunks when audio stops
    
    // FIX: Send data object
    io.to(roomId).emit("audio-stopped", {
      speakerId: socket.id,
      isTeacher: socket.role === "teacher"
    });
    
    console.log(`Audio stopped in ${roomId}`);
  });

  // Material sharing
  socket.on("share-material", (data) => {
    const { roomId, url } = data;

    if (socket.role !== "teacher" || socket.roomId !== roomId) {
      socket.emit("error", { message: "Only teacher can share materials" });
      return;
    }

    const room = rooms.get(roomId);
    if (room) {
      const materialData = { url, sharedBy: socket.id, sharedAt: Date.now() };
      room.material = materialData;
      
      // Broadcast to ALL students
      io.to(roomId).emit("material-shared", materialData);
      console.log(`Material shared in ${roomId}: ${url}`);
    }
  });

  // Drawing
  socket.on("draw", (data) => {
    const { roomId, x, y, color, width } = data;
    if (!socket.roomId) return;
    socket.to(roomId).emit("draw", { x, y, color, width });
  });

  socket.on("clear-canvas", (roomId) => {
    if (!socket.roomId) return;
    io.to(roomId).emit("clear-canvas");
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);

      if (socket.role === "teacher") {
        // Teacher disconnected - notify all students
        io.to(socket.roomId).emit("teacher-left");
        rooms.delete(socket.roomId);
        console.log(`Room ${socket.roomId} closed due to teacher disconnect`);
        
      } else if (socket.role === "student") {
        const student = room.students.get(socket.id);
        const studentName = student?.name || "Unknown";
        
        room.students.delete(socket.id);
        room.pendingRequests.delete(socket.id);

        // If this student was the active speaker, revert to teacher
        if (room.activeSpeaker === socket.id) {
          room.activeSpeaker = "teacher";
          
          // Notify everyone that teacher is now speaking
          io.to(socket.roomId).emit("speaker-changed", {
            speakerId: "teacher",
            speakerName: "Teacher",
            isTeacher: true
          });
          
          // Stop audio if it was active
          if (room.audioActive) {
            room.audioActive = false;
            io.to(socket.roomId).emit("audio-stopped", {
              speakerId: "teacher",
              isTeacher: true
            });
          }
        }
        
        if (room.teacher) {
          io.to(room.teacher).emit("student-left", {
            studentId: socket.id,
            studentName: studentName,
            totalStudents: room.students.size
          });
        }
      }
    }
  });

  function leaveAllRooms(socket) {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const oldRoom = rooms.get(socket.roomId);
      if (socket.role === "student") {
        oldRoom.students.delete(socket.id);
        oldRoom.pendingRequests.delete(socket.id);
      }
    }
    
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
      }
    });
    
    socket.roomId = null;
    socket.role = null;
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log("AUDIO RELAY CLASSROOM - WITH SPEAKER PERMISSION SYSTEM");
  console.log("=".repeat(60));
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Teacher: http://localhost:${PORT}/teacher.html?room=test`);
  console.log(`Student: http://localhost:${PORT}/student.html?room=test`);
  console.log("=".repeat(60));
});