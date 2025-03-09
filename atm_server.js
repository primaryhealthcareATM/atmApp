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
        0, // UID 0 for any user
        role,
        privilegeExpiredTs
    );
}

const app = express();
app.use(bodyParser.json());

let pendingRequests = {}; // Track pending doctor calls

async function getDoctorsByLanguage(lang) {
    try {
        const doctors = [];
        const querySnapshot = await admin.firestore().collection('Doctor')
            .where('language', '==', lang)
            .get();

        querySnapshot.forEach(doc => {
            const doctorData = doc.data();
            if (doctorData.isActive && doctorData.fcmToken) { // Ensure active & valid token
                doctors.push({
                    id: doc.id,
                    name: doctorData.name,
                    fcmToken: doctorData.fcmToken,
                });
            }
        });

        return doctors;
    } catch (error) {
        console.error("🔥 Error fetching doctors:", error);
        return [];
    }
}

app.get("/request-doctor", (req, res) => {
    res.send("hoiiii");
});

app.post("/request-doctor", async (req, res) => {
    const { language,userID} = req.body;
    
    if (!language) {
        return res.status(400).json({ error: "Language is required" });
    }
    if (!userID) {
        return res.status(400).json({ error: "IserID is required" });
    }
    const doctors = await getDoctorsByLanguage(language);

    if (doctors.length === 0) {
        return res.status(404).json({ error: "No doctors available" });
    }

    const channelName = `channel_${uuidv4()}`;
    const token = generateAgoraToken(channelName);
    const requestId = uuidv4();
    pendingRequests[requestId] = { doctors, currentIndex: 0, channelName, token, userID,timer: null };

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
        "notification": {
        "title": "Doctor Request",
        "body": "A user is requesting a doctor consultation."
      },
        data: {
            click_action: "FLUTTER_NOTIFICATION_CLICK"
            type: "call",
            requestId: requestId,
            callerName: "Patient Request",
            channelName: request.channelName,
            token: request.token,
            user: request.userID
        }
    };

    try {
        await admin.messaging().send(message);
        console.log(`✅ Notification sent to ${doctor.name}`);

        // 🔹 Start a 30-second timer for response
        request.timer = setTimeout(() => {
            console.log(`⏳ No response from ${doctor.name}, moving to next doctor.`);
            request.currentIndex++; // Move to next doctor
            sendCallNotification(requestId); // Try next doctor
        }, 30000); // 30 seconds
    } catch (error) {
        console.error(`⚠️ Failed to send notification to ${doctor.name}:`, error);

        if (error.code === 'messaging/registration-token-not-registered') {
            console.log(`🗑 Removing invalid FCM token for ${doctor.name}`);

            // Remove token from Firestore
            await admin.firestore().collection('Doctor').doc(doctor.id).update({
                fcmToken: admin.firestore.FieldValue.delete()
            });
        request.currentIndex++; // Move to next doctor
        sendCallNotification(requestId); // Try next doctor
    }
}
}
// API to handle doctor's response
app.post("/respond-call", async (req, res) => {
    const { requestId, accepted } = req.body;

    if (!requestId || !(requestId in pendingRequests)) {
        return res.status(400).json({ error: "Invalid request ID" });
    }

    const request = pendingRequests[requestId];

    if (accepted === true) {
        console.log("✅ Doctor accepted the call!");
        
        // ✅ Stop the timeout since a doctor accepted
        clearTimeout(request.timer);

        delete pendingRequests[requestId]; // Stop notifications
    } else {
        console.log("❌ Doctor declined the call. Trying next...");
        request.currentIndex++;
        sendCallNotification(requestId); // Notify next doctor
    }

    res.status(200).json({ success: true });
});

app.post("/update-fcm-token", async (req, res) => {
    const { doctorId, fcmToken,who } = req.body;

    if (!doctorId || !fcmToken) {
        return res.status(400).json({ error: "doctorId and fcmToken are required" });
    }

    try {
        await admin.firestore().collection(who).doc(doctorId).update({
            fcmToken: fcmToken,
        });

        console.log(`✅ FCM token updated for Doctor ID: ${doctorId}`);
        res.status(200).json({ success: true, message: "FCM token updated successfully" });
    } catch (error) {
        console.error("🔥 Error updating FCM token:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});


// ✅ Fix: Ensure the server binds to a proper port
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
