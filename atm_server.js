const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const { RtcTokenBuilder, RtcRole } = require("agora-token");

if (!process.env.FIREBASE_CREDENTIALS) {
    throw new Error("FIREBASE_CREDENTIALS environment variable is not set");
}

admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENTIALS)),
});

const APP_ID = "009118564c524e0aa0c2ffb6a7c7d857";
const APP_CERTIFICATE = "362d15d43eaa4e80b29da557853825cd";

function generateAgoraToken(channelName) {
    const role = RtcRole.PUBLISHER;
    const expirationTimeInSeconds = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    return RtcTokenBuilder.buildTokenWithUid(
        APP_ID,
        APP_CERTIFICATE,
        channelName,
        0,  // UID 0 for any user
        role,
        privilegeExpiredTs
    );
}

const app = express();
app.use(bodyParser.json());

let pendingRequests = {}; // To track doctor responses
async function getDoctorsByLanguage(lang) {
    const doctors = [];
    try {
        const querySnapshot = await admin.firestore().collection('Doctor')
            .where('language', '==', lang)
            .get();

        querySnapshot.forEach(doc => {
            doctors.push({
                id: doc.id,
                name: doc.data().name,
                fcmToken: doc.data().fcmToken,
                isActive: doc.isActive || false
            });
        });

        return doctors;
    } catch (error) {
        console.error("Error fetching doctors:", error);
        return [];
    }
}


app.post("/request-doctor", async (req, res) => {
    const { language } = req.body;
    console.log("hoiii");
    if (!language) {
        return res.status(400).json({ error: "Language is required" });
    }

    const doctors = await getDoctorsByLanguage(language);

    if (doctors.length === 0) {
        return res.status(404).json({ error: "No doctors available" });
    }

    // Generate a new unique channel name
    const channelName = `channel_${uuidv4()}`;
    
    // Generate Agora Token
    const token = generateAgoraToken(channelName);

    const requestId = uuidv4();
    pendingRequests[requestId] = { doctors, currentIndex: 0, channelName, token };

    sendCallNotification(requestId,channelName,token);
    
    // Send channel name and token in the response
    res.status(200).json({ success: true, requestId, channelName, token });
});

async function sendCallNotification(requestId,channelName,token) {
    const request = pendingRequests[requestId];

    if (!request || request.currentIndex >= request.doctors.length) {
        console.log("❌ No more doctors available");
        delete pendingRequests[requestId];
        return;
    }
    
    const doctor = request.doctors[request.currentIndex];
    if(!doctor.isActive)
    {
        request.currentIndex++;
        sendCallNotification(requestId, channelName, token);
        return;
    }
    console.log(`📩 Sending notification to ${doctor.name}`);

    const message = {
        token: doctor.fcmToken,
        data: {
            type: "call",
            requestId: requestId,
            callerName: requestId,
            channelName: channelName,
            token: token
        }
    };

    try {
        await admin.messaging().send(message);
    } catch (error) {
        console.error("Error sending notification:", error);
        request.currentIndex++;
        sendCallNotification(requestId,channelName,token); // Try next doctor
    }
}

// API to handle doctor's response
app.post("/respond-call", async (req, res) => {
    const { requestId, accepted } = req.body;
    if (!requestId || !(requestId in pendingRequests)) {
        return res.status(400).json({ error: "Invalid request ID" });
    }

    if (accepted=="true") {
        console.log("✅ Doctor accepted the call!");
        delete pendingRequests[requestId]; // Stop trying other doctors
    } else {
        console.log("❌ Doctor declined the call. Trying next...");
        pendingRequests[requestId].currentIndex++;
        sendCallNotification(requestId,channelName); // Notify next doctor
    }

    res.status(200).json({ success: true });
});

// Start server
app.listen(3000, () => {
    console.log("🚀 Server running on port 3000");
});
