// ==================== STUDENT - WITH MEDIASOURCE AUDIO ====================
// Get room from URL
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room') || 'test';
let studentName = urlParams.get('name') || 'Student-' + Math.random().toString(36).substr(2, 6);
document.getElementById('roomDisplay').textContent = roomId;
document.getElementById('studentNameDisplay').textContent = studentName;

// Socket connection
const socket = io();

// DOM Elements
const connectionStatus = document.getElementById('connectionStatus');
const teacherStatus = document.getElementById('teacherStatus');
const audioStatus = document.getElementById('audioStatus');
const visualizer = document.getElementById('audioVisualizer');
const testAudioBtn = document.getElementById('testAudioBtn');
const unlockAudioBtn = document.getElementById('unlockAudioBtn');
const audioWarning = document.getElementById('audioWarning');
const raiseHandBtn = document.getElementById('raiseHandBtn');
const cancelHandBtn = document.getElementById('cancelHandBtn');
const speakingIndicator = document.getElementById('speakingIndicator');
const activeSpeakerDisplay = document.getElementById('activeSpeakerDisplay');

// Material elements
const materialImg = document.getElementById('material');
const canvas = document.getElementById('materialCanvas');
const noMaterial = document.getElementById('noMaterial');
const ctx = canvas.getContext('2d');

// ==================== AUDIO STATE WITH MEDIASOURCE ====================
let mediaSource = null;
let sourceBuffer = null;
let audio = null;
let audioQueue = [];
let isAppending = false;
let audioInitialized = false;
let audioUnlocked = false;

// Permission state
let canSpeak = false;
let handRaised = false;
let activeSpeaker = 'teacher'; // 'teacher' or studentId
let myStudentId = null;

// Show warning if audio not unlocked
function updateAudioWarning() {
    if (audioWarning) {
        audioWarning.style.display = audioUnlocked ? 'none' : 'block';
    }
}

// ==================== MEDIASOURCE INITIALIZATION ====================
async function initAudio() {
    if (audioInitialized) return true;
    
    try {
        // Create audio element
        audio = new Audio();
        
        // Create MediaSource
        mediaSource = new MediaSource();
        
        // Set up event handlers
        mediaSource.addEventListener('sourceopen', onMediaSourceOpen);
        mediaSource.addEventListener('sourceended', onMediaSourceEnded);
        mediaSource.addEventListener('sourceclose', onMediaSourceClose);
        
        // Connect media source to audio element
        audio.src = URL.createObjectURL(mediaSource);
        
        // Load the audio element
        audio.load();
        
        // Set up audio element event handlers
        audio.addEventListener('error', (e) => {
            console.error('Audio element error:', audio.error);
        });
        
        audio.addEventListener('playing', () => {
            console.log('Audio started playing');
        });
        
        audio.addEventListener('pause', () => {
            console.log('Audio paused');
        });
        
        audioInitialized = true;
        
        console.log('MediaSource initialized');
        return true;
        
    } catch (err) {
        console.error('Failed to initialize MediaSource:', err);
        return false;
    }
}

function onMediaSourceOpen() {
    console.log('MediaSource opened');
    
    try {
        // Add source buffer for WebM Opus audio
        // Try different MIME types for browser compatibility
        const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus'
        ];
        
        for (const mimeType of mimeTypes) {
            if (MediaSource.isTypeSupported(mimeType)) {
                sourceBuffer = mediaSource.addSourceBuffer(mimeType);
                console.log('Using MIME type:', mimeType);
                break;
            }
        }
        
        if (!sourceBuffer) {
            console.error('No supported MIME type found');
            return;
        }
        
        // Configure source buffer
        sourceBuffer.mode = 'sequence'; // Append in sequence
        
        // Handle updateend events
        sourceBuffer.addEventListener('updateend', () => {
            console.log('SourceBuffer update completed, queue length:', audioQueue.length);
            isAppending = false;
            processAudioQueue();
        });
        
        sourceBuffer.addEventListener('error', (e) => {
            console.error('SourceBuffer error:', e);
        });
        
        sourceBuffer.addEventListener('abort', () => {
            console.log('SourceBuffer abort');
        });
        
        // Process any queued chunks
        if (audioQueue.length > 0) {
            processAudioQueue();
        }
        
    } catch (err) {
        console.error('Error adding source buffer:', err);
    }
}

function onMediaSourceEnded() {
    console.log('MediaSource ended');
}

function onMediaSourceClose() {
    console.log('MediaSource closed');
}

