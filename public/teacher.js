// ==================== TEACHER - WITH SPEAKER MANAGEMENT ====================
// Get room from URL
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room') || 'test';
document.getElementById('roomDisplay').textContent = roomId;

// Socket connection
const socket = io();

// DOM Elements - Audio
const connectionStatus = document.getElementById('connectionStatus');
const startAudioBtn = document.getElementById('startAudioBtn');
const stopAudioBtn = document.getElementById('stopAudioBtn');
const micStatus = document.getElementById('micStatus');
const broadcastStatus = document.getElementById('broadcastStatus');
const visualizer = document.getElementById('audioVisualizer');
const studentCount = document.getElementById('studentCount');
const studentsList = document.getElementById('studentsList');
const pendingRequestsList = document.getElementById('pendingRequestsList');
const activeSpeakerDisplay = document.getElementById('activeSpeakerDisplay');
const revokeSpeakerBtn = document.getElementById('revokeSpeakerBtn');

// DOM Elements - Material
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadMaterial');
const clearMaterialBtn = document.getElementById('clearMaterial');
const materialImg = document.getElementById('material');
const noMaterial = document.getElementById('noMaterial');
const penToggle = document.getElementById('penToggle');
const penNormalBtn = document.getElementById('penNormal');
const penBoldBtn = document.getElementById('penBold');
const colorPicker = document.getElementById('colorPicker');
const clearCanvasBtn = document.getElementById('clearCanvas');
const canvas = document.getElementById('materialCanvas');
const ctx = canvas.getContext('2d');

// Audio state
let mediaRecorder = null;
let audioStream = null;
let isBroadcasting = false;
let audioContext = null;
let analyser = null;
let animationFrame = null;

// Drawing state
let canDraw = false;
let penWidth = 2;
let currentColor = '#ff0000';
let drawing = false;

// Speaker management state
let activeSpeaker = 'teacher'; // 'teacher' or studentId
let pendingRequests = new Map(); // studentId -> {name}

// ==================== CONNECTION ====================
socket.emit('join-as-teacher', roomId);

socket.on('connect', () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.className = 'status-badge connected';
});

socket.on('disconnect', () => {
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.className = 'status-badge disconnected';
    stopBroadcasting();
});

socket.on('teacher-joined', () => {
    startAudioBtn.disabled = false;
    updateActiveSpeakerDisplay('teacher', 'Teacher');
});

// Student management
socket.on('student-connected', (data) => {
    studentCount.textContent = data.totalStudents;
    addStudentToList(data.studentId, data.studentName);
});

socket.on('student-left', (data) => {
    studentCount.textContent = data.totalStudents;
    removeStudentFromList(data.studentId);
    
    // Remove from pending requests if present
    if (pendingRequests.has(data.studentId)) {
        pendingRequests.delete(data.studentId);
        updatePendingRequestsList();
    }
});

// ==================== SPEAKER MANAGEMENT ====================
// Student raised hand
socket.on('hand-raised', (data) => {
    pendingRequests.set(data.studentId, data.studentName);
    updatePendingRequestsList();
    
    // Optional: Visual notification
    visualizer.classList.add('warning');
    setTimeout(() => visualizer.classList.remove('warning'), 1000);
});

// Student cancelled hand
socket.on('hand-cancelled', (data) => {
    pendingRequests.delete(data.studentId);
    updatePendingRequestsList();
});

// Speaker changed (when someone else starts speaking)
socket.on('speaker-changed', (data) => {
    activeSpeaker = data.speakerId;
    updateActiveSpeakerDisplay(data.speakerId, data.speakerName);
    
    if (!data.isTeacher) {
        // A student is now speaking, update UI
        revokeSpeakerBtn.disabled = false;
    } else {
        revokeSpeakerBtn.disabled = true;
    }
});

// Approve speaker button click handler
function approveSpeaker(studentId) {
    socket.emit('approve-speaker', {
        roomId: roomId,
        studentId: studentId
    });
}

// Reject hand raise
function rejectHand(studentId) {
    socket.emit('reject-hand', {
        roomId: roomId,
        studentId: studentId
    });
    pendingRequests.delete(studentId);
    updatePendingRequestsList();
}

