const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const mongoose = require("mongoose");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const { RtcTokenBuilder, RtcRole } = require("agora-token");

// Initialize Express App
const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// MongoDB Connection
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch((error) => {
        console.error("❌ MongoDB Connection Error:", error);
        process.exit(1);
    });

// Define MongoDB Model for Tablets
const tabletSchema = new mongoose.Schema({ name: String, purpose: String, ageLimit: Number });
const Tablet = mongoose.model("Tablet", tabletSchema);

// Firebase Initialization
if (!process.env.FIREBASE_CREDENTIALS) {
    throw new Error("FIREBASE_CREDENTIALS environment variable is not set");
}

admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENTIALS)),
});
console.log("✅ Firebase Admin Initialized");

// Agora Configuration
const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

function generateAgoraToken(channelName) {
    const expirationTimeInSeconds = 3600; // 1 hour
    const privilegeExpiredTs = Math.floor(Date.now() / 1000) + expirationTimeInSeconds;
    return RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERTIFICATE, channelName, 0, RtcRole.PUBLISHER, privilegeExpiredTs);
}

// Pending Doctor Requests
let pendingRequests = {};

// Fetch Available Doctors
async function getDoctorsByLanguage(lang) {
    try {
        const doctors = [];
        const querySnapshot = await admin.firestore().collection('Doctor').where('language', '==', lang).get();
        querySnapshot.forEach(doc => {
            const data = doc.data();
            if (data.isActive && data.fcmToken) {
                doctors.push({ id: doc.id, name: data.name, fcmToken: data.fcmToken });
            }
        });
        return doctors;
    } catch (error) {
        console.error("🔥 Error fetching doctors:", error);
        return [];
    }
}

// API Endpoints
app.get('/', (req, res) => res.send('🚀 Server is running!'));

app.post('/api/tablets', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Tablet name is required" });

    try {
        const tablet = await Tablet.findOne({ name: name });
        if (!tablet) return res.status(404).json({ error: "Tablet not found" });

        res.json({
            name: tablet.name,
            usage: tablet.purpose,  // Assuming "purpose" is the usage
            ageLimit: tablet.ageLimit
        });
    } catch (error) {
        res.status(500).json({ message: "Error fetching tablet data", error });
    }
});

app.post("/request-doctor", async (req, res) => {
    const { language, userID } = req.body;
    if (!language || !userID) return res.status(400).json({ error: "Language and userID are required" });

    const doctors = await getDoctorsByLanguage(language);
    if (doctors.length === 0) return res.status(404).json({ error: "No doctors available" });

    const channelName = `channel_${uuidv4()}`;
    const token = generateAgoraToken(channelName);
    const requestId = uuidv4();

    pendingRequests[requestId] = { doctors, currentIndex: 0, channelName, token, userID, timer: null };
    sendCallNotification(requestId);

    res.status(200).json({ success: true, requestId, channelName, token });
});

async function sendCallNotification(requestId) {
    const request = pendingRequests[requestId];
    if (!request || request.currentIndex >= request.doctors.length) {
        console.log("❌ No available doctors, stopping notifications.");
        delete pendingRequests[requestId];
        return;
    }
    
    const doctor = request.doctors[request.currentIndex];
    console.log(`📩 Sending call notification to ${doctor.name}`);
    
    const message = {
        token: doctor.fcmToken,
        notification: { title: "Doctor Request", body: "A user is requesting a doctor consultation." },
        data: { click_action: "FLUTTER_NOTIFICATION_CLICK", type: "call", requestId, channelName: request.channelName, token: request.token, user: request.userID }
    };
    
    try {
        await admin.messaging().send(message);
        console.log(`✅ Notification sent to ${doctor.name}`);
        request.timer = setTimeout(() => {
            console.log(`⏳ No response from ${doctor.name}, moving to next doctor.`);
            request.currentIndex++;
            sendCallNotification(requestId);
        }, 30000);
    } catch (error) {
        console.error(`⚠️ Failed to send notification to ${doctor.name}:`, error);
        if (error.code === 'messaging/registration-token-not-registered') {
            await admin.firestore().collection('Doctor').doc(doctor.id).update({ fcmToken: admin.firestore.FieldValue.delete() });
        }
        request.currentIndex++;
        sendCallNotification(requestId);
    }
}

app.post("/respond-call", async (req, res) => {
    const { requestId, accepted } = req.body;
    if (!requestId || !(requestId in pendingRequests)) return res.status(400).json({ error: "Invalid request ID" });
    
    const request = pendingRequests[requestId];
    if (accepted) {
        console.log("✅ Doctor accepted the call!");
        clearTimeout(request.timer);
        delete pendingRequests[requestId];
    } else {
        console.log("❌ Doctor declined the call. Trying next...");
        request.currentIndex++;
        sendCallNotification(requestId);
    }
    res.status(200).json({ success: true });
});

const PORT = process.env.PORT;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
