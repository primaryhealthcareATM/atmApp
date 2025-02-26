const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");

if (!process.env.FIREBASE_CREDENTIALS) {
    throw new Error("FIREBASE_CREDENTIALS environment variable is not set");
}
console.log("hoiii "+require("./healthcareatm-f7f33-firebase-adminsdk-fbsvc-0649e2ea20.json"));
admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS, "base64").toString("utf8"))),
});

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
                fcmToken: doc.data().fcmToken
            });
        });

        return doctors;
    } catch (error) {
        console.error("Error fetching doctors:", error);
        return [];
    }
}

// API to request a doctor
app.post("/request-doctor", async (req, res) => {
    const { language ,channelName} = req.body;

    if (!language) {
        return res.status(400).json({ error: "Language is required" });
    }

    const doctors = await getDoctorsByLanguage(language);

    if (doctors.length === 0) {
        return res.status(404).json({ error: "No doctors available" });
    }

    const requestId = uuidv4();
    pendingRequests[requestId] = { doctors, currentIndex: 0 };

    sendCallNotification(requestId,channelName);
    res.status(200).json({ success: true, requestId });
});

async function sendCallNotification(requestId,channelName) {
    const request = pendingRequests[requestId];

    if (!request || request.currentIndex >= request.doctors.length) {
        console.log("❌ No more doctors available");
        delete pendingRequests[requestId];
        return;
    }

    const doctor = request.doctors[request.currentIndex];
    console.log(`📩 Sending notification to ${doctor.name}`);

    const message = {
        token: doctor.fcmToken,
        data: {
            type: "call",
            requestId: requestId,
            callerName: requestId,
            channelName: "HeAlThCaReAtM"
        }
    };

    try {
        await admin.messaging().send(message);
    } catch (error) {
        console.error("Error sending notification:", error);
        request.currentIndex++;
        sendCallNotification(requestId,channelName); // Try next doctor
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