// Revoke speaker permission
revokeSpeakerBtn.onclick = () => {
    socket.emit('revoke-speaker', roomId);
};

// Update active speaker display
function updateActiveSpeakerDisplay(speakerId, speakerName) {
    if (speakerId === 'teacher') {
        activeSpeakerDisplay.innerHTML = '<span class="speaker-indicator teacher">👨‍🏫 Teacher</span>';
    } else {
        activeSpeakerDisplay.innerHTML = `<span class="speaker-indicator student">👨‍🎓 ${speakerName}</span>`;
    }
}

// Update pending requests list in UI
function updatePendingRequestsList() {
    if (!pendingRequestsList) return;
    
    pendingRequestsList.innerHTML = '';
    
    if (pendingRequests.size === 0) {
        pendingRequestsList.innerHTML = '<li class="no-requests">No pending requests</li>';
        return;
    }
    
    pendingRequests.forEach((name, id) => {
        const li = document.createElement('li');
        li.className = 'pending-request';
        li.innerHTML = `
            <span class="student-name">${name}</span>
            <div class="request-actions">
                <button class="approve-btn" onclick="approveSpeaker('${id}')">✓</button>
                <button class="reject-btn" onclick="rejectHand('${id}')">✗</button>
            </div>
        `;
        pendingRequestsList.appendChild(li);
    });
}

// Make functions global for onclick handlers
window.approveSpeaker = approveSpeaker;
window.rejectHand = rejectHand;

// ==================== AUDIO BROADCASTING WITH MEDIARECORDER ====================
startAudioBtn.onclick = async () => {
    try {
        console.log('Starting audio broadcast...');
        
        // Request microphone
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
            }
        });

        console.log('Microphone access granted');

        // Setup visualizer
        setupVisualizer();

        // Create MediaRecorder with specific options - use 250ms chunks for lower latency
        const options = { 
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: 24000
        };
        
        // Check if browser supports the MIME type
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            console.warn('Opus not supported, using default');
            mediaRecorder = new MediaRecorder(audioStream);
        } else {
            mediaRecorder = new MediaRecorder(audioStream, options);
        }

        console.log('Using MIME type:', mediaRecorder.mimeType);

        // Handle audio data - 250ms chunks for lower latency
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && isBroadcasting) {
                console.log('Sending audio chunk, size:', event.data.size);
                
                // Convert to base64 for reliable transmission
                const reader = new FileReader();
                reader.onload = () => {
                    const base64Audio = reader.result.split(',')[1];
                    
                    socket.emit('audio-chunk', {
                        roomId: roomId,
                        chunk: base64Audio
                    });
                    
                    // Update visualizer
                    if (visualizer) {
                        visualizer.classList.add('active');
                        setTimeout(() => visualizer.classList.remove('active'), 50);
                    }
                };
                reader.readAsDataURL(event.data);
            }
        };

        // Start recording - send chunks every 250ms for lower latency
        mediaRecorder.start(250);
        isBroadcasting = true;

        // Update UI
        startAudioBtn.disabled = true;
        stopAudioBtn.disabled = false;
        micStatus.textContent = 'Active';
        micStatus.className = 'status-value active';
        broadcastStatus.textContent = 'Broadcasting';
        broadcastStatus.className = 'status-value active';

        // Notify server
        socket.emit('audio-start', roomId);
        
        console.log('Audio broadcasting started with 250ms chunks');

    } catch (err) {
        console.error('Error starting audio:', err);
        alert('Microphone error: ' + err.message);
    }
};

// Stop broadcasting
stopAudioBtn.onclick = () => {
    stopBroadcasting();
};

function stopBroadcasting() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    
    if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
    }
    
    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
    }
    
    isBroadcasting = false;
    
    // Update UI
    startAudioBtn.disabled = false;
    stopAudioBtn.disabled = true;
    micStatus.textContent = 'Stopped';
    micStatus.className = 'status-value inactive';
    broadcastStatus.textContent = 'Off';
    broadcastStatus.className = 'status-value inactive';
    
    // Notify server
    socket.emit('audio-stop', roomId);
    
    console.log('Audio broadcasting stopped');
}

