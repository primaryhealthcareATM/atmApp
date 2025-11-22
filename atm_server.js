    const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const mongoose = require("mongoose");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const { RtcTokenBuilder, RtcRole } = require("agora-token");
const Razorpay = require("razorpay");
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
const tabletSchema = new mongoose.Schema({
    'search': { type: String },
    marketer: { type: String },
    salt_composition: { type: String },
    introduction: { type: String },
    benefits: { type: String },
    description: { type: String },
    how_to_use: { type: String },
    safety_advise: { type: String },
    mrp: { type: Number }
});


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

// --------------------- RAZORPAY INIT (NO CHANGE TO REST OF CODE) ---------------------
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// --------------------- ADD NEW ENDPOINT HERE ---------------------
app.post("/create-payment", async (req, res) => {
    try {
        const { amount, name, description, upi_id } = req.body;

        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: "Valid amount is required" });
        }
        const randomReceipt = "rcpt_" + uuidv4();  // Add this line
        const qrData = {
              type: "upi_qr",   // not UPI QR
              usage: "single_use",
              fixed_amount: true,
              payment_amount: amount * 100,
              description: description || "Payment",
              notes: { receipt: randomReceipt }
        };

        if (name) qrData.name = name;
        if (upi_id) qrData.vpa = upi_id; // optional pre-fill UPI ID

        const qr = await razorpay.qrCode.create(qrData);

        res.json({
            success: true,
            qr_url: qr.image_url,
            qr_id: qr.id
        });

    } catch (error) {
        console.error("🔥 Razorpay QR Error:", error);
        res.status(500).json({
            error: "Payment QR failed",
            details: error.error || error.toString()
        });
    }
});

// ----------------- CHECK PAYMENT STATUS -----------------
app.get("/payment-status/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const payment = await razorpay.paymentLink.fetch(id);
        return res.status(200).json({
            success: true,
            status: payment.status // "paid", "pending", "cancelled"
        });
    } catch (err) {
        console.error("🔥 Error checking payment:", err);
        return res.status(500).json({ error: "Failed to fetch payment status", details: err.toString() });
    }
});

// API Endpoints
app.get('/', (req, res) => res.send('🚀 Server is running!'));

app.post('/tablets', async (req, res) => {
    const { name } = req.body;
    console.log(name);
    
    if (!name) return res.status(400).json({ error: "Tablet name is required" });
    
    let tabList = name.split(/[\n\s]+/);
    console.log('tabList: ', tabList);

    try {
        let tablet;
        for (let word of tabList) {
            console.log('word: ', word.trim());

            // Query the tablet collection using $or to match either 'Product Name' or 'salt_composition'
            tablet = await mongoose.connection.db.collection('tablet_collection').findOne({
                $or: [
                    { 'Search': word.trim() }, // match Product Name exactly
                    { 'salt_composition': word.trim() } // match salt_composition (case insensitive)
                ]
            });

            if (tablet) break; // Break once a match is found
        }

        console.log('tablet: ', tablet);
        if (!tablet) {
            return res.status(404).json({ error: "Tablet not found" });
        }

        // Respond with tablet details
        res.json(tablet);
    } catch (error) {
        console.error("Error fetching tablet data:", error);
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

    pendingRequests[requestId] = { doctors, currentIndex: 0, channelName, token, userID, timer: null, attemptCount: 0 };
    sendCallNotification(requestId);

    res.status(200).json({ success: true, requestId, channelName, token });
});

async function sendCallNotification(requestId) {
    if (!requestId || !(requestId in pendingRequests)) return;

    const request = pendingRequests[requestId];

    // Filter out doctors without valid FCM tokens
    request.doctors = request.doctors.filter(doc => !!doc.fcmToken);

    if (request.doctors.length === 0) {
        console.log("❌ No doctors with valid FCM tokens, stopping notifications.");
        delete pendingRequests[requestId];
        return;
    }

    // Ensure currentIndex is within bounds after filtering
    if (request.currentIndex >= request.doctors.length) {
        request.currentIndex = 0;
    }

    const doctor = request.doctors[request.currentIndex];
    console.log(`📩 Sending call notification to ${doctor.name}`);

    const message = {
        token: doctor.fcmToken,
        notification: { title: "Doctor Request", body: "A user is requesting a doctor consultation." },
        data: {
            click_action: "FLUTTER_NOTIFICATION_CLICK",
            type: "call",
            requestId,
            channelName: request.channelName,
            token: request.token,
            user: request.userID
        }
    };

    try {
        await admin.messaging().send(message);
        console.log(`✅ Notification sent to ${doctor.name}`);

        // Set timeout to wait for response (30 seconds)
        request.timer = setTimeout(() => {
            console.log(`⏳ No response from ${doctor.name}, moving to next doctor.`);

            request.currentIndex = (request.currentIndex + 1) % request.doctors.length;

            // If all doctors have been tried twice
            if (request.currentIndex === 0) {
                request.attemptCount++;
                if (request.attemptCount >= 2) {
                    console.log("❌ All doctors have been notified twice, stopping notifications.");
                    delete pendingRequests[requestId];
                    return;
                } else {
                    console.log("🔄 Restarting notification cycle from first doctor.");
                    sendCallNotification(requestId);
                }
            } else {
                sendCallNotification(requestId);
            }
        }, 30000);

    } catch (error) {
        console.error(`⚠️ Failed to send notification to ${doctor.name}:`, error);

        if (error.code === 'messaging/registration-token-not-registered') {
            // Delete invalid token from Firestore
            await admin.firestore().collection('Doctor').doc(doctor.id).update({ fcmToken: admin.firestore.FieldValue.delete() });

            // Remove doctor from the current list to avoid retrying immediately
            request.doctors = request.doctors.filter(d => d.id !== doctor.id);

            // Adjust currentIndex if needed
            if (request.currentIndex >= request.doctors.length) {
                request.currentIndex = 0;
            }

            if (request.doctors.length === 0) {
                console.log("❌ No doctors left to notify, stopping notifications.");
                delete pendingRequests[requestId];
                return;
            }
        }

        // Try next doctor
        request.currentIndex = (request.currentIndex + 1) % request.doctors.length;
        sendCallNotification(requestId);
    }
}


// In your /respond-call endpoint, make sure to resolve the request
app.post("/respond-call", async (req, res) => {
    const { requestId, accepted } = req.body;
    if (!requestId || !(requestId in pendingRequests)) return res.status(400).json({ error: "Invalid request ID" });

    const request = pendingRequests[requestId];
    if (accepted) {
        console.log("✅ Doctor accepted the call!");
        clearTimeout(request.timer);
        delete pendingRequests[requestId];  // Remove the request after it's accepted
    } else {
        console.log("❌ Doctor declined the call. Trying next...");
        clearTimeout(request.timer);
        request.currentIndex = (request.currentIndex + 1) % request.doctors.length; // Move to the next doctor
        sendCallNotification(requestId); // Continue with the next doctor
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



const PORT = process.env.PORT;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));