// ==================== PROCESS AUDIO QUEUE ====================
function processAudioQueue() {
    if (!sourceBuffer || isAppending || audioQueue.length === 0 || !audioUnlocked) {
        return;
    }
    
    // Check if MediaSource is still open
    if (mediaSource.readyState !== 'open') {
        console.log('MediaSource not open, current state:', mediaSource.readyState);
        return;
    }
    
    // Check if source buffer is ready for more data
    if (sourceBuffer.updating) {
        console.log('SourceBuffer is busy, waiting...');
        return;
    }
    
    try {
        isAppending = true;
        const chunkData = audioQueue.shift();
        
        // Convert base64 to ArrayBuffer
        const binaryString = atob(chunkData);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Append to source buffer
        sourceBuffer.appendBuffer(bytes.buffer);
        
        // Update visualizer
        if (visualizer) {
            visualizer.classList.add('active');
            setTimeout(() => visualizer.classList.remove('active'), 50);
        }
        
        console.log('Appended chunk to MediaSource, remaining:', audioQueue.length);
        
    } catch (err) {
        console.error('Error appending to source buffer:', err);
        isAppending = false;
        
        // If we get a QuotaExceededError, we need to remove old data
        if (err.name === 'QuotaExceededError') {
            console.log('Buffer quota exceeded, removing old data...');
            if (sourceBuffer && !sourceBuffer.updating && mediaSource.readyState === 'open') {
                // Remove data older than 30 seconds
                try {
                    const currentTime = audio ? audio.currentTime : 30;
                    sourceBuffer.remove(0, Math.max(0, currentTime - 30));
                } catch (removeErr) {
                    console.error('Error removing old data:', removeErr);
                }
            }
        } else {
            // For other errors, retry after a delay
            setTimeout(() => {
                processAudioQueue();
            }, 100);
        }
    }
}

// ==================== FIXED AUDIO UNLOCK ====================
async function unlockAudio() {
    if (audioUnlocked) return true;
    
    try {
        // Initialize audio system if needed
        if (!audioInitialized) {
            await initAudio();
        }
        
        // Don't try to play if already playing
        if (audio && !audio.paused) {
            audioUnlocked = true;
            updateAudioWarning();
            return true;
        }
        
        // Create a silent audio context to unlock - this is more reliable
        const tempAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        // Create silent buffer
        const silentBuffer = tempAudioCtx.createBuffer(1, 1, 22050);
        const source = tempAudioCtx.createBufferSource();
        source.buffer = silentBuffer;
        source.connect(tempAudioCtx.destination);
        
        // Resume if suspended
        if (tempAudioCtx.state === 'suspended') {
            await tempAudioCtx.resume();
        }
        
        // Play silent sound
        source.start(0);
        
        // Small delay to ensure audio context is active
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Now try to play the main audio with a user interaction flag
        if (audio) {
            // Set a flag that we're trying to play
            audio.dataset.playing = 'false';
            
            // Add one-time event listener for play success
            audio.addEventListener('play', function onPlay() {
                console.log('Audio playback started successfully');
                audio.dataset.playing = 'true';
                audio.removeEventListener('play', onPlay);
            }, { once: true });
            
            // Add one-time error handler
            audio.addEventListener('error', function onError(e) {
                console.error('Audio playback error:', audio.error);
                audio.removeEventListener('error', onError);
            }, { once: true });
            
            // Attempt to play
            const playPromise = audio.play();
            
            if (playPromise !== undefined) {
                await playPromise.catch(err => {
                    // Don't throw if it's just an interruption
                    if (err.name !== 'AbortError') {
                        throw err;
                    }
                    console.log('Play was interrupted, but that\'s ok');
                });
            }
        }
        
        // Close temp context after a short delay
        setTimeout(() => {
            if (tempAudioCtx.state !== 'closed') {
                tempAudioCtx.close().catch(console.warn);
            }
        }, 500);
        
        audioUnlocked = true;
        updateAudioWarning();
        
        console.log('Audio unlocked successfully');
        
        // Process queue if needed
        if (audioQueue.length > 0 && sourceBuffer && !isAppending) {
            processAudioQueue();
        }
        
        return true;
        
    } catch (err) {
        console.error('Failed to unlock audio:', err);
        return false;
    }
}

// ==================== SOCKET EVENTS ====================
socket.emit('join-as-student', roomId, studentName);

// Connection
socket.on('connect', () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.className = 'status-badge connected';
    myStudentId = socket.id;
});