// Visualizer
function setupVisualizer() {
    if (!audioStream) return;
    
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    
    const source = audioContext.createMediaStreamSource(audioStream);
    source.connect(analyser);
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    function draw() {
        if (!analyser || !visualizer) return;
        
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const percentage = (average / 255) * 100;
        
        visualizer.style.setProperty('--width', percentage + '%');
        
        animationFrame = requestAnimationFrame(draw);
    }
    
    draw();
}

// Student list functions
function addStudentToList(studentId, studentName) {
    const li = document.createElement('li');
    li.id = `student-${studentId}`;
    li.className = 'student-item';
    li.innerHTML = `
        <span class="student-name">${studentName}</span>
        <span class="student-id">(${studentId.substr(0, 6)})</span>
    `;
    studentsList.appendChild(li);
}

function removeStudentFromList(studentId) {
    const li = document.getElementById(`student-${studentId}`);
    if (li) li.remove();
}

// ==================== MATERIAL (UNCHANGED) ====================
uploadBtn.onclick = async () => {
    const file = fileInput.files[0];
    if (!file) {
        alert('Select a file');
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data.error) {
            alert(data.error);
            return;
        }

        materialImg.src = data.url;
        materialImg.style.display = 'block';
        noMaterial.style.display = 'none';

        socket.emit('share-material', {
            roomId: roomId,
            url: data.url
        });

        initCanvas();

    } catch (err) {
        console.error('Upload failed:', err);
        alert('Upload failed');
    }
};

clearMaterialBtn.onclick = () => {
    materialImg.src = '';
    materialImg.style.display = 'none';
    noMaterial.style.display = 'block';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canDraw = false;
    penToggle.textContent = '🖊️ Enable Drawing';
    canvas.classList.remove('active');
};

// ==================== DRAWING (UNCHANGED) ====================
function initCanvas() {
    materialImg.onload = () => {
        canvas.width = materialImg.width;
        canvas.height = materialImg.height;
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
}

penToggle.onclick = () => {
    canDraw = !canDraw;
    canvas.classList.toggle('active', canDraw);
    penToggle.textContent = canDraw ? '🖊️ Disable Drawing' : '🖊️ Enable Drawing';
};

penNormalBtn.onclick = () => penWidth = 2;
penBoldBtn.onclick = () => penWidth = 5;
colorPicker.onchange = (e) => currentColor = e.target.value;

clearCanvasBtn.onclick = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    socket.emit('clear-canvas', roomId);
};

function getPointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    let clientX, clientY;

    if (e.touches) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
        e.preventDefault();
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }

    return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
    };
}

function draw(e) {
    if (!canDraw) return;
    e.preventDefault();

    const { x, y } = getPointerPos(e);

    ctx.lineWidth = penWidth;
    ctx.lineCap = 'round';
    ctx.strokeStyle = currentColor;

    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);

    socket.emit('draw', {
        roomId: roomId,
        x, y,
        color: currentColor,
        width: penWidth
    });
}

// Mouse events
canvas.addEventListener('mousedown', (e) => {
    if (!canDraw) return;
    drawing = true;
    ctx.beginPath();
    draw(e);
});

canvas.addEventListener('mousemove', (e) => {
    if (!canDraw || !drawing) return;
    draw(e);
});

canvas.addEventListener('mouseup', () => {
    if (!canDraw) return;
    drawing = false;
    ctx.beginPath();
});

canvas.addEventListener('mouseout', () => {
    if (!canDraw) return;
    drawing = false;
    ctx.beginPath();
});

// Touch events
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!canDraw) return;
    drawing = true;
    ctx.beginPath();
    draw(e);
});

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!canDraw || !drawing) return;
    draw(e);
});

canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (!canDraw) return;
    drawing = false;
    ctx.beginPath();
});

// Cleanup
window.addEventListener('beforeunload', () => {
    if (isBroadcasting) {
        stopBroadcasting();
    }
});

console.log('Teacher ready for room:', roomId);