socket.on('disconnect', () => {
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.className = 'status-badge disconnected';
    teacherStatus.textContent = 'Disconnected';
    teacherStatus.className = 'status-value inactive';
});

// Room state
socket.on('student-joined', (data) => {
    console.log('Joined room:', data);
    
    if (data.hasTeacher) {
        teacherStatus.textContent = 'Teacher Online';
        teacherStatus.className = 'status-value active';
    }
    
    updateAudioWarning();
});

socket.on('teacher-left', () => {
    teacherStatus.textContent = 'Teacher Offline';
    teacherStatus.className = 'status-value inactive';
    audioStatus.textContent = 'No Audio';
    audioStatus.className = 'status-value inactive';
    audioQueue = [];
});

// Audio events - FIXED: Handle both string and object data
socket.on('audio-started', (data) => {
    console.log('Audio started by:', data?.speakerId || 'unknown');
    
    // Handle case when data is just a roomId (string)
    if (typeof data === 'string') {
        audioStatus.textContent = 'Live';
        audioStatus.className = 'status-value active';
    } else if (!data || data.isTeacher || data.speakerId !== myStudentId) {
        audioStatus.textContent = 'Live';
        audioStatus.className = 'status-value active';
    }
});

socket.on('audio-stopped', (data) => {
    console.log('Audio stopped');
    audioStatus.textContent = 'No Audio';
    audioStatus.className = 'status-value inactive';
    
    // Don't clear queue, just pause
    if (audio && !audio.paused) {
        audio.pause();
    }
});

// Audio chunk reception with MediaSource
socket.on('audio-chunk', (data) => {
    console.log('Received audio chunk, size:', data.chunk.length);
    
    // Queue the base64 data
    audioQueue.push(data.chunk);
    
    // Try to play if unlocked and initialized
    if (audioUnlocked && sourceBuffer && !isAppending) {
        processAudioQueue();
    }
    
    // Visualizer feedback
    if (visualizer) {
        visualizer.classList.add('active');
        setTimeout(() => visualizer.classList.remove('active'), 50);
    }
});

// Recent chunks for late joining
socket.on('audio-recent-chunks', (chunks) => {
    console.log('Received recent chunks for sync:', chunks.length);
    
    // Queue recent chunks
    chunks.forEach(chunk => {
        audioQueue.push(chunk.chunk);
    });
    
    // Process if ready
    if (audioUnlocked && sourceBuffer && !isAppending) {
        processAudioQueue();
    }
});

// ==================== SPEAKER PERMISSION HANDLING ====================
// Speaker changed
socket.on('speaker-changed', (data) => {
    if (!data) return;
    
    activeSpeaker = data.speakerId;
    
    if (data.isTeacher) {
        activeSpeakerDisplay.innerHTML = '<span class="speaker-indicator teacher">👨‍🏫 Teacher speaking</span>';
    } else {
        activeSpeakerDisplay.innerHTML = `<span class="speaker-indicator student">👨‍🎓 ${data.speakerName || 'Student'} speaking</span>`;
    }
    
    // Update speaking indicator for self
    if (data.speakerId === myStudentId) {
        speakingIndicator.style.display = 'block';
        canSpeak = true;
        raiseHandBtn.disabled = true;
        cancelHandBtn.disabled = true;
    } else {
        speakingIndicator.style.display = 'none';
        canSpeak = false;
    }
});

// Speak approved (student can now broadcast)
socket.on('speak-approved', () => {
    console.log('Speak approved! You can now broadcast');
    canSpeak = true;
    handRaised = false;
    
    // Update UI
    raiseHandBtn.disabled = true;
    cancelHandBtn.disabled = true;
    speakingIndicator.style.display = 'block';
    
    // Start broadcasting
    startStudentBroadcast();
});

// Speak revoked
socket.on('speak-revoked', () => {
    console.log('Speak permission revoked');
    canSpeak = false;
    
    // Update UI
    raiseHandBtn.disabled = false;
    cancelHandBtn.disabled = true;
    speakingIndicator.style.display = 'none';
    
    // Stop broadcasting
    stopStudentBroadcast();
});

// Hand rejected
socket.on('hand-rejected', () => {
    console.log('Hand raise rejected');
    handRaised = false;
    
    // Update UI
    raiseHandBtn.disabled = false;
    cancelHandBtn.disabled = true;
    
    // Show temporary message
    alert('Your request to speak was declined');
});

// Raise hand
raiseHandBtn.onclick = () => {
    socket.emit('raise-hand', roomId);
    handRaised = true;
    raiseHandBtn.disabled = true;
    cancelHandBtn.disabled = false;
};

// Cancel hand
cancelHandBtn.onclick = () => {
    socket.emit('cancel-hand', roomId);
    handRaised = false;
    raiseHandBtn.disabled = false;
    cancelHandBtn.disabled = true;
};

// ==================== STUDENT BROADCASTING (when approved) ====================
let studentMediaRecorder = null;
let studentAudioStream = null;
let isStudentBroadcasting = false;

async function startStudentBroadcast() {
    if (!canSpeak) return;
    
    try {
        console.log('Starting student broadcast...');
        
        // Request microphone
        studentAudioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
            }
        });

        console.log('Student microphone access granted');

        // Create MediaRecorder
        const options = { 
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: 24000
        };
        
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            studentMediaRecorder = new MediaRecorder(studentAudioStream);
        } else {
            studentMediaRecorder = new MediaRecorder(studentAudioStream, options);
        }

        // Handle audio data
        studentMediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && isStudentBroadcasting) {
                console.log('Student sending audio chunk, size:', event.data.size);
                
                const reader = new FileReader();
                reader.onload = () => {
                    const base64Audio = reader.result.split(',')[1];
                    
                    socket.emit('audio-chunk', {
                        roomId: roomId,
                        chunk: base64Audio
                    });
                };
                reader.readAsDataURL(event.data);
            }
        };

        // Start recording - 250ms chunks
        studentMediaRecorder.start(250);
        isStudentBroadcasting = true;

        // Notify server
        socket.emit('audio-start', roomId);
        
        console.log('Student broadcasting started');

    } catch (err) {
        console.error('Error starting student broadcast:', err);
        alert('Microphone error: ' + err.message);
    }
}

function stopStudentBroadcast() {
    if (studentMediaRecorder && studentMediaRecorder.state !== 'inactive') {
        studentMediaRecorder.stop();
    }
    
    if (studentAudioStream) {
        studentAudioStream.getTracks().forEach(track => track.stop());
        studentAudioStream = null;
    }
    
    isStudentBroadcasting = false;
    
    // Notify server
    socket.emit('audio-stop', roomId);
    
    console.log('Student broadcasting stopped');
}

// ==================== USER INTERACTION ====================
// FIXED: Test audio button
testAudioBtn.onclick = async (e) => {
    e.stopPropagation(); // Prevent triggering the document click
    
    await unlockAudio();
    
    if (!audio) return;
    
    try {
        // Pause main audio briefly to avoid conflict
        const wasPlaying = audio && !audio.paused;
        if (wasPlaying) {
            audio.pause();
        }
        
        // Test tone using Web Audio
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        await audioCtx.resume();
        
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.value = 440;
        gainNode.gain.value = 0.1;
        
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.5);
        
        console.log('Test tone played');
        
        // Resume main audio after test tone
        setTimeout(() => {
            if (wasPlaying && audio) {
                audio.play().catch(err => {
                    console.log('Could not resume main audio:', err);
                });
            }
            audioCtx.close();
        }, 600);
        
    } catch (err) {
        console.error('Test failed:', err);
    }
};

if (unlockAudioBtn) {
    unlockAudioBtn.onclick = unlockAudio;
}

// FIXED: Click handler with once option to prevent multiple attempts
document.addEventListener('click', async function onClick() {
    if (!audioUnlocked) {
        // Remove the event listener after first click to prevent multiple attempts
        document.removeEventListener('click', onClick);
        
        // Small delay to ensure click event is fully processed
        setTimeout(async () => {
            await unlockAudio();
        }, 50);
    }
}, { once: true }); // Use once: true to only fire once

// ==================== MATERIAL (UNCHANGED) ====================
socket.on('material-shared', (data) => {
    console.log('Material received:', data.url);
    materialImg.src = data.url;
    materialImg.style.display = 'block';
    noMaterial.style.display = 'none';
    
    materialImg.onload = () => {
        canvas.width = materialImg.width;
        canvas.height = materialImg.height;
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
});

socket.on('draw', (data) => {
    ctx.lineWidth = data.width;
    ctx.lineCap = 'round';
    ctx.strokeStyle = data.color;
    ctx.lineTo(data.x, data.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(data.x, data.y);
});

socket.on('clear-canvas', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
});

// Initialize audio on page load
initAudio();

console.log('Student ready for room:', roomId);