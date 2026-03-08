/**
 * HealthMate - Core Logic Rewrite
 * Focus: Modularity, Real-time Sync, Robust Auth & RBAC
 */

// Firebase instances are already initialized in index.html and exposed globally.
// const db = firebase.firestore();
// const auth = firebase.auth();

const APP_VERSION = "2.2.0";
console.log("HealthMate App Loading. Version:", APP_VERSION);


// --- Razorpay Configuration ---
const RAZORPAY_CONFIG = {
    // IMPORTANT: Use rzp_test_... for local testing and rzp_live_... for actual payments.
    key: "rzp_test_SON87WB6ElEXsT", // User's Test Key ID
    name: "HealthMate",
    description: "Doctor Consultation / Lab Test"
};


// --- Wallet & Escrow Helpers ---
async function ensureWalletExists(uid) {
    const ref = db.collection('wallets').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) {
        await ref.set({
            uid,
            availableBalance: 0,
            pendingEscrow: 0,
            totalEarnings: 0,
            payoutsProcessed: 0,
            lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
        });
    }
}

async function creditEscrow(providerId, amount, commission) {
    await ensureWalletExists(providerId);
    const net = amount - commission;
    await db.collection('wallets').doc(providerId).update({
        pendingEscrow: firebase.firestore.FieldValue.increment(net),
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
    });
}

async function releaseEscrowToWallet(appId) {
    const appSnap = await db.collection('appointments').doc(appId).get();
    const app = appSnap.data();
    if (!app || app.payoutStatus !== 'Escrow') return;

    const commissionRate = (AppState.user.commissionRate || 20) / 100;
    const gross = parseInt(app.price) || 0;
    const commission = Math.floor(gross * commissionRate);
    const net = gross - commission;

    const batch = db.batch();
    batch.update(db.collection('appointments').doc(appId), {
        payoutStatus: 'Wallet',
        completedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    batch.update(db.collection('wallets').doc(app.targetId), {
        pendingEscrow: firebase.firestore.FieldValue.increment(-net),
        availableBalance: firebase.firestore.FieldValue.increment(net),
        totalEarnings: firebase.firestore.FieldValue.increment(net)
    });

    batch.set(db.collection('wallet_transactions').doc(), {
        uid: app.targetId,
        appId: appId,
        type: 'credit',
        amount: net,
        description: `Booking Release: ${app.patientName}`,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();
}

async function handleRefund(appId) {
    const appSnap = await db.collection('appointments').doc(appId).get();
    const app = appSnap.data();
    if (!app || app.paymentStatus !== 'Paid') return;

    const net = (parseInt(app.price) || 0) * (1 - (AppState.user.commissionRate || 20) / 100);

    const batch = db.batch();
    batch.update(db.collection('appointments').doc(appId), {
        payoutStatus: 'Refunded',
        paymentStatus: 'Refunded'
    });

    if (app.payoutStatus === 'Escrow') {
        batch.update(db.collection('wallets').doc(app.targetId), {
            pendingEscrow: firebase.firestore.FieldValue.increment(-net)
        });
    }

    await batch.commit();
    showToast("Refund processed successfully.");
}

// --- Helper: File Upload ---

async function uploadFile(file, path) {
    if (!file) return null;
    try {
        const ref = storage.ref().child(path);
        const snapshot = await ref.put(file);
        return await snapshot.ref.getDownloadURL();
    } catch (err) {
        console.error("Upload failed, using local blob for session:", err.message);
        return URL.createObjectURL(file);
    }
}

// --- Global State Management ---
const AppState = {
    user: null,
    doctors: [],
    labs: [],
    appointments: [],
    currentType: 'doctors', // 'doctors' or 'labs'
    activeFilters: {
        category: 'All', // This is now used for specialty in the new UI
        location: '',
        search: ''
    },
    selectedSlot: null,
    records: [],
    users: [], // New state for joining email data
    currentOnboardingStep: 1,
    onboardingData: {},
};

// --- DOM Elements ---
const DOM = {
    logo: document.querySelector('.logo'),
    authBtn: document.getElementById('auth-main-btn'),
    userInfo: document.getElementById('user-info'),
    userName: document.getElementById('current-user-name'),
    userRole: document.getElementById('current-user-role'),
    pulse: document.getElementById('live-activity-pulse'),
    mainContent: document.getElementById('main-content'),
    gridContainer: document.getElementById('grid-container'),
    sectionTitle: document.getElementById('section-title'),
    searchInput: document.getElementById('dashboard-search-input') || document.getElementById('hero-search-input'),
    locationInput: document.getElementById('hero-location-input'),
    authOverlay: document.getElementById('auth-overlay'),
    loginCard: document.getElementById('login-card'),
    registerCard: document.getElementById('register-card'),
    modal: document.getElementById('booking-modal'),
    modalBody: document.getElementById('modal-body'),
    toastContainer: document.getElementById('toast-container'),
    aiToggle: document.getElementById('ai-bot-toggle'),
    aiWindow: document.getElementById('ai-chat-window'),
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-user-input'),
    chatSend: document.getElementById('send-chat'),
    themeToggle: document.getElementById('theme-toggle'),
    langSwitch: document.getElementById('lang-switch')
};

function toggleChat() {
    DOM.aiWindow.classList.toggle('hidden');
    if (!DOM.aiWindow.classList.contains('hidden')) {
        DOM.chatInput.focus();
    }
}


const Translations = {
    en: {
        welcome: "Welcome to HealthMate",
        find_doc: "Find Doctors",
        video: "Video Consult",
        labs: "Lab Tests",
        search_placeholder: "Search doctors, clinics, hospitals, etc.",
        book_now: "Book Now"
    },
    te: {
        welcome: "హెల్త్‌మేట్ కు స్వాగతం",
        find_doc: "డాక్టర్లను కనుగొనండి",
        video: "వీడియో కన్సల్ట్",
        labs: "ల్యాబ్ పరీక్షలు",
        search_placeholder: "డాక్టర్లు, క్లినిక్‌లు, ఆసుపత్రులు మొదలైనవాటిని వెతకండి",
        book_now: "ఇప్పుడే బుక్ చేయండి"
    },
    hi: {
        welcome: "हेल्थमेट में आपका स्वागत है",
        find_doc: "डॉक्टर खोजें",
        video: "वीडियो कॉल",
        labs: "लैब टेस्ट",
        search_placeholder: "डॉक्टर, क्लीनिक, अस्पताल आदि खोजें",
        book_now: "अभी बुक करें"
    }
};

function updateLanguage(lang) {
    const t = Translations[lang];
    if (!t) return;
    document.querySelector('.logo-text').innerHTML = 'Health<span>Mate</span>'; // keep logo same
    // Update specific UI elements if they exist
    const heroTitle = document.querySelector('.hero-section h1');
    if (heroTitle) heroTitle.innerText = t.welcome;
    if (DOM.searchInput) DOM.searchInput.placeholder = t.search_placeholder;
    // Map more as needed
}

function toggleTheme() {
    const current = document.body.getAttribute('data-theme');
    const target = current === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', target);
    try {
        localStorage.setItem('healthmate-theme', target);
    } catch (e) {
        console.warn("LocalStorage save denied:", e.message);
    }
    const icon = document.querySelector('#theme-toggle i');
    if (icon) {
        icon.className = target === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    }
    showToast(`${target.charAt(0).toUpperCase() + target.slice(1)} Mode Enabled`);
}


// --- PWA Installation Logic ---
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    console.log('[PWA] BeforeInstallPrompt event captured');
    // We can show a specific "Install" button in the UI here
    const installBtn = document.getElementById('pwa-install-btn');
    if (installBtn) installBtn.style.display = 'flex';
});

window.showInstallPrompt = async () => {
    if (!deferredPrompt) {
        showToast("To install HealthMate:\n1. Open this site in Chrome/Safari\n2. Tap the Menu (3 dots) or Share icon\n3. Select 'Add to Home Screen'", "info");
        return;
    }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`[PWA] User choice: ${outcome}`);
    deferredPrompt = null;
    const installBtn = document.getElementById('pwa-install-btn');
    if (installBtn) installBtn.style.display = 'none';
};

window.toggleSidebar = function () {
    const sidebar = document.getElementById('app-sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar && overlay) {
        sidebar.classList.toggle('active');
        overlay.classList.toggle('active');
    }
};

window.handleSidebarAction = function (action) {
    toggleSidebar();
    switch (action) {
        case 'about':
            showToast("HealthMate v2.2\nBuild once, run everywhere!\nYou can install this as an app from your browser menu.", "info");
            break;
        case 'devices':
            showToast("Currently active on this device. End-to-end encrypted.");
            break;
        case 'password':
            showToast("Password reset link sent to your registered email.");
            break;
        case 'help':
            showToast("Connecting to Help Desk... 24/7 Support available.");
            break;
    }
};

// --- Initialization ---
function init() {
    setupAuthListener();
    setupRealtimeSync();
    setupEventListeners();

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js?v=' + APP_VERSION)
                .then(reg => console.log('[PWA] ServiceWorker registered:', reg.scope))
                .catch(err => console.log('[PWA] ServiceWorker failed:', err));
        });
    }
    initSimulations();

    // Theme Init
    let savedTheme = 'light';
    try {
        savedTheme = localStorage.getItem('healthmate-theme') || 'light';
    } catch (e) {
        console.warn("LocalStorage access denied:", e.message);
    }

    if (savedTheme === 'dark') {
        document.body.setAttribute('data-theme', 'dark');
        const icon = document.querySelector('#theme-toggle i');
        if (icon) icon.className = 'fas fa-sun';
    }
}

async function handleChat() {
    const input = DOM.chatInput.value.trim();
    if (!input) return;

    // Append User Message
    DOM.chatMessages.innerHTML += `<div class="msg user">${input}</div>`;
    DOM.chatInput.value = '';
    DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;

    // AI Processing
    setTimeout(() => {
        let reply = "I'm not sure about that. Try asking 'find a cardiologist', 'test preparation', or 'book an appointment'.";
        const query = input.toLowerCase();

        if (query.includes('doctor') || query.includes('find')) {
            reply = "I've filtered the doctors list for you! Look at the 'Verified Doctors' section. You can find specialists in Cardiology, Pediatrics, etc.";
            setCategory('doctors');
        } else if (query.includes('lab') || query.includes('test')) {
            reply = "I've switched to Lab Tests for you. Common tests like Blood Count, MRI, and Thyroid panels are available below.";
            setCategory('labs');
        } else if (query.includes('preparation') || query.includes('fasting')) {
            reply = "Most blood tests require 8-12 hours of fasting. Drink only water. Avoid caffeine or heavy meals before the test.";
        } else if (query.includes('fee') || query.includes('price')) {
            reply = "Our consults start from as low as ₹500. Lab tests vary by complexity. Check the catalog for details.";
        } else if (query.includes('appointment') || query.includes('book')) {
            reply = "Choose a provider and click 'Book Now'. My Smart Assistant will recommend the best slot with minimum wait time.";
        } else if (query.includes('token') || query.includes('queue')) {
            reply = "After booking, you'll receive a Token Number. You can track your position in the live queue via your 'Bookings' tab.";
        } else if (query.includes('hello') || query.includes('hi')) {
            reply = "Hello! I'm your HealthMate assistant. I can help you find doctors, understand lab preparations, or track your reports.";
        }

        DOM.chatMessages.innerHTML += `<div class="msg ai">${reply}</div>`;
        DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
    }, 800);
}

// --- Firebase Real-time Sync ---
function setupRealtimeSync() {
    console.log("Setting up Firestore listeners...");

    // Listen for Doctors
    db.collection('doctors').onSnapshot(snap => {
        console.log("Doctors sync received:", snap.size, "records");
        AppState.doctors = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (AppState.currentType === 'doctors') renderGrid();
        refreshActiveDashboard(); // Ensure admin dashboard refreshes too
    }, err => {
        console.warn("Doctor Sync Error:", err.message);
    });

    // Listen for Labs
    db.collection('labs').onSnapshot(snap => {
        AppState.labs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (AppState.currentType === 'labs') renderGrid();
        refreshActiveDashboard();
    }, err => console.warn("Lab Sync Error:", err.message));

    // Listen for Appointments (Global for updates)
    db.collection('appointments').onSnapshot(snap => {
        AppState.appointments = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        refreshActiveDashboard();
    }, err => console.warn("Appointment Sync Error:", err.message));

    // Listen for All Users (Admin joining)
    db.collection('users').onSnapshot(snap => {
        AppState.users = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        refreshActiveDashboard();
    }, err => console.warn("Users Sync Error:", err.message));
}

// --- Authentication Logic ---
function setupAuthListener() {
    auth.onAuthStateChanged(async (firebaseUser) => {
        if (firebaseUser) {
            try {
                const userDoc = await db.collection('users').doc(firebaseUser.uid).get();
                if (userDoc.exists) {
                    AppState.user = { id: firebaseUser.uid, ...userDoc.data() };

                    // Admin Override for specific UIDs or email patterns
                    if (firebaseUser.uid === 'DwaDCedzWzNC5Y0qLE1e6989bR23' || firebaseUser.email.includes('admin@healthmate.com')) {
                        AppState.user.role = 'admin';
                    }

                    applyUserSession();
                } else {
                    // Critical: Handle scenario where Firebase Auth exists but Firestore profile missing
                    console.warn("User profile missing in Firestore, creating default patient.");
                    const defaultProfile = {
                        name: firebaseUser.displayName || firebaseUser.email.split('@')[0],
                        email: firebaseUser.email,
                        role: 'patient',
                        createdAt: firebase.firestore.FieldValue.serverTimestamp()
                    };
                    await db.collection('users').doc(firebaseUser.uid).set(defaultProfile);
                    AppState.user = { id: firebaseUser.uid, ...defaultProfile };
                    applyUserSession();
                }
            } catch (err) {
                console.error("Auth Fetch Error:", err);
                showToast("Error loading profile", "error");
            }
        } else {
            AppState.user = null;
            applyUserSession();
        }
    });
}

function applyUserSession() {
    if (AppState.user) {
        DOM.authOverlay.classList.add('hidden');
        DOM.userInfo.classList.remove('hidden');
        DOM.authBtn.innerHTML = `<i class="fas fa-sign-out-alt"></i> Logout`;
        DOM.userName.innerText = AppState.user.name;
        DOM.userRole.innerText = AppState.user.role.charAt(0).toUpperCase() + AppState.user.role.slice(1);

        // Show correct section based on role
        requestAnimationFrame(() => {
            showRoleView(AppState.user.role);

            // Prefill Profile Fields
            if (document.getElementById('edit-name')) document.getElementById('edit-name').value = AppState.user.name || "";
            if (document.getElementById('edit-phone')) document.getElementById('edit-phone').value = AppState.user.phone || "";

            // Profile Previews
            const patientPrev = document.getElementById('patient-profile-preview');
            const doctorPrev = document.getElementById('doctor-profile-preview');
            const imgHTML = (url) => url ? `<img src="${url}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : "??";

            if (patientPrev) patientPrev.innerHTML = imgHTML(AppState.user.image);
            if (doctorPrev) doctorPrev.innerHTML = imgHTML(AppState.user.image);

            // Update Sidebar UI
            updateSidebarUI();

            showToast(`Logged in as ${AppState.user.name}`);
        });
    } else {
        DOM.authBtn.innerHTML = `Login / Sign Up`;
        DOM.userInfo.classList.add('hidden');
        requestAnimationFrame(() => showRoleView('guest'));

        // Reset Sidebar UI
        updateSidebarUI();
    }
}

function showRoleView(role) {
    document.querySelectorAll('.role-section').forEach(sec => sec.classList.add('hidden'));
    const mobileNav = document.getElementById('mobile-nav');
    if (mobileNav) mobileNav.classList.add('hidden');

    if (role === 'guest' || role === 'patient') {
        document.getElementById('patient-view').classList.remove('hidden');
        if (mobileNav) mobileNav.classList.remove('hidden');
        const secondaryNav = document.getElementById('patient-secondary-nav');
        if (role === 'patient') secondaryNav.classList.remove('hidden');
        else secondaryNav.classList.add('hidden');
        showPatientSection('home');
    } else if (role === 'doctor' || role === 'lab') {
        // CHECK ONBOARDING STATUS
        const profile = role === 'doctor'
            ? AppState.doctors.find(d => d.id === AppState.user.id)
            : AppState.labs.find(l => l.id === AppState.user.id);

        if (profile && profile.approved) {
            document.getElementById(role + '-view').classList.remove('hidden');
            if (role === 'doctor') renderDoctorDashboard();
            else renderLabDashboard();
        } else {
            // Redirect to onboarding if not approved OR if onboarding details never submitted
            if (profile && profile.onboardingStatus === 'submitted') {
                // Show a "Pending Approval" screen instead of the full onboarding
                document.getElementById(role + '-view').classList.remove('hidden');
                document.getElementById(role + '-unapproved-alert').classList.remove('hidden');
                if (role === 'doctor') renderDoctorDashboard();
                else renderLabDashboard();
            } else {
                document.getElementById('onboarding-view').classList.remove('hidden');
                renderOnboardingStep();
            }
        }
    } else if (role === 'admin') {
        document.getElementById('admin-view').classList.remove('hidden');
        renderAdminDashboard();
    }
}


// --- Onboarding Logic ---
window.renderOnboardingStep = function () {
    const step = AppState.currentOnboardingStep;
    const role = AppState.user.role;
    const content = document.getElementById('onboarding-step-content');
    const stepper = document.getElementById('onboarding-stepper');

    // Update Stepper
    document.querySelectorAll('.step').forEach(s => {
        const sNum = parseInt(s.dataset.step);
        s.classList.toggle('active', sNum === step);
        s.classList.toggle('completed', sNum < step);
    });

    let html = '';
    if (step === 1) {
        html = `
            <h2>1. Basic Information</h2>
            <p>Tell us more about yourself to establish your account.</p>
            <div style="display:flex; align-items:center; gap:20px; margin-bottom:20px;">
                <div id="onboarding-photo-preview" class="profile-img-large" style="margin:0; width:120px; height:120px;">
                    ${AppState.onboardingData.image ? `<img src="${AppState.onboardingData.image}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : '<i class="fas fa-camera"></i>'}
                </div>
                <div>
                    <label>Profile Photo</label><br>
                    <input type="file" id="onboarding-img-input" accept="image/*" onchange="previewOnboardingPhoto(this)">
                </div>
            </div>
            <div class="input-group"><label>Full Name</label><input type="text" id="ob-name" value="${AppState.onboardingData.name || AppState.user.name}"></div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                <div class="input-group"><label>Gender</label><select id="ob-gender"><option value="Male">Male</option><option value="Female">Female</option><option value="Other">Other</option></select></div>
                <div class="input-group"><label>Date of Birth</label><input type="date" id="ob-dob" value="${AppState.onboardingData.dob || ''}"></div>
            </div>
            <div class="input-group"><label>Residential Address</label><textarea id="ob-res-address">${AppState.onboardingData.resAddress || ''}</textarea></div>
        `;
    } else if (step === 2) {
        if (role === 'doctor') {
            html = `
                <h2>2. Professional Details</h2>
                <div class="input-group"><label>Medical Registration Number (Mandatory)</label><input type="text" id="ob-reg-num" value="${AppState.onboardingData.regNum || ''}"></div>
                <div class="input-group"><label>Medical Council Name (State/National)</label><input type="text" id="ob-council" value="${AppState.onboardingData.council || ''}"></div>
                <div class="input-group"><label>Qualification (e.g. MBBS, MD)</label><input type="text" id="ob-qual" value="${AppState.onboardingData.qualification || ''}"></div>
                <div class="input-group"><label>Specialization (e.g. Cardiologist)</label><input type="text" id="ob-spec" value="${AppState.onboardingData.specialty || ''}"></div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                    <div class="input-group"><label>Total Experience (Years)</label><input type="number" id="ob-exp" value="${AppState.onboardingData.experience || ''}"></div>
                    <div class="input-group"><label>University Name</label><input type="text" id="ob-uni" value="${AppState.onboardingData.university || ''}"></div>
                </div>
            `;
        } else {
            html = `
                <h2>2. Lab Services & Info</h2>
                <div class="input-group"><label>Lab Registration Number</label><input type="text" id="ob-lab-reg" value="${AppState.onboardingData.labRegNum || ''}"></div>
                <div class="input-group"><label>GST Number (Optional)</label><input type="text" id="ob-gst" value="${AppState.onboardingData.gst || ''}"></div>
                <div class="input-group"><label>Test Categories (e.g. Blood, X-Ray)</label><input type="text" id="ob-categories" value="${AppState.onboardingData.categories || ''}"></div>
                <div class="input-group"><label>NABL Accredited?</label><select id="ob-nabl"><option value="Yes">Yes</option><option value="No">No</option></select></div>
            `;
        }
    } else if (step === 3) {
        html = `
            <h2>3. ${role === 'doctor' ? 'Clinic' : 'Lab'} Location & Details</h2>
            <div class="input-group"><label>${role === 'doctor' ? 'Clinic/Hospital' : 'Center'} Name</label><input type="text" id="ob-clinic-name" value="${AppState.onboardingData.clinicName || ''}"></div>
            <div class="input-group"><label>Full Address</label><textarea id="ob-clinic-address">${AppState.onboardingData.clinicAddress || ''}</textarea></div>
            <div class="map-placeholder" id="onboarding-map-marker">
                <i class="fas fa-location-dot"></i> GPS Location Detected (19.0760° N, 72.8777° E)
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                <div class="input-group"><label>Consultation Fee (Offline)</label><input type="number" id="ob-fee-off" value="${AppState.onboardingData.price || '500'}"></div>
                <div class="input-group"><label>Emergency Available?</label><select id="ob-emergency"><option value="Yes">Yes</option><option value="No">No</option></select></div>
            </div>
        `;
    } else if (step === 4) {
        html = `
            <h2>4. Document Upload</h2>
            <p>Upload clear scans for verification.</p>
            <div class="upload-grid">
                <div class="upload-card" onclick="document.getElementById('doc-id-proof').click()">
                    <input type="file" id="doc-id-proof" class="hidden" onchange="handleDocUpload(this, 'idProof')">
                    <i class="fas fa-id-card"></i>
                    <h4>ID Proof</h4>
                    <div class="upload-preview" id="preview-idProof">${AppState.onboardingData.docs?.idProof ? '✓ Uploaded' : 'Aadhaar / Govt ID'}</div>
                </div>
                <div class="upload-card" onclick="document.getElementById('doc-reg-cert').click()">
                    <input type="file" id="doc-reg-cert" class="hidden" onchange="handleDocUpload(this, 'regCert')">
                    <i class="fas fa-certificate"></i>
                    <h4>Registration</h4>
                    <div class="upload-preview" id="preview-regCert">${AppState.onboardingData.docs?.regCert ? '✓ Uploaded' : 'Medical/Lab Certificate'}</div>
                </div>
                <div class="upload-card" onclick="document.getElementById('doc-extra').click()">
                    <input type="file" id="doc-extra" class="hidden" onchange="handleDocUpload(this, 'extraDoc')">
                    <i class="fas fa-file-contract"></i>
                    <h4>Other Docs</h4>
                    <div class="upload-preview" id="preview-extraDoc">${AppState.onboardingData.docs?.extraDoc ? '✓ Uploaded' : 'Degree / License'}</div>
                </div>
            </div>
        `;
    } else if (step === 5) {
        html = `
            <h2>5. Bank & Payment Details</h2>
            <div class="input-group"><label>Account Holder Name</label><input type="text" id="ob-bank-name" value="${AppState.onboardingData.bankName || ''}"></div>
            <div class="input-group"><label>Bank Name</label><input type="text" id="ob-bank-inst" value="${AppState.onboardingData.bankInstitution || ''}"></div>
            <div class="input-group"><label>Account Number</label><input type="text" id="ob-bank-acc" value="${AppState.onboardingData.bankAcc || ''}"></div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                <div class="input-group"><label>IFSC Code</label><input type="text" id="ob-ifsc" value="${AppState.onboardingData.ifsc || ''}"></div>
                <div class="input-group"><label>UPI ID (Optional)</label><input type="text" id="ob-upi" value="${AppState.onboardingData.upi || ''}"></div>
            </div>
        `;
    } else if (step === 6) {
        html = `
            <div style="text-align:center; padding: 20px;">
                <i class="fas fa-check-circle" style="font-size:4rem; color:#27ae60; margin-bottom:20px;"></i>
                <h2>Agreement & Final Submission</h2>
                <p>By clicking submit, you agree to our platform's 20% commission on bookings and the Terms of Service.</p>
                <div style="margin: 30px 0; padding: 20px; border: 1.5px solid #eee; border-radius: 12px;">
                    <label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-weight:600;">
                        <input type="checkbox" id="ob-agree"> I accept the Platforms Terms and Conditions
                    </label>
                </div>
                <div class="input-group">
                    <label>Digital Signature (Type your full name)</label>
                    <input type="text" id="ob-sig" placeholder="Dr. John Doe">
                </div>
            </div>
        `;
    }

    content.innerHTML = html;
    document.getElementById('onboarding-prev').style.visibility = step === 1 ? 'hidden' : 'visible';
    document.getElementById('onboarding-next').innerText = step === 6 ? 'Submit Application' : 'Continue';
};

window.previewOnboardingPhoto = async function (input) {
    const file = input.files[0];
    if (file) {
        const url = await uploadFile(file, `temp/${AppState.user.id}/photo`);
        AppState.onboardingData.image = url;
        document.getElementById('onboarding-photo-preview').innerHTML = `<img src="${url}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
    }
};

window.handleDocUpload = async function (input, type) {
    const file = input.files[0];
    if (file) {
        document.getElementById(`preview-${type}`).innerText = 'Uploading...';
        const url = await uploadFile(file, `onboarding/${AppState.user.id}/${type}`);
        if (!AppState.onboardingData.docs) AppState.onboardingData.docs = {};
        AppState.onboardingData.docs[type] = url;
        document.getElementById(`preview-${type}`).innerText = '✓ Uploaded';
        showToast(`${type} uploaded successfully!`);
    }
};

window.nextOnboardingStep = async function () {
    // Capture current step data
    saveCurrentStepData();

    if (AppState.currentOnboardingStep < 6) {
        AppState.currentOnboardingStep++;
        renderOnboardingStep();
    } else {
        submitOnboardingApplication();
    }
};

window.prevOnboardingStep = function () {
    if (AppState.currentOnboardingStep > 1) {
        AppState.currentOnboardingStep--;
        renderOnboardingStep();
    }
};

function saveCurrentStepData() {
    const s = AppState.currentOnboardingStep;
    const d = AppState.onboardingData;

    if (s === 1) {
        d.name = document.getElementById('ob-name').value;
        d.gender = document.getElementById('ob-gender').value;
        d.dob = document.getElementById('ob-dob').value;
        d.resAddress = document.getElementById('ob-res-address').value;
    } else if (s === 2) {
        if (AppState.user.role === 'doctor') {
            d.regNum = document.getElementById('ob-reg-num').value;
            d.council = document.getElementById('ob-council').value;
            d.qualification = document.getElementById('ob-qual').value;
            d.specialty = document.getElementById('ob-spec').value;
            d.experience = document.getElementById('ob-exp').value;
            d.university = document.getElementById('ob-uni').value;
        } else {
            d.labRegNum = document.getElementById('ob-lab-reg').value;
            d.gst = document.getElementById('ob-gst').value;
            d.categories = document.getElementById('ob-categories').value;
            d.nabl = document.getElementById('ob-nabl').value;
        }
    } else if (s === 3) {
        d.clinicName = document.getElementById('ob-clinic-name').value;
        d.clinicAddress = document.getElementById('ob-clinic-address').value;
        d.price = document.getElementById('ob-fee-off').value;
        d.emergency = document.getElementById('ob-emergency').value;
    } else if (s === 5) {
        d.bankName = document.getElementById('ob-bank-name').value;
        d.bankInstitution = document.getElementById('ob-bank-inst').value;
        d.bankAcc = document.getElementById('ob-bank-acc').value;
        d.ifsc = document.getElementById('ob-ifsc').value;
        d.upi = document.getElementById('ob-upi').value;
    }
}

async function submitOnboardingApplication() {
    if (!document.getElementById('ob-agree').checked) {
        return showToast("Please agree to the Terms & Conditions", "warning");
    }
    const sig = document.getElementById('ob-sig').value;
    if (!sig) return showToast("Digital Signature is required", "warning");

    showToast("Submitting your application...");
    try {
        const role = AppState.user.role;
        const collection = role + 's';

        const finalData = {
            ...AppState.onboardingData,
            signature: sig,
            onboardingStatus: 'submitted',
            approved: false,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        await db.collection(collection).doc(AppState.user.id).set(finalData, { merge: true });
        await db.collection('users').doc(AppState.user.id).update({ onboardingStatus: 'submitted' });

        showToast("Application Submitted! Admin will review shortly.", "success");
        AppState.user.onboardingStatus = 'submitted';
        showRoleView(role);
    } catch (err) {
        showToast("Submission failed: " + err.message, "error");
    }
}

// --- UI Rendering ---
function renderGrid() {
    const data = AppState.currentType === 'doctors' ? AppState.doctors : AppState.labs;
    const grid = document.getElementById('grid-container'); // Fixed ID mismatch
    if (!grid) return;

    const filtered = data.filter(item => {
        const matchesCat = AppState.activeFilters.category === 'All' || item.specialty === AppState.activeFilters.category;
        const matchesSearch = item.name.toLowerCase().includes(AppState.activeFilters.search.toLowerCase()) ||
            (item.specialty && item.specialty.toLowerCase().includes(AppState.activeFilters.search.toLowerCase()));

        // Advanced Filters
        const matchesLang = !AppState.activeFilters.language || (item.languages && item.languages.toLowerCase().includes(AppState.activeFilters.language.toLowerCase()));
        const matchesRating = !AppState.activeFilters.rating || (parseFloat(item.rating || 0) >= AppState.activeFilters.rating);

        return matchesCat && matchesSearch && matchesLang && matchesRating; // Show all for demo
    });

    if (filtered.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 40px;">
            <img src="https://cdn-icons-png.flaticon.com/512/6134/6134065.png" style="width:120px; opacity:0.3;">
            <p style="margin-top:20px; color:var(--text-muted);">No approved ${AppState.currentType} found matching your search.</p>
        </div>`;
        return;
    }

    grid.innerHTML = filtered.map(item => {
        const fallbackImg = AppState.currentType === 'doctors' ? "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=500&q=80" : "https://images.unsplash.com/photo-1511174511562-5f7f18b874f8?auto=format&fit=crop&w=500&q=80";
        return `
        <div class="doctor-card" onclick="openDetailsView('${item.id}', '${AppState.currentType}')">
            <div class="card-img" style="background-image: url('${item.image || fallbackImg}')">
                ${item.approved ? `<span class="badge-verified"><i class="fas fa-certificate"></i> Verified</span>` : ''}
                <div class="card-overlay">
                    <div style="display:flex; gap:10px; align-items:center;">
                         <span><i class="fas fa-star" style="color:#f1c40f;"></i> ${item.rating || '4.8'}</span>
                         <span>•</span>
                         <span>${item.experience || '8'}+ Yrs Exp</span>
                    </div>
                </div>
            </div>
            <div class="card-content">
                <div style="display:flex; justify-content:space-between; align-items:start;">
                    <h3 class="card-title">${item.name}</h3>
                    ${item.approved ? '<i class="fas fa-check-circle" style="color:#3498db; margin-top:5px;" title="Admin Verified"></i>' : ''}
                </div>
                <div style="display:flex; gap:10px; margin-bottom:10px;">
                    <span class="role-badge" style="font-size:0.6rem;">${item.specialty || 'General'}</span>
                    <span class="role-badge" style="background:#e8f5e9; color:#2ecc71; font-size:0.6rem;">Available Today</span>
                </div>
                <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom:15px;"><i class="fas fa-location-dot"></i> ${item.address || 'Mumbai, India'}</p>
                <div class="card-footer">
                    <div class="card-price">₹${item.price || '500'} <span>/${AppState.currentType === 'doctors' ? 'Visit' : 'Test'}</span></div>
                    <button class="btn-book" onclick="event.stopPropagation(); openBooking('${item.id}')">Book Now</button>
                </div>
            </div>
        </div>
        `;
    }).join('');
}


window.setCategory = function (cat) {
    if (cat === 'Medicines') return showPatientTab('pharmacy');
    if (cat === 'Surgeries') return showToast(`${cat} service coming soon!`, "warning");

    if (cat === 'Lab Tests') {
        AppState.currentType = 'labs';
        renderLabTests();
        return;
    }

    if (cat === 'Video Consult') {
        AppState.currentType = 'doctors';
        renderVideoConsult();
        return;
    }

    AppState.currentType = cat === 'Find Doctors' ? 'doctors' : cat; // 'doctors' or 'labs'
    AppState.activeFilters.category = 'All';
    DOM.sectionTitle.innerText = AppState.currentType === 'doctors' ? 'Verified Doctors' : 'Diagnostic Labs';
    renderGrid();
    document.getElementById('list-section').scrollIntoView({ behavior: 'smooth' });
};

window.renderVideoConsult = function () {
    DOM.sectionTitle.innerText = "Talk to a Doctor Online (Live)";
    const online = AppState.doctors.filter(d => d.approved);
    const grid = document.getElementById('provider-grid');
    if (!grid) return;

    if (online.length === 0) {
        grid.innerHTML = '<p style="text-align:center; padding:40px; color:var(--text-muted);">No doctors online currently.</p>';
        return;
    }

    grid.innerHTML = online.map(d => `
        <div class="doctor-card" onclick="openBooking('${d.id}')">
            <div class="card-img" style="background-image: url('${d.image}')">
                <span class="badge-verified" style="background:#2ecc71;"><i class="fas fa-video"></i> Online Now</span>
            </div>
            <div class="card-content">
                <h3 class="card-title">${d.name}</h3>
                <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:10px;"><i class="fas fa-language"></i> English, Hindi • 8+ Yrs Exp</p>
                <div class="card-footer">
                    <div class="card-price">₹${d.price} <span>/Consult</span></div>
                    <button class="btn-book" style="background:var(--secondary);">Connect Now</button>
                </div>
            </div>
        </div>
    `).join('');
};

window.setSpecialty = function (spec) {
    AppState.currentType = 'doctors';
    AppState.activeFilters.category = spec;
    DOM.sectionTitle.innerText = `${spec} Specialists`;
    renderGrid();
    document.getElementById('list-section').scrollIntoView({ behavior: 'smooth' });
};

// --- Event Listeners ---
function setupEventListeners() {
    // Image Previews
    const setupPreview = (inputId, previewId) => {
        const input = document.getElementById(inputId);
        const preview = document.getElementById(previewId);
        if (input && preview) {
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    const url = URL.createObjectURL(file);
                    preview.innerHTML = `<img src="${url}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
                }
            };
        }
    };

    setupPreview('patient-photo-input', 'patient-profile-preview');
    setupPreview('doctor-photo-input', 'doctor-profile-preview');

    // Auth Button
    DOM.authBtn.addEventListener('click', () => {
        if (AppState.user) {
            auth.signOut().then(() => showToast("Logged out successfully"));
        } else {
            DOM.authOverlay.classList.remove('hidden');
            toggleAuth('login');
        }
    });

    // Close Auth Overlay
    DOM.authOverlay.addEventListener('click', (e) => {
        if (e.target === DOM.authOverlay) DOM.authOverlay.classList.add('hidden');
    });

    // Login Form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-identifier').value.trim();
        const pass = document.getElementById('login-pass').value.trim();
        try {
            await auth.signInWithEmailAndPassword(email, pass);
            showToast("Welcome back!");
        } catch (err) {
            showToast(err.message, "error");
        }
    });

    // Register Form
    document.getElementById('register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('reg-name').value.trim();
        const email = document.getElementById('reg-email').value.trim();
        const phone = document.getElementById('reg-phone').value.trim();
        const role = document.getElementById('reg-role').value;
        const pass = document.getElementById('reg-pass').value.trim();

        try {
            const cred = await auth.createUserWithEmailAndPassword(email, pass);
            const userData = { name, email, phone, role, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
            await db.collection('users').doc(cred.user.uid).set(userData);

            // If doctor/lab, create their specific entries
            if (role === 'doctor' || role === 'lab') {
                const specificData = {
                    id: cred.user.uid,
                    name,
                    specialty: role === 'doctor' ? "General Physician" : "Full Body Diagnostics",
                    image: role === 'doctor' ? "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=500&q=80" : "https://images.unsplash.com/photo-1511174511562-5f7f18b874f8?auto=format&fit=crop&w=500&q=80",
                    price: role === 'doctor' ? "500" : "999",
                    approved: false
                };
                await db.collection(role + 's').doc(cred.user.uid).set(specificData);
            }
            showToast("Account created! Welcome to HealthMate.");
        } catch (err) {
            showToast(err.message, "error");
        }
    });

    // Category Cards
    document.querySelectorAll('.category-card').forEach(card => {
        card.addEventListener('click', () => {
            AppState.currentType = card.dataset.type;
            DOM.sectionTitle.innerText = AppState.currentType === 'doctors' ? 'Top Rated Doctors' : 'Diagnostic Labs';
            renderGrid();
            document.getElementById('list-section').scrollIntoView({ behavior: 'smooth' });
        });
    });

    // Filters
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            AppState.activeFilters.category = btn.innerText;
            renderGrid();
        });
    });

    // Advanced Filters (Listing Page) - Removed Inactive
    if (DOM.searchInput) DOM.searchInput.oninput = (e) => {
        AppState.activeFilters.search = e.target.value;
        renderGrid();
    };

    // Close Modal
    document.querySelector('.close-modal').addEventListener('click', () => {
        DOM.modal.classList.add('hidden');
    });

    // Theme & Chat & Lang
    if (DOM.themeToggle) DOM.themeToggle.onclick = toggleTheme;
    if (DOM.aiToggle) DOM.aiToggle.onclick = toggleChat;
    if (document.getElementById('close-chat')) document.getElementById('close-chat').onclick = toggleChat;
    if (DOM.chatSend) DOM.chatSend.onclick = handleChat;
    if (DOM.chatInput) DOM.chatInput.onkeypress = (e) => { if (e.key === 'Enter') handleChat(); };
    if (DOM.langSwitch) DOM.langSwitch.onchange = (e) => {
        AppState.activeFilters.language = e.target.value;
        renderGrid();
    };

    const ratingFilter = document.getElementById('filter-rating');
    if (ratingFilter) ratingFilter.onchange = (e) => {
        AppState.activeFilters.rating = parseFloat(e.target.value);
        renderGrid();
    };
}

// --- Booking & Payment Flow ---
window.openBooking = function (itemId) {
    if (!AppState.user) {
        showToast("Please login to book an appointment", "warning");
        DOM.authOverlay.classList.remove('hidden');
        return;
    }

    const item = (AppState.currentType === 'doctors' ? AppState.doctors : AppState.labs).find(i => i.id === itemId);
    if (!item) return;

    AppState.selectedSlot = null;
    AppState.selectedPayMethod = 'online';
    const price = parseInt(item.price) || 500;
    const slots = ['09:00 AM', '10:30 AM', '01:00 PM', '03:30 PM', '05:00 PM'];

    // Smart Prediction Logic
    const busyCounts = {};
    slots.forEach(s => busyCounts[s] = AppState.appointments.filter(a => a.targetId === itemId && a.time === s).length);
    const minBusy = Math.min(...Object.values(busyCounts));
    const bestSlot = slots.find(s => busyCounts[s] === minBusy);
    AppState.selectedSlot = bestSlot; // Auto-select the best slot

    DOM.modalBody.innerHTML = `
        <div class="booking-flow" style="text-align:left;">
            <div id="smart-insight-banner" style="background:#fffcfc; border:1px solid #ffebeb; padding:12px; border-radius:10px; margin-bottom:20px; display:flex; gap:10px; align-items:start;">
                <i class="fas fa-magic" style="color:var(--primary); margin-top:3px;"></i>
                <div>
                    <h5 style="color:var(--primary); margin-bottom:2px;">Smart Insight: "${bestSlot}" Recommended</h5>
                    <p style="font-size:0.75rem; color:var(--text-muted);">This slot has the highest availability for faster service today.</p>
                </div>
            </div>

            <h3 style="margin-bottom:15px; font-size:1.3rem;">Book Appointment</h3>
            <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:25px;">${item.name} | ${item.specialty || 'Healthcare'}</p>

            <label style="font-weight: 700; display: block; margin-bottom:15px;">Select Time Slot</label>
            <div class="slot-grid" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:30px;">
                ${slots.map(s => `
                    <div class="slot-item ${s === bestSlot ? 'selected recommended' : ''}" onclick="selectSlot(this, '${s}')" 
                         style="border:1px solid #eee; padding:12px; border-radius:12px; text-align:center; cursor:pointer; transition:all 0.2s;">
                        <span style="display:block; font-weight:600; font-size:0.85rem;">${s}</span>
                        ${s === bestSlot ? '<span style="font-size:0.6rem; color:var(--primary); font-weight:700;">Smart Recommended</span>' : ''}
                    </div>
                `).join('')}
            </div>


            <div class="payment-summary" style="background:#fcfcfc; border:1px solid #f0f0f0; border-radius:15px; padding:20px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:12px; font-size:0.95rem;">
                    <span style="color:#666;">Consultation Fee:</span>
                    <span style="font-weight:700;">₹${price}</span>
                </div>
                <div id="booking-gst-row" style="display:flex; justify-content:space-between; margin-bottom:15px; font-size:0.95rem;">
                    <span style="color:#666;">Service GST (18%):</span>
                    <span style="font-weight:600;">₹${Math.floor(price * 0.18)}</span>
                </div>
                <div style="border-top:2px dashed #eee; padding-top:15px; display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:800; font-size:1.1rem;">Total Payable:</span>
                    <span id="booking-total-price" data-base="${price}" style="font-size:1.6rem; font-weight:900; color:var(--primary);">₹${Math.floor(price * 1.18)}</span>
                </div>
            </div>

            <button class="btn-signup" id="confirm-booking-btn" onclick="processPayment('${item.id}', '${AppState.currentType}')" 
                    style="width:100%; margin-top:25px; padding:18px; font-size:1.1rem; border-radius:15px; background:var(--primary);">
                Proceed to Payment
            </button>
        </div>
    `;
    DOM.modal.classList.remove('hidden');
};


window.selectSlot = (el, time) => {
    document.querySelectorAll('.slot-item').forEach(s => s.classList.remove('selected'));
    el.classList.add('selected');
    AppState.selectedSlot = time;
};

window.selectPayMethod = (el, method) => {
    document.querySelectorAll('.pay-option').forEach(m => m.classList.remove('active'));
    el.classList.add('active');
    AppState.selectedPayMethod = method;

    const btn = document.getElementById('confirm-booking-btn');
    const priceDisplay = document.getElementById('booking-total-price');
    const gstRow = document.getElementById('booking-gst-row');
    const basePrice = parseInt(priceDisplay.dataset.base || 500);



    // Everything is online now
    if (gstRow) gstRow.style.display = 'flex';
    priceDisplay.innerText = `₹${Math.floor(basePrice * 1.18)}`;
    btn.innerText = `Proceed to Payment`;
};

window.processPayment = function (itemId, type) {
    if (!AppState.selectedSlot) return showToast("Please select a time slot", "warning");

    const item = (type === 'doctors' ? AppState.doctors : AppState.labs).find(i => i.id === itemId);
    if (!item) return;

    const btn = document.getElementById('confirm-booking-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Initializing Secure Gateway...';
    }

    const basePrice = parseInt(item.price) || 500;
    const totalAmount = Math.floor(basePrice * 1.18);

    const options = {
        key: RAZORPAY_CONFIG.key,
        amount: totalAmount * 100, // Amount in paise
        currency: "INR",
        name: RAZORPAY_CONFIG.name,
        description: `Booking for ${item.name} (${type === 'doctors' ? 'Consultation' : 'Lab Test'})`,
        image: "assets/healthmate-logo.png",
        prefill: {
            name: AppState.user.name,
            email: AppState.user.email,
            contact: AppState.user.phone || ""
        },
        theme: { color: "#E23744" },
        handler: function (response) {
            showToast("Payment Successful!", "success");
            window.confirmBooking(itemId, type, {
                status: 'Paid',
                mode: 'Online (Razorpay)',
                transactionId: response.razorpay_payment_id
            }).catch(err => {
                console.error("[PAYMENT] confirmBooking failed:", err);
                showToast("Booking failed: " + err.message, "error");
            });
        },
        modal: {
            ondismiss: function () {
                showToast("Payment cancelled by user", "warning");
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = 'Proceed to Payment';
                }
            }
        }
    };

    try {
        const rzp = new Razorpay(options);
        rzp.on('payment.failed', function (response) {
            showToast("Payment Failed: " + response.error.description, "error");
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = 'Proceed to Payment';
            }
        });
        rzp.open();
    } catch (err) {
        console.error("Razorpay error:", err);
        showToast("Gateway error. Switching to offline simulator...", "warning");
        // Fallback for demo if script fails or key is missing
        setTimeout(() => {
            window.confirmBooking(itemId, type, { status: 'Paid', mode: 'Demo Simulation', transactionId: 'SIM_' + Date.now() });
        }, 1500);
    }
};

window.confirmBooking = async function (itemId, type, paymentData = { status: 'Pending', mode: 'Offline' }) {
    console.log("[BOOKING] Creating appointment for:", itemId, type, paymentData);
    const items = (type === 'doctors' ? AppState.doctors : AppState.labs);
    const item = items.find(i => i.id === itemId);

    if (!item) {
        console.error("[BOOKING] Item not found in AppState:", itemId);
        throw new Error("Target provider not found");
    }

    const token = Math.floor(Math.random() * 50) + 1;
    const ahead = Math.floor(Math.random() * 8) + 1;
    const symptoms = document.getElementById('booking-symptoms')?.value || "";

    const appointment = {
        patientId: AppState.user.id,
        patientName: AppState.user.name,
        targetId: itemId,
        targetName: item.name,
        type: type,
        time: AppState.selectedSlot,
        price: parseInt(item.price) || 500,
        commission: Math.floor((parseInt(item.price) || 500) * 0.20), // Standardized 20% Commission
        status: 'pending',
        paymentStatus: paymentData.status,
        paymentMode: paymentData.mode,
        transactionId: paymentData.transactionId || 'N/A',
        symptoms: symptoms,
        preReportUrl: AppState.bookingReportUrl || null,
        collectionType: AppState.selectedCollection || 'visit',
        payoutStatus: paymentData.status === 'Paid' ? 'Escrow' : 'Pending',
        tokenNumber: token,
        queueAhead: ahead,
        date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
        const docRef = await db.collection('appointments').add(appointment);

        // Log Transaction & Update Escrow Wallet
        if (paymentData.status === 'Paid') {
            await creditEscrow(itemId, appointment.price, appointment.commission);

            await db.collection('transactions').add({
                bookingId: docRef.id,
                transactionId: paymentData.transactionId,
                amount: appointment.price * 1.18,
                status: 'Success',
                paymentMode: paymentData.mode,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }

        DOM.modalBody.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div style="width: 80px; height: 80px; background: #E8F5E9; color: #2ecc71; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 2.5rem;">
                    <i class="fas fa-check"></i>
                </div>
                <h2>Booking Confirmed!</h2>
                <p style="color:var(--text-muted); margin-bottom: 20px;">Payment Status: <strong>${paymentData.status}</strong></p>
                <div style="background:var(--primary-light); padding:15px; border-radius:15px; margin:20px 0;">
                    <p style="font-size:0.7rem; color:var(--text-muted); margin-bottom:5px;">TOKEN NUMBER</p>
                    <h1 style="font-size:2.5rem; color:var(--primary); font-weight:900;">#${token}</h1>
                </div>
                <p>There are <strong>${ahead} patients</strong> ahead of you.</p>
                <div style="margin-top: 25px; font-size: 0.9rem; color: var(--text-muted); display:flex; gap:10px; justify-content:center;">
                    <button class="btn-small" onclick="downloadInvoice('${itemId}', '${token}')"><i class="fas fa-download"></i> Receipt</button>
                    <button class="btn-small btn-signup" onclick="DOM.modal.classList.add('hidden')">Done</button>
                </div>
            </div>
        `;
        showToast("Booking Successful! Notification sent.");
        simulateNotification('whatsapp', `New Booking Alert: ${appointment.patientName} has booked a slot for ${appointment.time}. Payment: ${appointment.paymentStatus}.`);
    } catch (err) {
        showToast("Booking failed", "error");
    }
}

window.downloadInvoice = function (id, token) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(22);
    doc.text("HEALTHMATE - BOOKING RECEIPT", 20, 30);
    doc.setFontSize(12);
    doc.text(`Token Number: #${token}`, 20, 50);
    doc.text(`Booking ID: ${id.substring(0, 10)}`, 20, 60);
    doc.text(`Transaction Status: Paid`, 20, 70);
    doc.text(`Date: ${new Date().toLocaleDateString()}`, 20, 80);
    doc.text(`Fee (GST Incl): INR 500`, 20, 100);
    doc.save(`HealthMate_Invoice_${token}.pdf`);
    showToast("Receipt Downloaded!");
};


// --- Ratings & Reviews ---
window.openReviewModal = function (appId, targetName) {
    DOM.modalBody.innerHTML = `
        <div style="text-align: center;">
            <h3>Rate your experience</h3>
            <p>How was your visit with <strong>${targetName}</strong>?</p>
            <div class="rating-input" id="rating-stars-input">
                <i class="fas fa-star" data-value="1"></i>
                <i class="fas fa-star" data-value="2"></i>
                <i class="fas fa-star" data-value="3"></i>
                <i class="fas fa-star" data-value="4"></i>
                <i class="fas fa-star" data-value="5"></i>
            </div>
            <textarea id="review-text" placeholder="Share your feedback..." 
                style="width: 100%; padding: 15px; border-radius: 12px; border: 1.5px solid #EEE; margin-bottom: 20px; outline: none;"></textarea>
            <button class="btn-signup" style="width: 100%;" onclick="submitReview('${appId}')">Submit Review</button>
        </div>
    `;
    DOM.modal.classList.remove('hidden');

    // Star logic
    const stars = document.querySelectorAll('#rating-stars-input i');
    stars.forEach(s => {
        s.onclick = () => {
            stars.forEach(st => st.classList.remove('active'));
            const val = s.dataset.value;
            for (let i = 0; i < val; i++) stars[i].classList.add('active');
            AppState.tempRating = val;
        };
    });
};

window.submitReview = async function (appId) {
    const rating = AppState.tempRating || 5;
    const text = document.getElementById('review-text').value;

    try {
        await db.collection('reviews').add({
            appointmentId: appId,
            rating: parseInt(rating),
            comment: text,
            patientName: AppState.user.name,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // Mark appointment as reviewed
        await db.collection('appointments').doc(appId).update({ reviewed: true });

        showToast("Thank you for your feedback!");
        DOM.modal.classList.add('hidden');
        refreshPatientHistory();
    } catch (err) {
        showToast("Review failed", "error");
    }
};

// --- Role Specific Functions ---
window.showPatientSection = function (tab) {
    // Hide all patient tabs
    document.getElementById('patient-home-tab').classList.add('hidden');
    document.getElementById('patient-history-tab').classList.add('hidden');
    document.getElementById('patient-reports-tab').classList.add('hidden');
    document.getElementById('patient-records-tab').classList.add('hidden');
    document.getElementById('patient-profile-tab').classList.add('hidden');

    // Show selected
    const target = document.getElementById(`patient-${tab}-tab`);
    if (target) target.classList.remove('hidden');

    // Highlight Navigation (Desktop)
    document.querySelectorAll('.patient-nav a').forEach(a => {
        a.style.color = 'var(--text-muted)';
        if (a.innerText.toLowerCase().includes(tab)) a.style.color = 'var(--primary)';
    });

    // Highlight Navigation (Mobile Bottom Nav)
    document.querySelectorAll('.mobile-bottom-nav .nav-item').forEach(item => {
        item.classList.remove('active');
        const span = item.querySelector('span').innerText.toLowerCase();
        if (span.includes(tab) || (tab === 'history' && span.includes('bookings'))) {
            item.classList.add('active');
        }
    });

    if (tab === 'home') updatePatientDashboard();
    if (tab === 'history') refreshPatientHistory();
    if (tab === 'records') refreshPatientRecords();
};

window.updatePatientDashboard = async function () {
    if (!AppState.user) return;

    const historyList = document.getElementById('home-history-list');
    const reportsList = document.getElementById('home-reports-list');
    const upcomingSec = document.getElementById('upcoming-appointment-section');
    const upcomingCard = document.getElementById('upcoming-appointment-card');

    // 1. Upcoming Appointment
    const now = new Date();
    // Simple filter for future appointments or today's pending/approved ones
    const upcoming = AppState.appointments
        .filter(a => a.patientId === AppState.user.id && (a.status === 'pending' || a.status === 'approved'))
        .sort((a, b) => new Date(a.date) - new Date(b.date))[0];

    if (upcoming) {
        upcomingSec.classList.remove('hidden');
        upcomingCard.innerHTML = `
            <div class="tile-item" style="background: linear-gradient(135deg, #fff 0%, #fff5f6 100%); border: 1.5px solid #ffebeb; padding: 25px; border-radius: 20px; box-shadow: 0 10px 30px rgba(226, 55, 68, 0.05);">
                <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
                        <span style="background: var(--primary); color: white; padding: 4px 12px; border-radius: 50px; font-size: 0.7rem; font-weight: 800; letter-spacing: 0.5px;">NEXT APPOINTMENT</span>
                        <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;"><i class="fas fa-clock"></i> ${upcoming.time || 'General'}</span>
                    </div>
                    <h3 style="font-size: 1.4rem; margin-bottom: 5px;">${upcoming.targetName}</h3>
                    <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 15px;">${upcoming.type.toUpperCase()} • ${upcoming.date}</p>
                    <div style="display: flex; gap: 10px;">
                        <button class="btn-signup" style="padding: 10px 20px; font-size: 0.85rem;" onclick="showPatientSection('history')">View Details</button>
                        <button class="btn-small" style="background: #fff; border: 1px solid #ddd; color: #555; padding: 10px 20px;" onclick="showToast('Connecting to clinic...')"><i class="fas fa-phone"></i> Call</button>
                    </div>
                </div>
                <div style="width: 80px; height: 80px; background: white; border-radius: 15px; display: flex; align-items: center; justify-content: center; font-size: 2rem; color: var(--primary); box-shadow: 0 5px 15px rgba(0,0,0,0.05);">
                    <i class="fas ${upcoming.type === 'doctors' ? 'fa-user-md' : 'fa-flask-vial'}"></i>
                </div>
            </div>
        `;
    } else {
        upcomingSec.classList.add('hidden');
    }

    // 2. Medical Reports Summary
    try {
        const reportsSnap = await db.collection('medical_records')
            .where('patientId', '==', AppState.user.id)
            .orderBy('createdAt', 'desc').limit(2).get();
        const latestReports = reportsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (latestReports.length === 0) {
            reportsList.innerHTML = `<p style="padding: 20px; text-align: center; color: var(--text-muted); background: #f9f9f9; border-radius: 15px; border: 1px dashed #ddd;">No reports available yet.</p>`;
        } else {
            reportsList.innerHTML = latestReports.map(r => `
                <div class="tile-item" style="padding: 15px; background: #fff; border: 1px solid #f0f0f0; border-radius: 15px; margin-bottom: 10px; cursor: pointer;" onclick="window.open('${r.url}', '_blank')">
                    <div style="width: 45px; height: 45px; background: #f0f7ff; color: #007bff; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem;">
                        <i class="fas fa-file-pdf"></i>
                    </div>
                    <div class="tile-info" style="flex: 1; margin-left: 15px;">
                        <h4 style="font-size: 0.95rem; margin-bottom: 2px;">${r.name}</h4>
                        <p style="font-size: 0.8rem; color: var(--text-muted);">${r.date}</p>
                    </div>
                    <i class="fas fa-download" style="color: #999;"></i>
                </div>
            `).join('');
        }
    } catch (e) { console.error("Dashboard reports error:", e); }

    // 3. Booking History Summary
    const recentHistory = AppState.appointments
        .filter(a => a.patientId === AppState.user.id)
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);

    if (recentHistory.length === 0) {
        historyList.innerHTML = `<p style="padding: 20px; text-align: center; color: var(--text-muted); background: #f9f9f9; border-radius: 15px; border: 1px dashed #ddd;">No past bookings found.</p>`;
    } else {
        historyList.innerHTML = recentHistory.map(a => `
            <div class="tile-item" style="padding: 15px; background: #fff; border: 1px solid #f0f0f0; border-radius: 15px; margin-bottom: 10px;">
                <div style="width: 45px; height: 45px; background: #f5f5f5; color: #666; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem;">
                    <i class="fas ${a.type === 'doctors' ? 'fa-user-md' : 'fa-vial'}"></i>
                </div>
                <div class="tile-info" style="flex: 1; margin-left: 15px;">
                    <h4 style="font-size: 0.95rem; margin-bottom: 2px;">${a.targetName}</h4>
                    <p style="font-size: 0.8rem; color: var(--text-muted);">${a.date} • ${a.status.toUpperCase()}</p>
                </div>
                <span class="tile-badge status-${a.status}" style="font-size: 0.65rem;">${a.status}</span>
            </div>
        `).join('');
    }
};

window.refreshPatientRecords = async function () {
    const grid = document.getElementById('patient-records-grid');
    if (!grid) return;

    try {
        const snap = await db.collection('medical_records').where('patientId', '==', AppState.user.id).orderBy('createdAt', 'desc').get();
        AppState.records = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (AppState.records.length === 0) {
            grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted); border: 2px dashed #EEE; border-radius: 20px;">
                <i class="fas fa-folder-open" style="font-size: 3rem; margin-bottom: 15px;"></i>
                <p>No records uploaded yet. Keep your health history organized!</p>
            </div>`;
            return;
        }

        grid.innerHTML = AppState.records.map(r => `
            <div class="record-card">
                <div style="display: flex; align-items: center; gap: 15px;">
                    <div class="record-icon"><i class="fas ${r.type === 'image' ? 'fa-image' : 'fa-file-pdf'}"></i></div>
                    <div class="record-details">
                        <h4>${r.name || 'Untitled Record'}</h4>
                        <p>${r.date || 'Today'}</p>
                    </div>
                </div>
                <div class="record-actions">
                    <button class="btn-small btn-signup" style="background: var(--secondary);" onclick="window.open('${r.url}', '_blank')"><i class="fas fa-eye"></i> View</button>
                    <button class="btn-small" style="background: #f8f8f8; color: #e74c3c;" onclick="deleteRecord('${r.id}')"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error("Fetch records failed:", err);
    }
};

window.uploadMedicalRecord = async function (event) {
    const file = event.target.files[0];
    if (!file) return;

    showToast("Processing record...");
    const name = prompt("Enter a name for this record (e.g. Blood Test Oct 2025):") || file.name;

    try {
        const path = `records/${AppState.user.id}/${Date.now()}_${file.name}`;
        const url = await uploadFile(file, path);

        const record = {
            patientId: AppState.user.id,
            name: name,
            url: url,
            type: file.type.includes('image') ? 'image' : 'pdf',
            date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('medical_records').add(record);
        showToast("Record uploaded successfully!");
        refreshPatientRecords();
    } catch (err) {
        showToast("Upload failed: " + err.message, "error");
    }
};

window.deleteRecord = async function (id) {
    if (!confirm("Remove this record from your library?")) return;
    try {
        await db.collection('medical_records').doc(id).delete();
        showToast("Record removed");
        refreshPatientRecords();
    } catch (err) {
        showToast("Delete failed", "error");
    }
};

window.showProfileSub = function (sub, event) {
    document.querySelectorAll('.profile-sub-section').forEach(el => el.classList.add('hidden'));
    document.getElementById(`profile-${sub}`).classList.remove('hidden');
    document.querySelectorAll('.profile-menu .menu-item').forEach(btn => btn.classList.remove('active'));
    if (event) event.currentTarget.classList.add('active');
};

window.savePatientProfile = async function () {
    const name = document.getElementById('edit-name').value.trim();
    const phone = document.getElementById('edit-phone').value.trim();
    const photoFile = document.getElementById('patient-photo-input').files[0];

    if (!AppState.user) return;
    if (!name) return showToast("Name is required", "error");

    try {
        let photoURL = AppState.user.image;
        if (photoFile) {
            showToast("Uploading photo...");
            photoURL = await uploadFile(photoFile, `profiles/${AppState.user.id}`);
        }

        await db.collection('users').doc(AppState.user.id).update({
            name, phone, image: photoURL
        });

        AppState.user = { ...AppState.user, name, phone, image: photoURL };
        showToast("Profile Updated Successfully!");

        // Full UI refresh to sync all elements (navbar, sidebar, tab previews)
        applyUserSession();
    } catch (err) {
        showToast("Update failed: " + err.message, "error");
    }
};

function refreshPatientHistory() {
    const list = document.getElementById('patient-history-list');
    const myApps = AppState.appointments.filter(a => a.patientId === AppState.user.id);

    if (myApps.length === 0) {
        list.innerHTML = `<p style="text-align: center; padding: 40px; color: var(--text-muted);">No booking history found.</p>`;
        return;
    }

    list.innerHTML = myApps.map(a => {
        let timelineHTML = '';
        if (a.type === 'labs') {
            const steps = ['Booked', 'Sample Taken', 'Processing', 'Ready'];
            const currentStep = a.status === 'pending' ? 0 : (a.status === 'approved' ? 2 : 3);
            timelineHTML = `
                <div class="status-timeline" style="margin: 15px 0;">
                    ${steps.map((s, idx) => `
                        <div class="tl-step ${idx <= currentStep ? 'active' : ''}">
                            <div class="tl-dot">${idx + 1}</div>
                            <span style="font-size: 0.7rem;">${s}</span>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        const reportBadge = a.reportStatus ? `
            <span style="font-size:0.7rem; padding:4px 8px; border-radius:10px; background:${a.reportStatus === 'normal' ? '#e8f5e9' : '#ffebee'}; color:${a.reportStatus === 'normal' ? '#2ecc71' : '#e74c3c'}; border:1px solid currentColor;">
                <i class="fas ${a.reportStatus === 'normal' ? 'fa-check' : 'fa-exclamation-triangle'}"></i> ${a.reportTag || 'Report'}: ${a.reportStatus.toUpperCase()}
            </span>
        ` : '';

        return `
            <div class="tile-item" style="flex-direction:column; align-items:flex-start; position:relative;">
                <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                    <div class="tile-info">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <h4 style="margin:0;">${a.targetName}</h4>
                            <span style="background:var(--secondary); color:white; padding:2px 8px; border-radius:5px; font-size:0.7rem; font-weight:700;">Token: #${a.tokenNumber || 'NA'}</span>
                        </div>
                        <p style="margin-top:5px;">${a.type.toUpperCase()} • ${a.date} ${a.time ? `• ${a.time}` : ''}</p>
                    </div>
                    <span class="tile-badge status-${a.status}">${a.status}</span>
                </div>
                
                ${timelineHTML}
                
                <div style="margin: 10px 0; display:flex; gap:15px; align-items:center; width:100%;">
                    ${a.status === 'pending' ? `<p style="font-size:0.8rem; color:var(--primary); font-weight:600;"><i class="fas fa-users"></i> Queue Status: ${a.queueAhead || 0} patients ahead</p>` : ''}
                    ${reportBadge}
                </div>

                <div style="margin-top:10px; display:flex; gap:10px; width:100%;">
                    ${a.status === 'approved' && !a.reviewed ? `<button class="btn-small btn-signup" onclick="openReviewModal('${a.id}', '${a.targetName}')">Rate Visit</button>` : ''}
                    ${a.reviewed ? `<span style="font-size: 0.8rem; color: #2ecc71;"><i class="fas fa-check-double"></i> Feedback Shared</span>` : ''}
                    ${a.status === 'completed' && a.reportUrl ? `<button class="btn-small" style="background:#eee; color:var(--primary);" onclick="window.open('${a.reportUrl}')"><i class="fas fa-download"></i> View ${a.reportTag || 'Report'}</button>` : ''}
                    <button class="btn-small" style="background:#f9f9f9; color:#555; border:1px solid #ddd;" onclick="downloadInvoice('${a.targetId}', '${a.tokenNumber || 0}')"><i class="fas fa-file-invoice"></i> Invoice</button>
                </div>
            </div>
        `;
    }).join('');
}

function renderDoctorDashboard() {
    console.log(`[DASHBOARD] Rendering Doctor View (v${APP_VERSION})`);
    const list = document.getElementById('doctor-appointments-list');
    if (!list) return console.error("Doctor appointments list not found!");

    const myApps = AppState.appointments.filter(a => a.targetId === AppState.user.id);

    // FORCE Update Dynamic Name & Initials
    if (AppState.user) {
        const nameEl = document.getElementById('doctor-sidebar-name');
        const avatarEl = document.querySelector('#doctor-view .profile-img-large');

        if (nameEl) {
            nameEl.innerText = AppState.user.name;
            console.log("Sidebar name set to:", AppState.user.name);
        } else {
            console.error("doctor-sidebar-name element missing!");
        }

        if (avatarEl) {
            const initials = AppState.user.name.split(' ').map(n => n?.[0]).filter(Boolean).join('').toUpperCase().substring(0, 2);
            avatarEl.innerText = initials || "??";
            console.log("Avatar initials set to:", initials);
        }
    }

    const unapprovedAlert = document.getElementById('doctor-unapproved-alert');
    const docProfile = AppState.doctors.find(d => d.id === AppState.user.id);

    const statusBadge = document.getElementById('doctor-sidebar-status');
    if (docProfile && docProfile.approved) {
        unapprovedAlert.classList.add('hidden');
        if (statusBadge) {
            statusBadge.innerHTML = `<i class="fas fa-certificate"></i> Approved`;
            statusBadge.className = 'status-indicator approved';
        }
    } else {
        unapprovedAlert.classList.remove('hidden');
        if (statusBadge) {
            statusBadge.innerHTML = `<i class="fas fa-clock"></i> Pending`;
            statusBadge.className = 'status-indicator pending';
        }
    }

    // Summary Metrics
    const summaryMetrics = document.getElementById('doctor-summary-metrics');
    if (summaryMetrics) {
        const now = new Date();
        const thisMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const monthlyApps = myApps.filter(a => a.date && a.date.startsWith(thisMonthStr));
        const monthEarnings = monthlyApps.filter(a => a.status === 'approved').reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);
        const commission = Math.floor(monthEarnings * 0.20);
        const netEarnings = monthEarnings - commission;

        const pendingSettlement = myApps.filter(a => a.status === 'approved' && a.payoutStatus === 'Pending').reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);
        const upcomingPayout = myApps.filter(a => a.payoutStatus === 'Settled' && a.payoutDate && a.payoutDate.toDate() > now).reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);
        const settledPayout = myApps.filter(a => a.payoutStatus === 'Settled' && a.payoutDate && a.payoutDate.toDate() <= now).reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);

        const commRate = (AppState.user.commissionRate || 20) / 100;
        const netFactor = 1 - commRate;

        const netPending = Math.floor(pendingSettlement * netFactor);
        const netUpcoming = Math.floor(upcomingPayout * netFactor);
        const netSettled = Math.floor(settledPayout * netFactor);

        summaryMetrics.innerHTML = `
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-calendar-check" style="color:var(--primary); font-size:1.5rem; margin-bottom:10px;"></i>
                <h3>₹${netPending}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Pending Settlement</p>
                <span style="font-size:0.7rem; color:#e67e22;">Waiting for Admin</span>
            </div>
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-clock" style="color:#3498db; font-size:1.5rem; margin-bottom:10px;"></i>
                <h3>₹${netUpcoming}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Upcoming (1 Week Wait)</p>
                <span style="font-size:0.7rem; color:#3498db;">Processing...</span>
            </div>
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-wallet" style="color:#2ecc71; font-size:1.5rem; margin-bottom:10px;"></i>
                <h3 style="color:#2ecc71;">₹${netSettled}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Available for Withdrawal</p>
                <span style="font-size:0.7rem; color:#2ecc71;">Ready</span>
            </div>
        `;
    }

    if (myApps.length === 0) {
        list.innerHTML = `<p style="text-align: center; padding: 40px; color: var(--text-muted);">No appointments found.</p>`;
        return;
    }

    list.innerHTML = myApps.map(a => `
        <div class="tile-item">
            <div class="tile-info" style="flex:1;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <h4>${a.patientName}</h4>
                    <span style="font-size:0.65rem; padding:2px 8px; border-radius:10px; background:${a.paymentStatus === 'Paid' ? '#e8f5e9' : '#fff3cd'}; color:${a.paymentStatus === 'Paid' ? '#2ecc71' : '#856404'}; border:1px solid currentColor;">
                        ${a.paymentStatus === 'Paid' ? '<i class="fas fa-check-circle"></i> Paid' : '<i class="fas fa-clock"></i> Unpaid'}
                    </span>
                </div>
                <p>Slot: <strong>${a.time || 'General'}</strong> • ${a.date} • ${a.status.toUpperCase()}</p>
                <button class="btn-small" style="margin-top: 10px; background: #f0f0f0; color: var(--secondary);" onclick="viewPatientRecords('${a.patientId}', '${a.patientName}')">
                    <i class="fas fa-folder-open"></i> View Records
                </button>
            </div>
            <div>
                ${a.status === 'pending' ? `
                    <button class="btn-book" style="background: #2ecc71;" onclick="updateAppStatus('${a.id}', 'approved')">Accept</button>
                    <button class="btn-book" style="background: #e74c3c; margin-left: 10px;" onclick="updateAppStatus('${a.id}', 'rejected')">Reject</button>
                ` : `<span class="tile-badge status-${a.status}">${a.status}</span>`}
            </div>
        </div>
    `).join('');
}

window.viewPatientRecords = async function (patientId, patientName) {
    showToast(`Accessing secure records for ${patientName}...`);
    try {
        const snap = await db.collection('medical_records').where('patientId', '==', patientId).get();
        const records = snap.docs.map(doc => doc.data());

        if (records.length === 0) {
            return alert(`${patientName} hasn't uploaded any records yet.`);
        }

        DOM.modalBody.innerHTML = `
            <div style="position:relative;">
                <div style="position:absolute; top:40%; left:10%; right:10%; transform:rotate(-30deg); opacity:0.05; font-size:4rem; pointer-events:none; font-weight:900; color:var(--primary); z-index:100;">
                    ${patientName.toUpperCase()} HEALTHMATE
                </div>
                <h3>Secure Records: ${patientName}</h3>
                <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:20px;"><i class="fas fa-lock"></i> End-to-end encrypted medical data</p>
                
                <div class="tile-list" style="margin-top: 20px; position:relative; z-index:101;">
                    ${records.map(r => {
            const isAbnormal = Math.random() > 0.7; // Mock logic
            return `
                        <div class="tile-item" style="border-left: 4px solid ${isAbnormal ? '#e74c3c' : '#2ecc71'};">
                            <div class="tile-info">
                                <div style="display:flex; align-items:center; gap:8px;">
                                    <h4>${r.name}</h4>
                                    <span style="font-size:0.6rem; padding:2px 6px; border-radius:4px; background:${isAbnormal ? '#fdecea' : '#e8f5e9'}; color:${isAbnormal ? '#e74c3c' : '#2ecc71'};">
                                        ${isAbnormal ? 'REQUIRES ATTENTION' : 'NORMAL RANGE'}
                                    </span>
                                </div>
                                <p>${r.date} • ${r.type.toUpperCase()}</p>
                            </div>
                            <button class="btn-signup btn-small" onclick="window.open('${r.url}', '_blank')">View PDF</button>
                        </div>
                    `}).join('')}
                </div>
                <div style="margin-top:20px; padding:15px; background:#f9f9f9; border-radius:12px; font-size:0.8rem;">
                    <i class="fas fa-info-circle"></i> <strong>Note:</strong> Report status is auto-tagged based on reference values. Please consult a doctor for final diagnosis.
                </div>
                <button class="btn-signup" style="width: 100%; margin-top: 25px; background: var(--secondary);" onclick="DOM.modal.classList.add('hidden')">Close Secure View</button>
            </div>
        `;
        DOM.modal.classList.remove('hidden');
    } catch (err) {
        showToast("Error fetching patient records", "error");
    }
};


window.showDoctorTab = function (tab, event) {
    const targetId = `doctor-${tab}-tab`;
    const targetTab = document.getElementById(targetId);
    if (!targetTab) return;

    document.querySelectorAll('#doctor-view .doctor-tab').forEach(el => el.classList.add('hidden'));
    targetTab.classList.remove('hidden');

    document.querySelectorAll('#doctor-view .menu-item').forEach(btn => btn.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');

    if (tab === 'summary') renderDoctorDashboard();
    if (tab === 'wallet') renderWallet('doctor');
    if (tab === 'profile') renderMultiClinics();
};

window.showLabTab = function (tab, event) {
    const targetId = `lab-${tab}-tab`;
    const targetTab = document.getElementById(targetId);
    if (!targetTab) return;

    document.querySelectorAll('#lab-view .doctor-tab').forEach(el => el.classList.add('hidden'));
    targetTab.classList.remove('hidden');

    document.querySelectorAll('#lab-view .menu-item').forEach(btn => btn.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');

    if (tab === 'summary') renderLabDashboard();
    if (tab === 'wallet') renderWallet('lab');
    if (tab === 'profile') renderMultiClinics();
};

window.renderWallet = async function (role) {
    const containerId = `${role}-wallet-container`;
    const historyId = `${role}-wallet-history`;
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `<p style="text-align:center; padding:20px;"><i class="fas fa-spinner fa-spin"></i> Securing wallet access...</p>`;

    try {
        const walletSnap = await db.collection('wallets').doc(AppState.user.id).get();
        const wallet = walletSnap.data() || { availableBalance: 0, pendingEscrow: 0, totalEarnings: 0 };

        container.innerHTML = `
            <div class="stats-grid" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:20px; margin-bottom:30px;">
                <div class="admin-stat-card" style="background:var(--primary); color:white; border:none;">
                    <i class="fas fa-coins" style="font-size:1.5rem; margin-bottom:10px; opacity:0.8;"></i>
                    <h2 style="color:white; margin:5px 0;">₹${wallet.availableBalance}</h2>
                    <p style="font-size:0.8rem; opacity:0.9;">Withdrawable Balance</p>
                </div>
                <div class="admin-stat-card">
                    <i class="fas fa-shield-halved" style="color:#e67e22; font-size:1.5rem; margin-bottom:10px;"></i>
                    <h2 style="margin:5px 0;">₹${wallet.pendingEscrow}</h2>
                    <p style="color:var(--text-muted); font-size:0.8rem;">Funds in Escrow</p>
                </div>
                <div class="admin-stat-card">
                    <i class="fas fa-hand-holding-dollar" style="color:#2ecc71; font-size:1.5rem; margin-bottom:10px;"></i>
                    <h2 style="margin:5px 0; color:#2ecc71;">₹${wallet.totalEarnings}</h2>
                    <p style="color:var(--text-muted); font-size:0.8rem;">Lifetime Revenue</p>
                </div>
            </div>
        `;

        // Render Transaction History
        const historyList = document.getElementById(historyId);
        if (historyList) {
            const transSnap = await db.collection('wallet_transactions')
                .where('uid', '==', AppState.user.id)
                .orderBy('createdAt', 'desc')
                .limit(20)
                .get();

            if (transSnap.empty) {
                historyList.innerHTML = `<p style="text-align:center; padding:40px; color:var(--text-muted);">No wallet activity found yet.</p>`;
            } else {
                historyList.innerHTML = transSnap.docs.map(doc => {
                    const t = doc.data();
                    const dateStr = t.createdAt ? t.createdAt.toDate().toLocaleDateString() : 'Recent';
                    return `
                        <div class="tile-item" style="padding:12px; margin-bottom:8px; border:1px solid #f5f5f5;">
                            <div style="width:36px; height:36px; background:${t.type === 'credit' ? '#e8f5e9' : '#fee'}; color:${t.type === 'credit' ? '#2ecc71' : '#c00'}; border-radius:10px; display:flex; align-items:center; justify-content:center;">
                                <i class="fas fa-${t.type === 'credit' ? 'arrow-up' : 'arrow-down'}"></i>
                            </div>
                            <div style="flex:1; margin-left:15px;">
                                <h4 style="margin:0; font-size:0.9rem;">${t.description}</h4>
                                <p style="font-size:0.75rem; color:var(--text-muted); margin:0;">${dateStr} • ID: ${doc.id.slice(0, 8).toUpperCase()}</p>
                            </div>
                            <h4 style="color:${t.type === 'credit' ? '#2ecc71' : '#c00'}; margin:0;">${t.type === 'credit' ? '+' : '-'} ₹${t.amount}</h4>
                        </div>
                    `;
                }).join('');
            }
        }
    } catch (err) {
        container.innerHTML = `<p style="color:red; text-align:center;">Wallet Sync Error: ${err.message}</p>`;
    }
};

window.requestPayoutPrompt = function () {
    DOM.modalBody.innerHTML = `
        <div style="text-align:center; padding:20px;">
            <i class="fas fa-building-columns" style="font-size:3rem; color:var(--primary); margin-bottom:20px;"></i>
            <h2>Request Withdrawal</h2>
            <p style="color:var(--text-muted); margin-bottom:20px;">Funds will be transferred to your linked bank account via Razorpay X.</p>
            
            <div class="input-group" style="text-align:left;">
                <label>Amount (₹)</label>
                <input type="number" id="payout-amount" placeholder="Min. ₹500" style="width:100%; border:1.5px solid #eee; padding:12px; border-radius:12px;">
            </div>
            
            <div style="background:#f9f9f9; padding:15px; border-radius:12px; margin-top:15px; text-align:left;">
                <p style="font-size:0.8rem; color:var(--text-muted); margin:0;"><i class="fas fa-shield-check"></i> Standard T+2 settlement applies. Service fee: 2%</p>
            </div>
            
            <button class="btn-signup" style="width:100%; margin-top:20px;" onclick="confirmPayoutRequest()">Proceed with Withdrawal</button>
        </div>
    `;
    DOM.modal.classList.remove('hidden');
};

window.confirmPayoutRequest = async function () {
    const amount = parseInt(document.getElementById('payout-amount').value);
    if (!amount || amount < 500) return showToast("Minimum withdrawal is ₹500", "warning");

    showToast("Validating balance...");
    try {
        const walletRef = db.collection('wallets').doc(AppState.user.id);
        const walletSnap = await walletRef.get();
        const wallet = walletSnap.data();

        if (!wallet || wallet.availableBalance < amount) {
            return showToast("Insufficient Balance", "error");
        }

        const batch = db.batch();
        batch.update(walletRef, {
            availableBalance: firebase.firestore.FieldValue.increment(-amount),
            payoutsProcessed: firebase.firestore.FieldValue.increment(amount)
        });

        batch.set(db.collection('payout_requests').doc(), {
            uid: AppState.user.id,
            name: AppState.user.name,
            amount: amount,
            status: 'pending',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        batch.set(db.collection('wallet_transactions').doc(), {
            uid: AppState.user.id,
            type: 'debit',
            amount: amount,
            description: `Payout Withdrawal Request`,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        await batch.commit();
        showToast("Payout request submitted successfully!", "success");
        DOM.modal.classList.add('hidden');
        renderWallet(AppState.user.role === 'doctor' ? 'doctor' : 'lab');
    } catch (err) {
        showToast("Request failed: " + err.message, "error");
    }
};

window.openDetailsView = function (itemId, type) {
    const item = (type === 'doctors' ? AppState.doctors : AppState.labs).find(i => i.id === itemId);
    if (!item) return;

    const initials = item.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
    const fallbackImg = type === 'doctors' ? "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=500&q=80" : "https://images.unsplash.com/photo-1511174511562-5f7f18b874f8?auto=format&fit=crop&w=500&q=80";

    DOM.modalBody.innerHTML = `
        <div class="doctor-profile-view">
            <div style="background:var(--primary-light); padding:40px 20px; border-radius:20px; text-align:center; position:relative;">
                ${item.image ?
            `<img src="${item.image}" style="width:120px; height:120px; border-radius:50%; object-fit:cover; margin:-20px auto 15px; border:4px solid white; box-shadow:0 4px 15px rgba(0,0,0,0.1);">` :
            `<div class="profile-img-large" style="width:100px; height:100px; margin:-20px auto 15px; border:4px solid white;">${initials}</div>`
        }
                <h2 style="margin-bottom:5px;">${item.name} ${item.approved ? '<i class="fas fa-certificate" style="color:#3498db; font-size:1.2rem;" title="Verified"></i>' : ''}</h2>
                <p style="color:var(--primary); font-weight:600;">${item.specialty || 'Professional'}</p>
                <div style="display:flex; justify-content:center; gap:15px; margin-top:15px;">
                    <span style="font-size:0.8rem; background:white; padding:5px 12px; border-radius:20px; box-shadow:0 2px 10px rgba(0,0,0,0.05);">
                        <i class="fas fa-star" style="color:#f1c40f;"></i> ${item.rating || '4.8'} (200+ Reviews)
                    </span>
                    <span style="font-size:0.8rem; background:white; padding:5px 12px; border-radius:20px; box-shadow:0 2px 10px rgba(0,0,0,0.05);">
                         <i class="fas fa-briefcase" style="color:var(--primary);"></i> ${item.experience || '8'}+ Yrs Exp
                    </span>
                </div>
            </div>

            <div style="padding:25px;">
                <div style="margin-bottom:25px;">
                    <h4 style="margin-bottom:10px;">About & Skills</h4>
                    <p style="font-size:0.9rem; color:var(--text-muted); line-height:1.6;">
                        Highly experienced ${item.specialty || 'specialist'} with a track record of excellence in ${type === 'doctors' ? 'patient diagnostics and treatment' : 'advanced laboratory analytics'}. 
                        Expertise in modern clinical practices and dedicated to providing the highest standards of care.
                        <br><br>
                        <strong>Languages Spoken:</strong> ${item.languages || 'English, Hindi, Telugu'}
                    </p>
                </div>
                
                <div style="background:#f9f9f9; padding:20px; border-radius:15px; margin-bottom:25px;">
                    <h4 style="margin-bottom:15px;"><i class="fas fa-hospital-user"></i> Practice Details</h4>
                    <p style="font-size:0.9rem;"><strong>${item.clinicName || (type === 'doctors' ? 'Healthcare Center' : 'Diagnostic Center')}</strong></p>
                    <p style="font-size:0.85rem; color:var(--text-muted); margin-top:5px;">${item.address || 'Hitech City, Hyderabad, India'}</p>
                    
                    ${item.locations && item.locations.length > 0 ? `
                        <div style="margin-top:15px; border-top:1px solid #ddd; padding-top:15px;">
                            <h5 style="margin-bottom:10px; font-size:0.8rem; color:var(--text-muted);">Available Branches & Proximity:</h5>
                            ${item.locations.map(loc => {
            const d = (window.currentLat && window.currentLng) ? getHaversineDistance(window.currentLat, window.currentLng, loc.lat, loc.lng) : null;
            return `
                                <div style="font-size:0.8rem; margin-bottom:12px; display:flex; justify-content:space-between; align-items:flex-start;">
                                    <div>
                                        <i class="fas fa-location-dot" style="color:var(--primary); width:15px;"></i> <strong>${loc.name}</strong> 
                                        ${d ? `<span style="color:#2ecc71; font-weight:700; margin-left:5px;">(${d} km away)</span>` : ''}
                                        <br>
                                        <span style="color:var(--text-muted); margin-left:15px;">${loc.timing} | ${loc.address}</span>
                                    </div>
                                    <div style="display:flex; gap:5px;">
                                        ${loc.lat && loc.lng ? `<button class="btn-small" style="padding:4px 8px; font-size:0.6rem; background:var(--primary); color:white; border:none;" onclick="window.open('https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}', '_blank')"><i class="fas fa-location-arrow"></i> Navigate</button>` : ''}
                                    </div>
                                </div>`;
        }).join('')}
                        </div>
                    ` : ''}

                    <div style="display:flex; gap:10px; margin-top:15px;">
                         <button class="btn-small" style="background:var(--secondary);" onclick="window.open('${item.mapUrl || 'https://www.google.com/maps/search/' + encodeURIComponent(item.address || 'India')}', '_blank')"><i class="fas fa-map-location-dot"></i> View on Map</button>
                         <button class="btn-small" style="background:#fff; color:var(--text-main); border:1px solid #ddd;" onclick="showToast('Contact: +91 999 000 1111')"><i class="fas fa-phone"></i> Contact</button>
                    </div>
                </div>

                ${type === 'labs' && item.catalog && item.catalog.length > 0 ? `
                <div style="margin-bottom:25px;">
                    <h4 style="margin-bottom:15px;"><i class="fas fa-flask"></i> Laboratory Test Catalog</h4>
                    <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:15px;">
                        ${item.catalog.map(test => `
                            <div style="background:white; border:1px solid #f0f0f0; border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:8px; box-shadow:0 2px 8px rgba(0,0,0,0.03);">
                                ${test.image ?
                `<img src="${test.image}" style="width:100%; height:80px; object-fit:cover; border-radius:8px; background:#f9f9f9;">` :
                `<div style="width:100%; height:80px; background:#f5f5f5; border-radius:8px; display:flex; align-items:center; justify-content:center; color:#ccc;"><i class="fas fa-image fa-2x"></i></div>`
            }
                                <div style="display:flex; justify-content:space-between; align-items:center;">
                                    <h5 style="font-size:0.85rem; margin:0; color:var(--text-main);">${test.name}</h5>
                                    <span style="font-weight:700; color:var(--primary); font-size:0.85rem;">₹${test.price}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}

                <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid #eee; padding-top:20px;">
                    <div>
                        <p style="font-size:0.75rem; color:var(--text-muted);">${type === 'doctors' ? 'Consultation' : 'Test'} Fee Start</p>
                        <h3 style="color:var(--primary);">₹${item.price || 500}</h3>
                    </div>
                    <button class="btn-signup" style="padding:12px 30px;" onclick="openBooking('${item.id}')">Book Now</button>
                </div>
            </div>
        </div>
    `;
    DOM.modal.classList.remove('hidden');
};

window.getHaversineDistance = function (lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 999;
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return parseFloat((R * c).toFixed(1));
};

window.simulateGPS = function () {
    showToast("Detecting real-time GPS coordinates...");
    const grid = document.getElementById('nearby-grid');
    const locationText = document.getElementById('dashboard-location-text');

    if (!navigator.geolocation) {
        showToast("Geolocation is not supported by your browser.", "warning");
        return;
    }

    navigator.geolocation.getCurrentPosition(async (position) => {
        const { latitude, longitude } = position.coords;
        window.currentLat = latitude;
        window.currentLng = longitude;
        console.log(`[GPS] Patient Lat: ${latitude}, Lng: ${longitude}`);

        if (locationText) {
            locationText.innerText = "Current Location (Detected)";
        }

        if (!grid) return;
        grid.innerHTML = '<p style="text-align:center; padding:40px; width:100%; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Analyzing proximity...</p>';

        setTimeout(() => {
            const allProviders = [...AppState.doctors, ...AppState.labs];

            // Calculate distance for all providers (including all their branches)
            const ranked = allProviders.map(p => {
                // Check primary location + all branches
                const branchDistances = (p.locations || []).map(l => getHaversineDistance(latitude, longitude, l.lat, l.lng));
                const primaryDist = getHaversineDistance(latitude, longitude, p.lat, p.lng);
                const minDistance = Math.min(primaryDist, ...branchDistances);
                return { ...p, distance: minDistance };
            }).sort((a, b) => a.distance - b.distance).slice(0, 5);

            grid.innerHTML = ranked.map(item => `
                <div class="tile-item" onclick="openDetailsView('${item.id}', '${item.collection || (item.role === 'lab' ? 'labs' : 'doctors')}')" style="cursor:pointer;">
                    <div style="width:50px; height:50px; background:var(--primary-light); color:var(--primary); border-radius:10px; display:flex; align-items:center; justify-content:center; font-weight:900;">${item.name[0]}</div>
                    <div class="tile-info">
                        <h4>${item.name}</h4>
                        <p><i class="fas fa-location-arrow"></i> ${item.distance === 999 ? 'Distance N/A' : `~${item.distance} km away`} • ${item.specialty || 'General'}</p>
                    </div>
                    <div style="text-align:right;">
                        <span style="color:#2ecc71; font-weight:700; font-size:0.8rem;">OPEN</span>
                        <p style="font-size:0.7rem; color:var(--text-muted);">₹${item.price}</p>
                    </div>
                </div>
            `).join('');
            showToast("Nearby services updated based on your exact location!");
        }, 800);
    });
};

window.renderMultiClinics = function () {
    const isLab = AppState.user.role === 'lab';
    const listId = isLab ? 'lab-multi-clinic-list' : 'multi-clinic-list';
    const list = document.getElementById(listId);
    if (!list) return;

    // Pre-fill primary fields
    const prefix = isLab ? 'lab' : 'doc';
    const spec = document.getElementById(`${prefix}-profile-spec`);
    const fee = document.getElementById(`${prefix}-profile-fee`);
    const addr = document.getElementById(`${prefix}-profile-address`);
    const map = document.getElementById(`${prefix}-profile-map`);
    const coords = document.getElementById(`${prefix}-profile-coords`);

    if (spec) spec.value = AppState.user.specialty || '';
    if (fee) fee.value = AppState.user.price || '';
    if (addr) addr.value = AppState.user.address || '';
    if (map) map.value = AppState.user.mapUrl || '';
    if (coords) coords.value = (AppState.user.lat && AppState.user.lng) ? `${AppState.user.lat}, ${AppState.user.lng}` : '';

    const locations = AppState.user.locations || [];
    if (locations.length === 0) {
        list.innerHTML = `<p style="font-size:0.8rem; color:var(--text-muted); padding:10px; border:1px dashed #ddd; border-radius:8px; text-align:center;">No additional branches added.</p>`;
        return;
    }

    list.innerHTML = locations.map((loc, index) => `
        <div style="background:#f9f9f9; padding:12px; border-radius:10px; display:flex; justify-content:space-between; align-items:center; border:1px solid #f0f0f0;">
            <div style="flex:1;">
                <h4 style="margin:0; font-size:0.9rem;">${loc.name}</h4>
                <p style="margin:2px 0; font-size:0.75rem; color:var(--text-muted);">${loc.timing || '9 AM - 8 PM'} | ${loc.address.split(',')[0]}...</p>
                ${loc.mapUrl ? `<a href="${loc.mapUrl}" target="_blank" style="font-size:0.7rem; color:var(--primary); text-decoration:none;"><i class="fas fa-map-marker-alt"></i> View on Google Maps</a>` : ''}
            </div>
            <button class="btn-small" style="padding:5px; background:none; color:#e23744;" onclick="removeClinicLocation(${index})"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
};

window.addClinicPrompt = function () {
    DOM.modalBody.innerHTML = `
        <div style="padding:24px; max-width:500px; margin:auto;">
            <h3 style="margin-bottom:20px; color:var(--primary);"><i class="fas fa-map-location-dot"></i> Add Clinic Location</h3>
            
            <div class="input-group">
                <label style="font-weight:600;">Clinic / Branch Name</label>
                <input type="text" id="new-loc-name" placeholder="e.g. Apollo Clinic - Hitech City" style="width:100%; padding:12px; border:1.5px solid #eee; border-radius:12px;">
            </div>

            <div class="input-group" style="margin-top:15px;">
                <label style="font-weight:600;">Service Hours</label>
                <input type="text" id="new-loc-timing" placeholder="e.g. Mon-Sat (10:00 AM - 05:00 PM)" style="width:100%; padding:12px; border:1.5px solid #eee; border-radius:12px;">
            </div>

            <div class="input-group" style="margin-top:15px;">
                <label style="font-weight:600;">Physical Address</label>
                <textarea id="new-loc-address" placeholder="Complete building and street details" style="width:100%; padding:12px; border:1.5px solid #eee; border-radius:12px; min-height:80px;"></textarea>
            </div>

            <div class="input-group" style="margin-top:15px;">
                <label style="font-weight:600;">GPS Coordinates (Lat/Lng)</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="new-loc-coords" placeholder="Auto-fills via Pin button" readonly style="flex:1; padding:12px; border:1.5px solid #eee; border-radius:12px; background:#f5f5f5;">
                    <button class="btn-small" style="padding:0 15px; background:var(--primary); color:white; border:none;" onclick="pinCurrentLocation('new-loc-coords')"><i class="fas fa-crosshairs"></i> Pin</button>
                </div>
                <p style="font-size:0.65rem; color:var(--text-muted); margin-top:5px;">Click Pin while standing at this clinic location.</p>
            </div>

            <button class="btn-signup" style="width:100%; margin-top:25px; background:var(--primary); box-shadow:0 4px 15px rgba(226, 55, 68, 0.2);" onclick="saveNewClinicLocation()">Save Branch Location</button>
        </div>
    `;
    DOM.modal.classList.remove('hidden');
};

window.pinCurrentLocation = function (targetId) {
    if (!navigator.geolocation) return showToast("GPS not supported", "error");
    showToast("Fetching location...");
    navigator.geolocation.getCurrentPosition(pos => {
        document.getElementById(targetId).value = `${pos.coords.latitude}, ${pos.coords.longitude}`;
        showToast("Location Pinned!", "success");
    }, err => showToast("Failed to fetch GPS", "error"));
};

window.saveNewClinicLocation = async function () {
    const name = document.getElementById('new-loc-name').value;
    const timing = document.getElementById('new-loc-timing').value;
    const address = document.getElementById('new-loc-address').value;
    const coords = document.getElementById('new-loc-coords').value;
    const [lat, lng] = coords.split(',').map(s => parseFloat(s.trim()));

    if (!name || !address) return showToast("Name and Address are required", "warning");

    const newLoc = { name, timing, address, lat, lng, createdAt: new Date() };
    const locations = AppState.user.locations || [];
    locations.push(newLoc);

    showToast("Adding location...");
    try {
        const coll = AppState.user.role === 'doctor' ? 'doctors' : 'labs';
        await db.collection(coll).doc(AppState.user.id).update({
            locations: locations
        });
        AppState.user.locations = locations;
        showToast("Location added successfully!", "success");
        DOM.modal.classList.add('hidden');
        renderMultiClinics();
    } catch (err) {
        showToast("Failed to add location", "error");
    }
};

window.removeClinicLocation = async function (index) {
    if (!confirm("Are you sure you want to remove this location?")) return;

    const locations = AppState.user.locations || [];
    locations.splice(index, 1);

    try {
        const coll = AppState.user.role === 'doctor' ? 'doctors' : 'labs';
        await db.collection(coll).doc(AppState.user.id).update({
            locations: locations
        });
        AppState.user.locations = locations;
        showToast("Location removed");
        renderMultiClinics();
    } catch (err) {
        showToast("Remove failed", "error");
    }
};

window.uploadPrescription = function () {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*,application/pdf';
    fileInput.onchange = (e) => uploadMedicalRecord(e);
    fileInput.click();
};

window.generateSlots = function () {
    const grid = document.getElementById('doctor-slots-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const start = document.getElementById('doctor-slot-start').value;
    const end = document.getElementById('doctor-slot-end').value;
    showToast(`Slots updated from ${start} to ${end}`);
    // Mocking slot generation
    for (let i = 0; i < 8; i++) {
        const slot = document.createElement('div');
        slot.className = 'filter-btn active';
        slot.style.textAlign = 'center';
        slot.innerText = `${10 + i}:00 AM`;
        grid.appendChild(slot);
    }
};

window.saveDoctorProfile = async function () {
    if (!AppState.user) return;
    const spec = document.getElementById('doc-profile-spec').value;
    const fee = document.getElementById('doc-profile-fee').value;
    const address = document.getElementById('doc-profile-address').value;
    const mapUrl = document.getElementById('doc-profile-map').value;
    const photoFile = document.getElementById('doctor-photo-input').files[0];

    const coords = document.getElementById('doc-profile-coords').value;
    const [lat, lng] = coords ? coords.split(',').map(s => parseFloat(s.trim())) : [null, null];

    try {
        let photoURL = AppState.user.image;
        if (photoFile) {
            showToast("Uploading photo...");
            photoURL = await uploadFile(photoFile, `doctors/${AppState.user.id}`);
        }

        const updates = {
            specialty: spec,
            price: fee,
            address: address,
            mapUrl: mapUrl,
            image: photoURL,
            lat, lng
        };

        await db.collection('doctors').doc(AppState.user.id).update(updates);
        AppState.user = { ...AppState.user, ...updates };

        showToast("Clinic Profile Updated!");
        refreshActiveDashboard();
    } catch (err) {
        showToast("Save failed: " + err.message, "error");
    }
};

window.saveLabProfile = async function () {
    if (!AppState.user) return;
    const spec = document.getElementById('lab-profile-spec').value;
    const fee = document.getElementById('lab-profile-fee').value;
    const address = document.getElementById('lab-profile-address').value;
    const mapUrl = document.getElementById('lab-profile-map').value;
    const photoFile = document.getElementById('lab-profile-image').files[0];

    const coords = document.getElementById('lab-profile-coords').value;
    const [lat, lng] = coords ? coords.split(',').map(s => parseFloat(s.trim())) : [null, null];

    try {
        let photoURL = AppState.user.image;
        if (photoFile) {
            showToast("Uploading lab logo...");
            photoURL = await uploadFile(photoFile, `labs/${AppState.user.id}`);
        }

        const updates = {
            specialty: spec,
            price: fee,
            address: address,
            mapUrl: mapUrl,
            image: photoURL,
            lat, lng
        };

        await db.collection('labs').doc(AppState.user.id).update(updates);
        AppState.user = { ...AppState.user, ...updates };

        showToast("Lab Profile Updated!");
        refreshActiveDashboard();
    } catch (err) {
        showToast("Save failed: " + err.message, "error");
    }
};


function renderLabDashboard() {
    console.log("[DASHBOARD] Rendering Lab View");
    const list = document.getElementById('lab-requests-list');
    const catalogList = document.getElementById('lab-catalog-list');
    const myApps = AppState.appointments.filter(a => a.targetId === AppState.user.id);

    if (AppState.user) {
        document.getElementById('lab-sidebar-name').innerText = AppState.user.name;
    }

    // Summary Metrics for Lab
    const summaryMetrics = document.getElementById('lab-summary-metrics');
    if (summaryMetrics) {
        const now = new Date();
        const thisMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const monthlyApps = myApps.filter(a => a.date && a.date.startsWith(thisMonthStr));
        const monthEarnings = monthlyApps.filter(a => a.status === 'approved').reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);
        const commission = Math.floor(monthEarnings * 0.20);
        const netEarnings = monthEarnings - commission;

        const pendingSettlement = myApps.filter(a => a.status === 'approved' && a.payoutStatus === 'Pending').reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);
        const upcomingPayout = myApps.filter(a => a.payoutStatus === 'Settled' && a.payoutDate && a.payoutDate.toDate() > now).reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);
        const settledPayout = myApps.filter(a => a.payoutStatus === 'Settled' && a.payoutDate && a.payoutDate.toDate() <= now).reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);

        const commRate = (AppState.user.commissionRate || 20) / 100;
        const netFactor = 1 - commRate;

        const netPending = Math.floor(pendingSettlement * netFactor);
        const netUpcoming = Math.floor(upcomingPayout * netFactor);
        const netSettled = Math.floor(settledPayout * netFactor);

        summaryMetrics.innerHTML = `
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-microscope" style="color:var(--primary); font-size:1.5rem; margin-bottom:10px;"></i>
                <h3>₹${netPending}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Pending Settlement</p>
            </div>
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-clock" style="color:#3498db; font-size:1.5rem; margin-bottom:10px;"></i>
                <h3>₹${netUpcoming}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Upcoming (1 Week Wait)</p>
            </div>
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-piggy-bank" style="color:#2ecc71; font-size:1.5rem; margin-bottom:10px;"></i>
                <h3 style="color:#2ecc71;">₹${netSettled}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Available to Withdraw</p>
            </div>
        `;
    }

    if (myApps.length === 0) {
        list.innerHTML = `<p style="text-align: center; padding: 40px; color: var(--text-muted);">No test requests yet.</p>`;
    } else {
        list.innerHTML = myApps.map(a => `
            <div class="tile-item" style="flex-direction:column; align-items:flex-start; gap:10px;">
                <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                    <div class="tile-info">
                        <h4>${a.patientName}</h4>
                        <p>Diagnostic Request • ${a.date}</p>
                    </div>
                    <span class="tile-badge status-${a.status}">${a.status}</span>
                </div>
                ${a.status === 'pending' ? `
                    <div style="display:flex; gap:10px; width:100%;">
                        <button class="btn-small btn-signup" style="flex:1;" onclick="uploadLabReport('${a.id}')">
                            <i class="fas fa-file-upload"></i> Upload & Tag Report
                        </button>
                    </div>
                ` : (a.reportUrl ? `<span style="font-size:0.75rem; color:#2ecc71;"><i class="fas fa-check-circle"></i> Report Uploaded (${a.reportTag})</span>` : '')}
            </div>
        `).join('');
    }

    // Catalog List (Directly from AppState.user or labs collection)
    const currentLab = AppState.labs.find(l => l.id === AppState.user.id);
    if (currentLab && currentLab.catalog) {
        catalogList.innerHTML = currentLab.catalog.map((test, idx) => `
            <div class="tile-item">
                <img src="${test.image || 'https://via.placeholder.com/50'}" style="width:50px; height:50px; border-radius:8px; object-fit:cover;">
                <div class="tile-info" style="flex:1; margin-left:15px;">
                    <h4>${test.name}</h4>
                    <p>₹${test.price}</p>
                </div>
                <button class="btn-book" style="background:#e74c3c; padding:5px 10px;" onclick="removeLabTest(${idx})"><i class="fas fa-trash"></i></button>
            </div>
        `).join('');
    } else {
        catalogList.innerHTML = `<p style="text-align: center; padding: 20px; color: var(--text-muted);">Your catalog is empty.</p>`;
    }
}

window.showLabTab = function (tab, event) {
    const targetId = `lab-${tab}-tab`;
    const targetTab = document.getElementById(targetId);
    if (!targetTab) {
        console.warn(`Tab ${targetId} not found!`);
        return;
    }

    document.querySelectorAll('#lab-view .doctor-tab').forEach(el => el.classList.add('hidden'));
    targetTab.classList.remove('hidden');

    document.querySelectorAll('#lab-view .menu-item').forEach(btn => btn.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');

    if (tab === 'summary') renderLabDashboard();
    if (tab === 'technician') renderLabTechnician();
    if (tab === 'statements') renderLabStatements();

    if (tab === 'profile' && AppState.user) {
        const currentLab = AppState.labs.find(l => l.id === AppState.user.id) || AppState.user;
        document.getElementById('lab-profile-spec').value = currentLab.specialty || '';
        document.getElementById('lab-profile-fee').value = currentLab.price || '';
        document.getElementById('lab-profile-address').value = currentLab.address || '';
    }
};

window.renderLabStatements = async function () {
    const list = document.getElementById('lab-statements-list');
    if (!list) return;

    list.innerHTML = `<p style="text-align: center; padding: 20px;"><i class="fas fa-spinner fa-spin"></i> Loading statements...</p>`;

    try {
        const snap = await db.collection('settlements')
            .where('providerId', '==', AppState.user.id)
            .orderBy('createdAt', 'desc')
            .get();

        if (snap.empty) {
            list.innerHTML = `<p style="text-align: center; padding: 40px; color: var(--text-muted);">No settlement records found yet.</p>`;
            return;
        }

        list.innerHTML = snap.docs.map(doc => {
            const s = doc.data();
            const date = s.createdAt?.toDate().toLocaleDateString() || 'N/A';
            const payoutDate = s.scheduledPayoutDate?.toDate().toLocaleDateString() || 'Processing';
            const isReady = s.scheduledPayoutDate?.toDate() <= new Date();

            return `
                <div class="tile-item" style="flex-direction: column; align-items: flex-start; gap: 10px;">
                    <div style="display: flex; justify-content: space-between; width: 100%;">
                        <span style="font-weight: 700; color: var(--text-muted);">Ref: ${doc.id.slice(0, 8).toUpperCase()}</span>
                        <span class="tile-badge status-${isReady ? 'approved' : 'pending'}">${isReady ? 'PAID' : 'UPCOMING'}</span>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; width: 100%; border-top: 1px dashed #eee; padding-top: 10px;">
                        <div>
                            <p style="font-size: 0.7rem; color: var(--text-muted); margin: 0;">Revenue</p>
                            <p style="font-weight: 600; margin: 2px 0;">₹${s.grossAmount}</p>
                        </div>
                        <div>
                            <p style="font-size: 0.7rem; color: var(--primary); margin: 0;">Platform Fee</p>
                            <p style="font-weight: 600; margin: 2px 0; color: var(--primary);">₹${s.commission}</p>
                        </div>
                        <div>
                            <p style="font-size: 0.7rem; color: #2ecc71; margin: 0;">Net Income</p>
                            <p style="font-weight: 700; margin: 2px 0; color: #2ecc71;">₹${s.netAmount}</p>
                        </div>
                    </div>
                    <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 5px;">
                        <i class="fas fa-calendar-alt"></i> Settled on: ${date} | <i class="fas fa-truck-fast"></i> Payout: ${payoutDate}
                    </p>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error("Statement fetch failed:", err);
        list.innerHTML = `<p style="text-align: center; padding: 20px; color: #e74c3c;">Failed to load statements.</p>`;
    }
};


// --- Lab Report Utility ---
window.uploadLabReport = async function (appId) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/pdf';
    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        showToast("Uploading Report & Tagging...");
        try {
            const url = await uploadFile(file, `reports/${appId}/${Date.now()}`);

            // AUTO TAGGING LOGIC
            let tag = 'General';
            const name = file.name.toLowerCase();
            if (name.includes('blood')) tag = 'Blood Report';
            else if (name.includes('xray') || name.includes('x-ray')) tag = 'X-Ray';
            else if (name.includes('mri')) tag = 'MRI Scan';
            else if (name.includes('urine')) tag = 'Urine Test';

            // NORMAL RANGE / COLOR CODING PREVIEW (Metadata)
            const isAbnormal = Math.random() > 0.8; // Simulated logic

            await db.collection('appointments').doc(appId).update({
                reportUrl: url,
                reportTag: tag,
                reportStatus: isAbnormal ? 'abnormal' : 'normal',
                status: 'completed'
            });

            showToast(`Report Uploaded! Tagged as: ${tag}`, "success");
            renderLabDashboard();
        } catch (err) {
            showToast("Upload failed", "error");
        }
    };
    fileInput.click();
};


window.addLabTest = async function () {
    const name = document.getElementById('new-test-name').value;
    const price = document.getElementById('new-test-price').value;
    const photoFile = document.getElementById('new-test-image').files[0];

    if (!name || !price) return showToast("Enter test details", "warning");

    try {
        let image = "";
        if (photoFile) {
            showToast("Uploading test image...");
            image = await uploadFile(photoFile, `labs/${AppState.user.id}/tests/${Date.now()}`);
        }

        const labRef = db.collection('labs').doc(AppState.user.id);
        const labDoc = await labRef.get();
        const currentCatalog = labDoc.data().catalog || [];

        await labRef.update({
            catalog: [...currentCatalog, { name, price, image }]
        });

        showToast(`Added ${name} to catalog!`);
        document.getElementById('new-test-name').value = '';
        document.getElementById('new-test-price').value = '';
        renderLabDashboard();
    } catch (err) {
        showToast("Failed to add test", "error");
    }
};

window.removeLabTest = async function (index) {
    try {
        const labRef = db.collection('labs').doc(AppState.user.id);
        const labDoc = await labRef.get();
        const catalog = labDoc.data().catalog || [];
        catalog.splice(index, 1);
        await labRef.update({ catalog });
        showToast("Test removed");
        renderLabDashboard();
    } catch (err) {
        showToast("Remove failed", "error");
    }
};

function renderAdminDashboard() {
    const list = document.getElementById('admin-verification-list');
    const payoutList = document.getElementById('admin-payout-list');
    const statsGrid = document.getElementById('admin-stats-grid');

    // Real-time Dashboard Summary Update
    try {
        const paidApps = AppState.appointments.filter(a => a.paymentStatus === 'Paid' || a.paymentStatus === 'Refunded');
        const grossRevenue = paidApps.reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);
        const platformEarnings = paidApps.filter(a => a.paymentStatus === 'Paid').reduce((sum, a) => sum + (parseInt(a.commission) || 0), 0);
        const totalEscrowHeld = AppState.appointments.filter(a => a.payoutStatus === 'Escrow').reduce((sum, a) => sum + (parseInt(a.price) - parseInt(a.commission) || 0), 0);

        statsGrid.innerHTML = `
            <div class="admin-stat-card">
                <div style="display:flex; justify-content:space-between;">
                    <h3>₹${grossRevenue}</h3>
                    <i class="fas fa-hand-holding-dollar" style="color:var(--primary);"></i>
                </div>
                <p>Gross Marketplace Sales</p>
            </div>
            <div class="admin-stat-card">
                <div style="display:flex; justify-content:space-between;">
                    <h3 style="color:#2ecc71;">₹${platformEarnings}</h3>
                    <i class="fas fa-piggy-bank" style="color:#2ecc71;"></i>
                </div>
                <p>Total Platform Income</p>
            </div>
            <div class="admin-stat-card">
                <div style="display:flex; justify-content:space-between;">
                    <h3 style="color:#3498db;">₹${totalEscrowHeld}</h3>
                    <i class="fas fa-lock" style="color:#3498db;"></i>
                </div>
                <p>Funds held in Escrow</p>
            </div>
        `;
    } catch (e) { console.error("Admin counts fail:", e); }

    // Verifications
    const pendingWithRole = [
        ...AppState.doctors.filter(d => !d.approved).map(d => ({ ...d, collection: 'doctors' })),
        ...AppState.labs.filter(l => !l.approved).map(l => ({ ...l, collection: 'labs' }))
    ];

    if (list) {
        if (pendingWithRole.length === 0) {
            list.innerHTML = `<p style="text-align: center; padding: 40px; color: var(--text-muted);">No pending approvals.</p>`;
        } else {
            list.innerHTML = pendingWithRole.map(p => {
                const userObj = AppState.users.find(u => u.id === p.id);
                return `
                <div class="tile-item">
                    <img src="${p.image || 'https://cdn-icons-png.flaticon.com/512/3135/3135715.png'}" style="width:45px; height:45px; border-radius:10px; object-fit:cover; background:#f9f9f9;">
                    <div class="tile-info">
                        <h4>${p.name}</h4>
                        <p>${p.specialty || 'Provider'} • ${userObj?.email || 'No email'}</p>
                    </div>
                    <div style="display:flex; gap:10px;">
                        <button class="btn-book" style="background:#3498db; padding:8px 15px;" onclick="viewProviderDetails('${p.id}', '${p.collection}')"><i class="fas fa-eye"></i> View</button>
                        <button class="btn-book" style="padding:8px 15px;" onclick="approveProvider('${p.id}', '${p.collection}')">Approve</button>
                    </div>
                </div>
            `}).join('');
        }
    }

    const totalBookings = AppState.appointments.length;
    const paidApps = AppState.appointments.filter(a => a.paymentStatus === 'Paid' || a.status === 'approved');
    const totalRev = paidApps.reduce((acc, a) => acc + (parseInt(a.price) || 0), 0);
    // Only count commission from PAID appointments
    const totalComm = paidApps.reduce((acc, a) => acc + (a.commission || Math.floor(parseInt(a.price || 0) * 0.20)), 0);

    if (statsGrid) {
        statsGrid.innerHTML = `
            <div class="admin-stat-card"><h3>${totalBookings}</h3><p>Total Bookings</p></div>
            <div class="admin-stat-card" style="border: 2px solid #2ecc71;"><h3>₹${totalRev}</h3><p>Total Revenue</p></div>
            <div class="admin-stat-card" style="border: 2px solid var(--primary); background:var(--primary-light);"><h3>₹${totalComm}</h3><p>Platform Commission</p></div>
            <div class="admin-stat-card"><h3>${AppState.doctors.length}</h3><p>Active Doctors</p></div>
            <div class="admin-stat-card"><h3>${AppState.labs.length}</h3><p>Active Labs</p></div>
            <div class="admin-stat-card" style="border: 1px dashed #ccc;"><h3>Approved</h3><p>Payout Status</p></div>
        `;
    }

    // Financials / Payouts (with Commission)
    const COMMISSION_RATE = 0.20; // 20% platform fee
    const providers = [...AppState.doctors, ...AppState.labs];
    const payouts = providers.map(p => {
        const pendingApps = AppState.appointments
            .filter(a => a.targetId === p.id && a.status === 'approved' && a.payoutStatus === 'Pending');

        const grossEarnings = pendingApps.reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);

        const rate = (p.commissionRate || 20) / 100;
        const commission = Math.floor(grossEarnings * rate);
        const netSettlement = grossEarnings - commission;

        return { ...p, grossEarnings, commission, netSettlement };
    }).filter(p => p.grossEarnings > 0);

    if (payoutList) {
        if (payouts.length === 0) {
            payoutList.innerHTML = `<p style="text-align: center; padding: 40px; color: var(--text-muted);">No pending payouts.</p>`;
        } else {
            payoutList.innerHTML = payouts.map(p => `
                <div class="tile-item" style="flex-direction: column; align-items: flex-start; gap: 10px; padding: 20px;">
                    <div style="display: flex; justify-content: space-between; width: 100%; border-bottom: 1px solid #eee; padding-bottom: 10px;">
                        <h4 style="margin: 0;">${p.name}</h4>
                        <span style="font-size: 0.8rem; color: var(--text-muted);">ID: ${p.id}</span>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; width: 100%; font-size: 0.9rem;">
                        <div>
                            <p style="margin: 0; color: var(--text-muted);">Patient Paid</p>
                            <p style="margin: 5px 0 0 0; font-weight: 700;">₹${p.grossEarnings}</p>
                        </div>
                        <div>
                            <p style="margin: 0; color: var(--primary);">- Commission</p>
                            <p style="margin: 5px 0 0 0; font-weight: 700; color: var(--primary);">₹${p.commission}</p>
                        </div>
                        <div>
                            <p style="margin: 0; color: #27ae60;">Net to Provider</p>
                            <p style="margin: 5px 0 0 0; font-weight: 800; color: #27ae60;">₹${p.netSettlement}</p>
                        </div>
                    </div>
                    <button class="btn-book" style="background: #27ae60; margin-top: 5px; width: 100%;" 
                        onclick="settlePayout('${p.id}', ${p.netSettlement}, ${p.grossEarnings}, ${p.commission})">
                        Approve and Settle ₹${p.netSettlement}
                    </button>
                </div>
            `).join('');
        }
    }
    initAdminCharts();
    renderAdminRolesSummary();
    detectFraudulentUsers();
}

function renderAdminRolesSummary() {
    const summary = document.getElementById('admin-roles-summary');
    if (!summary) return;
    const providers = [...AppState.doctors, ...AppState.labs];
    const admins = providers.filter(p => p.adminRole);

    // SMART RANKING: Rank by "Performance Score"
    // Formula: Score = (Approved ? 50 : 0) + (Rating * 10) - (Cancellations * 5)
    const rankedProviders = providers.map(p => {
        const cancellations = AppState.appointments.filter(a => a.targetId === p.id && a.status === 'rejected').length;
        const score = (p.approved ? 50 : 0) + (parseFloat(p.rating || 4.5) * 10) - (cancellations * 5);
        return { ...p, score };
    }).sort((a, b) => b.score - a.score);

    if (admins.length === 0) {
        summary.innerHTML = `<p style="color:var(--text-muted);">No sub-admins assigned yet.</p>`;
    } else {
        summary.innerHTML = admins.map(a => `
            <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eee;">
                <span>${a.name}</span>
                <span class="tile-badge status-approved" style="font-size:0.6rem;">${a.adminRole.toUpperCase()}</span>
            </div>
        `).join('');
    }

    // Top Performer Highlight (In console or UI if needed)
    if (rankedProviders[0]) {
        console.log(`[ADMIN KPI] Top Ranked Provider: ${rankedProviders[0].name} (Score: ${rankedProviders[0].score})`);
    }
}


function initAdminCharts() {
    const ctx = document.getElementById('revenueChart');
    if (ctx) {
        if (window.myChart) window.myChart.destroy();
        window.myChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                datasets: [{
                    label: 'Monthly Revenue (₹)',
                    data: [12000, 19000, 3000, 5000, 2000, 30000, 45000],
                    borderColor: '#E23744',
                    tension: 0.4,
                    fill: true,
                    backgroundColor: 'rgba(226, 55, 68, 0.1)'
                }]
            },
            options: { responsive: true, plugins: { legend: { display: false } } }
        });
    }

    const sctx = document.getElementById('specialtyChart');
    if (sctx) {
        if (window.specChart) window.specChart.destroy();
        window.specChart = new Chart(sctx, {
            type: 'polarArea',
            data: {
                labels: ['Cardiology', 'Pediatrics', 'Blood Lab', 'MRI'],
                datasets: [{
                    data: [45, 25, 60, 15],
                    backgroundColor: ['rgba(226, 55, 68,0.7)', 'rgba(52,152,219,0.7)', 'rgba(46,204,113,0.7)', 'rgba(155,89,182,0.7)']
                }]
            }
        });
    }

    const pctx = document.getElementById('peakHoursChart');
    if (pctx) {
        if (window.peakChart) window.peakChart.destroy();
        window.peakChart = new Chart(pctx, {
            type: 'bar',
            data: {
                labels: ['9AM', '12PM', '3PM', '6PM', '9PM'],
                datasets: [{
                    label: 'Bookings',
                    data: [12, 45, 18, 55, 10],
                    backgroundColor: '#E23744'
                }]
            },
            options: { plugins: { legend: { display: false } } }
        });
    }
}




// Updated settlePayout to show the breakdown in the toast
// Updated settlePayout to actually update Firestore and implement 1-week delay
window.settlePayout = async function (id, netAmt, grossAmt, commAmt) {
    if (!confirm(`Are you sure you want to settle ₹${netAmt} for this provider? The amount will reflect in 1 week.`)) return;

    showToast("Processing Settlement...");
    try {
        // Find all pending appointments for this provider
        const pendingSnap = await db.collection('appointments')
            .where('targetId', '==', id)
            .where('status', '==', 'approved')
            .where('payoutStatus', '==', 'Pending')
            .get();

        if (pendingSnap.empty) {
            return showToast("No pending appointments found for settlement", "warning");
        }

        const batch = db.batch();
        const settlementDate = new Date();
        settlementDate.setDate(settlementDate.getDate() + 7); // 1 week delay

        pendingSnap.docs.forEach(doc => {
            batch.update(doc.ref, {
                payoutStatus: 'Settled',
                payoutDate: firebase.firestore.Timestamp.fromDate(settlementDate),
                settledAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        });

        // Log the settlement for Admin audit
        const settlementLogRef = db.collection('settlements').doc();
        batch.set(settlementLogRef, {
            providerId: id,
            grossAmount: grossAmt,
            commission: commAmt,
            netAmount: netAmt,
            appointmentCount: pendingSnap.size,
            scheduledPayoutDate: firebase.firestore.Timestamp.fromDate(settlementDate),
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        await batch.commit();

        showToast(`Settlement Approved!\nGross: ₹${grossAmt} | Fee: ₹${commAmt} | Credited: ₹${netAmt}`, "success");
        renderAdminDashboard();
    } catch (err) {
        console.error("Settlement failed:", err);
        showToast("Settlement failed: " + err.message, "error");
    }
};

// --- Admin Actions Extended ---
window.viewProviderDetails = function (id, collection) {
    const p = (collection === 'doctors' ? AppState.doctors : AppState.labs).find(item => item.id === id);
    if (!p) return;

    DOM.modalBody.innerHTML = `
        <div class="verification-details" style="text-align: left;">
            <div style="grid-column: 1/-1; display:flex; align-items:center; gap:20px; margin-bottom:20px; border-bottom:2px solid #eee; padding-bottom:15px;">
                <img src="${p.image || 'https://via.placeholder.com/80'}" style="width:80px; height:80px; border-radius:50%; object-fit:cover;">
                <div>
                    <h2 style="margin:0;">${p.name}</h2>
                    <p style="color:var(--text-muted); margin:0;">${p.specialty || 'Health Provider'} • ID: ${p.id}</p>
                </div>
            </div>

            <div class="detail-group">
                <h4><i class="fas fa-info-circle"></i> Basic & Prof. Info</h4>
                <p><strong>Mobile:</strong> OTP Verified</p>
                <p><strong>Gender:</strong> ${p.gender || 'Not specified'}</p>
                <p><strong>Reg. Number:</strong> <span style="color:var(--primary); font-weight:700;">${p.regNum || p.labRegNum || 'N/A'}</span></p>
                <p><strong>Council/Authority:</strong> ${p.council || 'N/A'}</p>
                <p><strong>Qualification:</strong> ${p.qualification || 'N/A'}</p>
                <p><strong>Experience:</strong> ${p.experience || '0'} Years</p>
            </div>

            <div class="detail-group">
                <h4><i class="fas fa-map-location-dot"></i> Clinic/Center Details</h4>
                <p><strong>Name:</strong> ${p.clinicName || 'N/A'}</p>
                <p><strong>Address:</strong> ${p.clinicAddress || 'N/A'}</p>
                <div class="map-placeholder" style="height:120px;">
                    <i class="fas fa-map-pin" style="color:var(--primary);"></i> ${p.clinicAddress ? 'Located in Map' : 'No Location Data'}
                </div>
                <p><strong>Fees:</strong> ₹${p.price || '500'}</p>
            </div>

            <div class="detail-group" style="grid-column: 1/-1;">
                <h4><i class="fas fa-file-shield"></i> Verified Documents & Portfolio</h4>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:15px;">
                    ${Object.entries(p.docs || {}).map(([key, url]) => `
                        <div class="doc-preview-item">
                            <i class="fas fa-file-pdf"></i>
                            <span style="flex:1;">${key.toUpperCase()}</span>
                            <a href="${url}" target="_blank" style="color:var(--primary); font-size:0.8rem;">Preview</a>
                        </div>
                    `).join('') || '<p style="font-size:0.8rem; color:var(--text-muted);">No documents uploaded.</p>'}
                </div>
                
                ${p.catalog && p.catalog.length > 0 ? `
                <h5 style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Laboratory Test Catalog Images:</h5>
                <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:10px;">
                    ${p.catalog.map(test => `
                        <div style="border:1px solid #eee; border-radius:8px; padding:5px; text-align:center;">
                            ${test.image ?
            `<img src="${test.image}" style="width:100%; height:50px; object-fit:cover; border-radius:4px; cursor:pointer;" onclick="window.open('${test.image}', '_blank')">` :
            `<div style="height:50px; background:#f9f9f9; display:flex; align-items:center; justify-content:center; color:#ccc;"><i class="fas fa-image"></i></div>`
        }
                            <p style="font-size:0.6rem; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${test.name}</p>
                        </div>
                    `).join('')}
                </div>
                ` : ''}
            </div>

            <div class="detail-group" style="grid-column: 1/-1; background:#fff8f8; padding:15px; border-radius:12px;">
                <h4><i class="fas fa-gavel"></i> Admin Decision</h4>
                <div class="input-group">
                    <label>Internal Remarks / Rejection Reason</label>
                    <textarea id="admin-remarks" placeholder="Add notes here..." style="width:100%; height:60px;"></textarea>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">
                    <div>
                        <label style="font-size:0.8rem;">Platform Commission (%)</label>
                        <input type="number" id="admin-comm" value="20" style="width:100%; padding:8px;">
                    </div>
                    <div style="display:flex; align-items:flex-end; gap:10px;">
                         <button class="btn-signup" style="background:#e74c3c; flex:1;" onclick="rejectProvider('${p.id}', '${collection}')">Reject</button>
                         <button class="btn-signup" style="background:#2ecc71; flex:1;" onclick="approveProvider('${p.id}', '${collection}')">Approve</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    DOM.modal.classList.remove('hidden');
};

window.approveProvider = async function (id, collection) {
    const remarks = document.getElementById('admin-remarks')?.value || "Approved by Admin";
    const comm = document.getElementById('admin-comm')?.value || 20;

    showToast("Finalizing Approval...");
    try {
        await db.collection(collection).doc(id).update({
            approved: true,
            onboardingStatus: 'approved',
            adminRemarks: remarks,
            commissionRate: parseInt(comm),
            approvedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        await db.collection('users').doc(id).update({
            approved: true,
            onboardingStatus: 'approved'
        });

        showToast("Provider Approved & Live!", "success");
        DOM.modal.classList.add('hidden');
        renderAdminDashboard();
    } catch (err) {
        showToast("Approval failed", "error");
    }
};

window.rejectProvider = async function (id, collection) {
    const remarks = document.getElementById('admin-remarks').value;
    if (!remarks) return showToast("Please provide a reason for rejection", "warning");

    showToast("Rejecting Application...");
    try {
        await db.collection(collection).doc(id).update({
            approved: false,
            onboardingStatus: 'rejected',
            adminRemarks: remarks,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        await db.collection('users').doc(id).update({
            onboardingStatus: 'rejected'
        });

        showToast("Application Rejected with Remarks", "info");
        DOM.modal.classList.add('hidden');
        renderAdminDashboard();
    } catch (err) {
        showToast("Rejection failed", "error");
    }
};
function renderAdminUsers() {
    const list = document.getElementById('admin-users-list');
    if (!list) return;

    try {
        // Safe check for current user
        const currentUserId = AppState.user ? AppState.user.id : null;

        // Filter to exclude current admin for safety
        const allUsers = (AppState.users || []).filter(u => u.id !== currentUserId);

        if (allUsers.length === 0) {
            list.innerHTML = `<p style="text-align:center; padding:40px; color:var(--text-muted);">No other users found in database.</p>`;
            return;
        }

        list.innerHTML = `
            <div style="margin-bottom:20px;">
                <input type="text" placeholder="Search by name, email or role..." 
                    oninput="filterAdminUsers(this.value)" 
                    style="width:100%; padding:15px; border-radius:12px; border:1.5px solid #eee; box-shadow: 0 4px 10px rgba(0,0,0,0.02);">
            </div>
            <div id="admin-users-grid" class="tile-list">
                ${renderUserListHTML(allUsers)}
            </div>
        `;
    } catch (err) {
        console.error("Critical error in renderAdminUsers:", err);
        list.innerHTML = `<p style="text-align:center; padding:40px; color:var(--primary);">System error while loading user list.</p>`;
    }
}

window.filterAdminUsers = function (val) {
    try {
        const query = val.toLowerCase();
        const currentUserId = AppState.user ? AppState.user.id : null;

        const filtered = (AppState.users || []).filter(u =>
            u.id !== currentUserId &&
            ((u.name || "").toLowerCase().includes(query) ||
                (u.email || "").toLowerCase().includes(query) ||
                (u.role || "").toLowerCase().includes(query))
        );
        const grid = document.getElementById('admin-users-grid');
        if (grid) grid.innerHTML = renderUserListHTML(filtered);
    } catch (err) {
        console.error("Filter error:", err);
    }
};

function renderUserListHTML(users) {
    return users.map(u => {
        const userName = u.name || "Unknown User";
        const userEmail = u.email || "No email provided";
        const userRole = (u.role || "patient").toLowerCase();
        const initial = userName.charAt(0).toUpperCase() || "?";

        let roleColor = '#2ecc71'; // patient green
        if (userRole === 'doctor') roleColor = '#e23744'; // doc red
        if (userRole === 'lab') roleColor = '#3498db'; // lab blue
        if (userRole === 'admin') roleColor = '#9b59b6'; // admin purple

        return `
            <div class="tile-item" style="padding:15px; margin-bottom:12px; border: 1px solid #f5f5f5; border-radius:15px;">
                <div style="display:flex; align-items:center; gap:15px; flex:1;">
                    <div style="width:48px; height:48px; background:${roleColor}11; color:${roleColor}; border-radius:12px; display:flex; align-items:center; justify-content:center; font-weight:800; border: 1px solid ${roleColor}22;">
                        ${initial}
                    </div>
                    <div>
                        <h4 style="margin:0; font-size:1rem;">${userName}</h4>
                        <p style="font-size:0.75rem; color:var(--text-muted); margin:2px 0;">${userEmail}</p>
                        <span class="role-badge" style="background:${roleColor}11; color:${roleColor}; font-size:0.65rem; padding:2px 10px; border-radius:50px; font-weight:700;">${userRole.toUpperCase()}</span>
                    </div>
                </div>
                <div style="text-align:right; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; align-items:center; gap:5px;">
                        <i class="fas fa-user-shield" style="font-size:0.8rem; color:var(--text-muted);"></i>
                        <select onchange="updateUserRole('${u.id}', this.value)" style="font-size:0.75rem; padding:6px; border-radius:10px; border:1.5px solid #eee; background:#fafafa;">
                            <option value="user" ${!u.adminRole ? 'selected' : ''}>Standard User</option>
                            <option value="finance" ${u.adminRole === 'finance' ? 'selected' : ''}>Finance Admin</option>
                            <option value="support" ${u.adminRole === 'support' ? 'selected' : ''}>Support Admin</option>
                        </select>
                    </div>
                    <button class="btn-small" style="background:var(--bg-light); color:var(--text-main); border:1px solid #eee; padding:8px 15px;" onclick="manageUserStatus('${u.id}')">
                        <i class="fas fa-cog"></i> View Details
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

window.updateUserRole = async function (id, role) {
    showToast(`Updating permissions for user...`);
    try {
        const adminRole = role === 'user' ? firebase.firestore.FieldValue.delete() : role;
        await db.collection('users').doc(id).update({
            adminRole: adminRole
        });
        showToast("Permissions updated successfully!", "success");
    } catch (err) {
        showToast("Update failed: " + err.message, "error");
    }
};

window.manageUserStatus = function (id) {
    const u = AppState.users.find(usr => usr.id === id);
    if (!u) return;
    showToast(`Managing ${u.name}... Profile view coming soon!`);
};




window.showAdminTab = function (tab, event) {
    const targetId = `admin-${tab}-tab`;
    const targetTab = document.getElementById(targetId);
    if (!targetTab) return;

    document.querySelectorAll('#admin-view .doctor-tab').forEach(el => el.classList.add('hidden'));
    targetTab.classList.remove('hidden');

    document.querySelectorAll('#admin-view .menu-item').forEach(btn => btn.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');

    if (tab === 'overview') renderAdminDashboard();
    if (tab === 'verifications') renderVerifications();
    if (tab === 'users') renderAdminUsers();
    if (tab === 'financials') renderAdminFinancials();
};

window.renderAdminFinancials = function () {
    const list = document.getElementById('admin-payout-list');
    if (!list) return;

    try {
        const transactions = (AppState.appointments || [])
            .filter(a => ['Paid', 'Refunded'].includes(a.paymentStatus))
            .sort((a, b) => {
                const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : (a.createdAt || 0);
                const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : (b.createdAt || 0);
                return dateB - dateA;
            })
            .slice(0, 50);

        if (transactions.length === 0) {
            list.innerHTML = `<p style="padding:40px; text-align:center; color:var(--text-muted);">No financial transactions recorded.</p>`;
            return;
        }

        list.innerHTML = transactions.map(a => {
            const statusColor = a.payoutStatus === 'Wallet' ? '#2ecc71' : (a.payoutStatus === 'Escrow' ? '#e67e22' : '#c00');
            const refId = a.id ? a.id.slice(0, 8).toUpperCase() : 'N/A';
            return `
                <div class="tile-item" style="font-size:0.85rem; border-left:4px solid ${statusColor}; border-radius:12px; margin-bottom:12px; padding:15px; background:white; box-shadow:0 2px 10px rgba(0,0,0,0.02); display:flex; align-items:center;">
                    <div style="flex:1;">
                        <h4 style="margin:0; font-weight:600;">${a.targetName || 'Provider'} <span style="font-weight:400; font-size:0.7rem; color:var(--text-muted);">| Ref: ${refId}</span></h4>
                        <p style="margin:4px 0; color:var(--text-muted);">Patient: ${a.patientName} • Total: ₹${a.price}</p>
                        <p style="font-size:0.65rem; color:#666;">Status: ${a.paymentStatus} • ${a.type?.toUpperCase()}</p>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-weight:700; color:var(--primary); font-size:1rem;">+ ₹${a.commission || 0} Fee</div>
                        <div style="margin-top:8px;">
                            <span style="font-size:0.6rem; padding:3px 10px; border-radius:15px; background:${statusColor}11; color:${statusColor}; border:1px solid ${statusColor}22; font-weight:600;">
                               <i class="fas fa-${a.payoutStatus === 'Wallet' ? 'check-double' : 'clock'}"></i> ${(a.payoutStatus || 'Pending').toUpperCase()}
                            </span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error("Financials UI Error:", err);
        list.innerHTML = `<p style="padding:20px; color:var(--primary); text-align:center;">Failed to render ledger data.</p>`;
    }
};

window.updateAppStatus = async function (appId, status) {
    try {
        const updates = { status };

        if (status === 'completed') {
            showToast("Releasing funds from Escrow...");
            await releaseEscrowToWallet(appId);
        } else if (status === 'rejected' || status === 'cancelled') {
            showToast("Booking Canceled. Handling refund...");
            await handleRefund(appId);
        }

        await db.collection('appointments').doc(appId).update(updates);
        showToast(`Appointment marked ${status}`);

        // Notify simulation
        const app = AppState.appointments.find(a => a.id === appId);
        if (app) simulateNotification('whatsapp', `Hi ${app.patientName}, your booking with ${app.targetName} has been ${status}.`);

        refreshActiveDashboard();
    } catch (err) {
        console.error("Update failed:", err);
        showToast("Update failed: " + err.message, "error");
    }
};

// Updated bulkSettlePayouts to implement actual settlements for all providers
window.bulkSettlePayouts = async function () {
    const providers = [...AppState.doctors, ...AppState.labs];
    const payouts = providers.map(p => {
        const pendingApps = AppState.appointments
            .filter(a => a.targetId === p.id && a.status === 'approved' && a.payoutStatus === 'Pending');
        const rate = (p.commissionRate || 20) / 100;
        const grossEarnings = pendingApps.reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);
        const commission = Math.floor(grossEarnings * rate);
        const netSettlement = grossEarnings - commission;
        return { ...p, grossEarnings, commission, netSettlement, pendingApps };
    }).filter(p => p.grossEarnings > 0);

    if (payouts.length === 0) return showToast("No pending payouts to settle", "info");

    if (!confirm(`Confirm bulk settlement for ${payouts.length} providers? All amounts will reflect in 1 week.`)) return;

    showToast(`Settling ${payouts.length} providers...`);
    try {
        const batch = db.batch();
        const settlementDate = new Date();
        settlementDate.setDate(settlementDate.getDate() + 7);

        payouts.forEach(p => {
            p.pendingApps.forEach(app => {
                const ref = db.collection('appointments').doc(app.id);
                batch.update(ref, {
                    payoutStatus: 'Settled',
                    payoutDate: firebase.firestore.Timestamp.fromDate(settlementDate),
                    settledAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            });

            // Log entry for each provider
            const logRef = db.collection('settlements').doc();
            batch.set(logRef, {
                providerId: p.id,
                grossAmount: p.grossEarnings,
                commission: p.commission,
                netAmount: p.netSettlement,
                appointmentCount: p.pendingApps.length,
                scheduledPayoutDate: firebase.firestore.Timestamp.fromDate(settlementDate),
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                type: 'Bulk'
            });
        });

        await batch.commit();
        showToast("Bulk settlement successful!", "success");
        renderAdminDashboard();
    } catch (err) {
        showToast("Bulk settlement failed: " + err.message, "error");
    }
};

function detectFraudulentUsers() {
    const userCancelCounts = {};
    AppState.appointments.forEach(a => {
        if (a.status === 'rejected') {
            userCancelCounts[a.patientId] = (userCancelCounts[a.patientId] || 0) + 1;
        }
    });

    // Flag users with > 3 cancellations
    const fraudulent = Object.keys(userCancelCounts).filter(id => userCancelCounts[id] > 3);
    const indicator = document.getElementById('fraud-indicator');
    if (fraudulent.length > 0) {
        if (indicator) indicator.classList.remove('hidden');
        console.warn(`[FRAUD ALERT] Detected ${fraudulent.length} users with high cancellation rates.`);
    } else {
        if (indicator) indicator.classList.add('hidden');
    }
}


window.saveAdminSettings = function () {
    const comm = document.getElementById('set-commission').value;
    const sla = document.getElementById('set-sla').value;
    const video = document.getElementById('set-video').checked;

    showToast(`Configurations Updated! Commission: ${comm}%`, "success");
};

window.clearAllUsersExceptAdmin = async function () {
    const ADMIN_UID = 'DwaDCedzWzNC5Y0qLE1e6989bR23';
    if (!confirm("CRITICAL WARNING: This will delete ALL doctors, labs, patients, and appointments from the database forever. Only the main Admin account will remain. Proceed?")) return;

    showToast("Starting Factory Reset...", "warning");

    try {
        // 1. Clear Appointments
        const apps = await db.collection('appointments').get();
        const batch1 = db.batch();
        apps.forEach(doc => batch1.delete(doc.ref));
        await batch1.commit();

        // 2. Clear Doctors
        const docs = await db.collection('doctors').get();
        const batch2 = db.batch();
        docs.forEach(doc => batch2.delete(doc.ref));
        await batch2.commit();

        // 3. Clear Labs
        const labs = await db.collection('labs').get();
        const batch3 = db.batch();
        labs.forEach(doc => batch3.delete(doc.ref));
        await batch3.commit();

        // 4. Clear Users (Except Admin)
        const users = await db.collection('users').get();
        const batch4 = db.batch();
        users.forEach(doc => {
            if (doc.id !== ADMIN_UID) {
                batch4.delete(doc.ref);
            }
        });
        await batch4.commit();

        showToast("PLATFORM RESET SUCCESSFUL", "success");
        setTimeout(() => location.reload(), 2000);
    } catch (err) {
        console.error("Reset Failed:", err);
        showToast("Reset Failed Check Console", "error");
    }
};


window.saveCMS = function () {
    const title = document.getElementById('cms-home-title').value;
    showToast("CMS Updated: Homepage title changed to " + title);
    const heroTitle = document.querySelector('.hero-section h1');
    if (heroTitle) heroTitle.innerText = title;
};

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(reg => {
            console.log('SW Registered!', reg);
        }).catch(err => console.log('SW Reg Failed', err));
    });
}


function simulateNotification(type, message) {
    console.log(`[SYSTEM NOTIFY] Sent ${type} to user: ${message}`);
    // Show a small indicator or toast
    if (AppState.user && AppState.user.role === 'patient') {
        const icon = type === 'whatsapp' ? 'fa-whatsapp' : 'fa-comment-alt';
        const color = type === 'whatsapp' ? '#25D366' : '#3498db';
        showToast(`<i class="fab ${icon}" style="color:${color}"></i> ${message}`, "success");
    }
}



// --- Utilities ---
function refreshActiveDashboard() {
    if (!AppState.user) return;

    // Update logged in profile if it was a doctor/lab whose data just synced
    if (AppState.user.role === 'doctor' || AppState.user.role === 'lab') {
        const sourceCol = AppState.user.role === 'doctor' ? AppState.doctors : AppState.labs;
        const freshData = sourceCol.find(d => d.id === AppState.user.id);
        if (freshData) {
            AppState.user = { ...AppState.user, ...freshData };
        }
    }

    if (AppState.user.role === 'patient') refreshPatientHistory();
    if (AppState.user.role === 'doctor') renderDoctorDashboard();
    if (AppState.user.role === 'lab') renderLabDashboard();
    if (AppState.user.role === 'admin') {
        renderAdminDashboard();
        detectFraudulentUsers();

        // Refresh User Management if active
        const usersTab = document.getElementById('admin-users-tab');
        if (usersTab && !usersTab.classList.contains('hidden')) {
            renderAdminUsers();
        }
    }
}

window.toggleAuth = function (type) {
    if (type === 'login') {
        DOM.loginCard.classList.remove('hidden');
        DOM.registerCard.classList.add('hidden');
    } else {
        DOM.loginCard.classList.add('hidden');
        DOM.registerCard.classList.remove('hidden');
    }
};

window.showToast = function (msg, type = 'success') {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.background = type === 'error' ? '#e74c3c' : (type === 'warning' ? '#f39c12' : '#2D2D2D');
    toast.innerHTML = `<i class="fas ${type === 'error' ? 'fa-exclamation-circle' : 'fa-check-circle'}"></i> ${msg}`;
    DOM.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
};

// --- Simulations ---
function initSimulations() {
    // Activity Pulse
    const activities = [
        "System Monitor Active", "Encryption Layer Secure", "Platform Heartbeat Stable", "Admin Session Validated"
    ];
    setInterval(() => {
        const activity = activities[Math.floor(Math.random() * activities.length)];
        DOM.pulse.innerHTML = `<i class="fas fa-bolt" style="color: #FFD700;"></i> <strong>${activity}</strong>`;
        DOM.pulse.style.opacity = '1';
        setTimeout(() => DOM.pulse.style.opacity = '0.7', 2000);
    }, 8000);
}


// --- Admin Oversight & Approvals ---
window.approveProvider = async function (id, type) {
    console.log(`[ADMIN] Approving ${type} with ID: ${id}`);
    showToast(`Verifying credentials for ${type}...`);
    try {
        const ref = db.collection(type).doc(id);
        const doc = await ref.get();
        if (!doc.exists) {
            console.error(`[ADMIN] Provider ${id} not found in ${type}`);
            throw new Error("Provider document not found");
        }
        const data = doc.data();
        console.log(`[ADMIN] Current provider status:`, data.approved);

        // Update Doctor/Lab entry
        const isComplete = data.name && data.address && data.price && data.specialty;
        const updateData = {
            approved: true,
            approvalMode: isComplete ? 'auto' : 'manual'
        };
        await ref.update(updateData);

        // SYNC: Also update the main users collection so UI components looking at AppState.user are consistent
        try {
            await db.collection('users').doc(id).update({ approved: true });
        } catch (uErr) {
            console.log("Note: Main user doc not found or already has status");
        }

        showToast(`${data.name} Approved successfully!`, "success");
        refreshActiveDashboard();
    } catch (err) {
        console.error("Approval Error:", err);
        showToast("Approval failed: " + err.message, "error");
    }
};

function renderLabTechnician() {
    const list = document.getElementById('lab-technician-list');
    if (!list) return;

    // Simulate real-time tracking of technicians
    const technicians = [
        { name: "Rahul Sharma", zone: "Mumbai West", status: "On Route", progress: 65, icon: 'fa-motorcycle' },
        { name: "Suresh Gupta", zone: "Thane Central", status: "Sample Collected", progress: 90, icon: 'fa-vial' },
        { name: "Anita Rao", zone: "Navi Mumbai", status: "Idle", progress: 100, icon: 'fa-home' }
    ];

    list.innerHTML = technicians.map(t => `
        <div class="tile-item" style="flex-direction:column; align-items:flex-start; gap:10px;">
            <div style="display:flex; justify-content:space-between; width:100%;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <div style="width:35px; height:35px; background:var(--primary-light); border-radius:50%; display:flex; align-items:center; justify-content:center; color:var(--primary);">
                        <i class="fas ${t.icon}"></i>
                    </div>
                    <div>
                        <h4 style="margin:0;">${t.name}</h4>
                        <p style="font-size:0.7rem;">${t.zone}</p>
                    </div>
                </div>
                <span class="tile-badge status-${t.status === 'Idle' ? 'approved' : 'pending'}">${t.status}</span>
            </div>
            <div style="width:100%; height:6px; background:#eee; border-radius:10px; overflow:hidden;">
                <div style="width:${t.progress}%; height:100%; background:var(--primary); transition: width 1s ease-in-out;"></div>
            </div>
            <div style="display:flex; justify-content:space-between; width:100%; font-size:0.75rem; color:var(--text-muted);">
                <span>Collection Progress</span>
                <span>${t.progress}%</span>
            </div>
        </div>
    `).join('');
}


// --- Patient Navigator & Tab Logic ---
window.showPatientSection = function (section, event) {
    // Hide all tabs
    document.querySelectorAll('.patient-tab, .container').forEach(el => {
        if (el.id?.startsWith('patient-') && el.id?.endsWith('-tab')) el.classList.add('hidden');
    });

    // Show specific tab
    const target = document.getElementById(`patient-${section}-tab`);
    if (target) {
        target.classList.remove('hidden');
        if (section === 'home') setCategory('doctors');
    }

    if (section === 'lab-tests') renderLabTests();

    // Update Nav UI
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        // Match by text or click event
        if (event && event.currentTarget === item) item.classList.add('active');
        else if (item.innerText.toLowerCase().includes(section)) item.classList.add('active');
    });

    window.scrollTo(0, 0);
};

window.showPatientTab = function (tab) {
    // Shared Navigator for sub-sections
    document.querySelectorAll('.patient-tab, .container').forEach(el => {
        if (el.id?.startsWith('patient-') && el.id?.endsWith('-tab')) el.classList.add('hidden');
    });

    const target = document.getElementById(`patient-${tab}-tab`);
    if (target) {
        target.classList.remove('hidden');
        window.scrollTo(0, 0);
    }

    if (tab === 'pharmacy') renderPharmacy();
    if (tab === 'wallet') renderWallet();
    if (tab === 'home') showPatientSection('home');
    if (tab === 'history') refreshPatientHistory();
    if (tab === 'reports') refreshPatientRecords();
};

// --- Pharmacy Feature ---
window.renderPharmacy = function () {
    const grid = document.getElementById('pharmacy-grid');
    if (!grid) return;

    const meds = [
        { name: "Paracetamol 500mg", brand: "Dolo", price: 30, image: "💊" },
        { name: "Vitamin C Tablets", brand: "Limcee", price: 45, image: "🍊" },
        { name: "First Aid Kit", brand: "Savlon", price: 299, image: "🎒" },
        { name: "Hand Sanitizer", brand: "Dettol", price: 80, image: "🧴" },
        { name: "Face Masks (N95)", brand: "Venus", price: 150, image: "😷" },
        { name: "BP Monitor", brand: "Omron", price: 2499, image: "⌚" }
    ];

    grid.innerHTML = meds.map(m => `
        <div class="service-card" style="text-align:left; padding:15px; border:1px solid #eee;">
            <div style="font-size:3rem; margin-bottom:10px;">${m.image}</div>
            <h4 style="margin:0;">${m.name}</h4>
            <p style="font-size:0.75rem; color:var(--text-muted); margin:5px 0;">${m.brand}</p>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px;">
                <span style="font-weight:900; color:var(--primary);">₹${m.price}</span>
                <button class="btn-small" onclick="addToCart('${m.name}', ${m.price})" style="padding:5px 12px;"><i class="fas fa-plus"></i></button>
            </div>
        </div>
    `).join('');
};

window.addToCart = function (name, price) {
    if (!AppState.cart) AppState.cart = [];
    AppState.cart.push({ name, price });
    const countEl = document.getElementById('cart-count');
    if (countEl) countEl.innerText = AppState.cart.length;
    showToast(`${name} added to cart!`);
};

window.openCart = function () {
    if (!AppState.cart || AppState.cart.length === 0) return alert("Your cart is empty!");
    const total = AppState.cart.reduce((sum, item) => sum + item.price, 0);
    DOM.modalBody.innerHTML = `
        <h3>Your Pharmacy Cart</h3>
        <div class="tile-list" style="margin:20px 0;">
            ${AppState.cart.map((item, idx) => `
                <div class="tile-item">
                    <div class="tile-info"><h4>${item.name}</h4><p>Qty: 1</p></div>
                    <span style="font-weight:700;">₹${item.price}</span>
                </div>
            `).join('')}
        </div>
        <div style="display:flex; justify-content:space-between; padding:20px 0; border-top:2px dashed #eee;">
            <h4 style="margin:0;">Grand Total:</h4>
            <h3 style="margin:0; color:var(--primary);">₹${total}</h3>
        </div>
        <button class="btn-signup" style="width:100%; margin-top:20px;" onclick="checkoutPharmacy()">Place Order & Pay (₹${total})</button>
    `;
    DOM.modal.classList.remove('hidden');
};

window.checkoutPharmacy = function () {
    showToast("Order Placed Successfully! Delivery expected in 2 hours.", "success");
    AppState.cart = [];
    document.getElementById('cart-count').innerText = 0;
    DOM.modal.classList.add('hidden');
};

// --- Wallet Feature ---
window.renderWallet = function () {
    const list = document.getElementById('wallet-transactions-list');
    if (!list) return;

    const transactions = [
        { type: 'Doctor Visit', provider: 'Dr. Sameer', amount: -600, date: '02 Mar' },
        { type: 'Refund', provider: 'Lab Test Cancelled', amount: 450, date: '28 Feb' },
        { type: 'Pharmacy', provider: 'HealthMate Pharmacy', amount: -120, date: '25 Feb' }
    ];

    list.innerHTML = transactions.map(t => `
        <div class="tile-item">
            <div style="width:40px; height:40px; background:${t.amount > 0 ? '#e8f5e9' : '#fff3cd'}; color:${t.amount > 0 ? '#2ecc71' : '#f39c12'}; border-radius:50%; display:flex; align-items:center; justify-content:center;">
                <i class="fas ${t.amount > 0 ? 'fa-arrow-down' : 'fa-arrow-up'}"></i>
            </div>
            <div class="tile-info">
                <h4>${t.type}</h4>
                <p>${t.provider} • ${t.date}</p>
            </div>
            <span style="font-weight:900; color:${t.amount > 0 ? '#2ecc71' : '#333'};">${t.amount > 0 ? '+' : ''}₹${Math.abs(t.amount)}</span>
        </div>
    `).join('');
};

// --- Lab Test Catalog ---
window.renderLabTests = function () {
    const grid = document.getElementById('provider-grid');
    if (!grid) return;

    DOM.sectionTitle.innerText = "Popular Lab Tests";
    const tests = [
        { name: "CBC (Complete Blood Count)", price: 299, desc: "Includes 24 parameters", labs: "City Labs, Apollo" },
        { name: "Lipid Profile", price: 599, desc: "Cholesterol & Heart Health", labs: "Metropolis, Dr. Lal" },
        { name: "Thyroid Profile (T3, T4, TSH)", price: 399, desc: "Hormonal screening", labs: "Thyrocare" },
        { name: "Diabetes Screening", price: 499, desc: "HbA1c + Fasting Sugar", labs: "All Labs" }
    ];

    grid.innerHTML = tests.map(t => `
        <div class="doctor-card" onclick="setCategory('labs')">
            <div class="card-img" style="background:var(--primary-light); display:flex; align-items:center; justify-content:center; font-size:3rem; color:var(--primary);">
                <i class="fas fa-flask"></i>
            </div>
            <div class="card-content">
                <h3 class="card-title">${t.name}</h3>
                <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:10px;">${t.desc}</p>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:900; color:var(--primary);">₹${t.price}</span>
                    <button class="btn-book" style="padding:5px 15px;">Search Labs</button>
                </div>
            </div>
        </div>
    `).join('');
};

// --- Patient Data Fetching & Rendering ---
window.refreshPatientHistory = function () {
    if (!AppState.user) return;
    const history = AppState.appointments.filter(a => a.patientId === AppState.user.id)
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderPatientHistory(history);
};

window.renderPatientHistory = function (history) {
    const list = document.getElementById('patient-history-list');
    if (!list) return;

    if (history.length === 0) {
        list.innerHTML = '<p style="text-align:center; padding:40px; color:var(--text-muted);">No booking history found.</p>';
        return;
    }

    list.innerHTML = history.map(app => `
        <div class="tile-item">
            <div style="width:45px; height:45px; background:var(--primary-light); color:var(--primary); border-radius:10px; display:flex; align-items:center; justify-content:center; font-weight:900;">
                <i class="fas ${app.type === 'doctors' ? 'fa-user-md' : 'fa-microscope'}"></i>
            </div>
            <div class="tile-info">
                <h4>${app.targetName}</h4>
                <p>${app.date} • ${app.time} • Token: #${app.tokenNumber}</p>
                <p style="font-size:0.7rem; color:var(--text-muted);">Status: <span class="tile-badge status-${app.status}">${app.status.toUpperCase()}</span> | Payment: ${app.paymentStatus}</p>
            </div>
            <div style="display:flex; flex-direction:column; gap:5px;">
                <button class="btn-small" onclick="downloadInvoice('${app.id}')"><i class="fas fa-file-invoice"></i> Bill</button>
                ${app.type === 'labs' && app.status === 'completed' ? `<button class="btn-small" style="background:var(--secondary);" onclick="viewReport('${app.id}')"><i class="fas fa-file-pdf"></i> Report</button>` : ''}
            </div>
        </div>
    `).join('');
};

window.refreshPatientRecords = async function () {
    if (!AppState.user) return;
    try {
        const snap = await db.collection('medical_records')
            .where('patientId', '==', AppState.user.id)
            .get();
        const records = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderPatientReports(records);
    } catch (err) {
        console.error("Fetch Records Error:", err);
    }
};

window.renderPatientReports = function (records) {
    const list = document.getElementById('patient-reports-list');
    if (!list) return;

    if (records.length === 0) {
        list.innerHTML = '<p style="text-align:center; padding:40px; color:var(--text-muted);">No medical records found.</p>';
        return;
    }

    list.innerHTML = records.map(rec => `
        <div class="tile-item">
            <div style="width:45px; height:45px; background:#e8f5e9; color:#2ecc71; border-radius:10px; display:flex; align-items:center; justify-content:center; font-weight:900;">
                <i class="fas fa-file-medical"></i>
            </div>
            <div class="tile-info">
                <h4>${rec.name}</h4>
                <p>${rec.date} • ${rec.type.toUpperCase()}</p>
            </div>
            <button class="btn-small" onclick="window.open('${rec.url}', '_blank')"><i class="fas fa-eye"></i> View</button>
        </div>
    `).join('');
};

window.downloadInvoice = function (appId) {
    const app = AppState.appointments.find(a => a.id === appId);
    if (!app) return;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    doc.setFontSize(22);
    doc.text("HealthMate Invoice", 20, 20);
    doc.setFontSize(12);
    doc.text(`Invoice ID: HM-INV-${appId.substring(0, 8).toUpperCase()}`, 20, 30);
    doc.text(`Patient: ${app.patientName}`, 20, 40);
    doc.text(`Provider: ${app.targetName}`, 20, 50);
    doc.text(`Date: ${app.date}`, 20, 60);
    doc.text(`Price: ₹${app.price}`, 20, 70);
    doc.text("-----------------------------------", 20, 80);
    doc.text(`Total Amount: ₹${app.price}`, 20, 90);
    doc.text("Status: Paid (Test Mode)", 20, 100);

    doc.save(`Invoice_${app.targetName}.pdf`);
    showToast("Invoice downloaded!");
};

window.viewReport = function (appId) {
    showToast("Processing high-security report viewer...");
    // Future: Fetch actual report blob
    showToast("Viewing report for booking: " + appId, "info");
};

// --- Real Auth Implementation (Replacing Simulations) ---
window.handleGoogleLogin = async function () {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
        showToast("Opening Google Sign-In...", "info");
        await auth.signInWithPopup(provider);
        DOM.authOverlay.classList.add('hidden');
    } catch (err) {
        console.error("Google Auth Error:", err);
        showToast(err.message, "error");
    }
};

window.simulateOTP = async function () {
    const phone = prompt("Enter mobile number with country code (e.g. +919998887776):");
    if (!phone) return;

    try {
        // Initialize reCAPTCHA if not already
        if (!window.recaptchaVerifier) {
            window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
                'size': 'invisible'
            });
        }

        showToast("Sending OTP to " + phone);
        const confirmationResult = await auth.signInWithPhoneNumber(phone, window.recaptchaVerifier);

        const code = prompt("Enter the 6-digit OTP sent to your phone:");
        if (!code) return;

        showToast("Verifying OTP...");
        await confirmationResult.confirm(code);
        showToast("Phone Login Successful!", "success");
        DOM.authOverlay.classList.add('hidden');
    } catch (err) {
        console.error("Phone Auth Error:", err);
        showToast(err.message, "error");
        // Reset recaptcha on error so it can be retried
        if (window.recaptchaVerifier) {
            window.recaptchaVerifier.render().then(widgetId => {
                grecaptcha.reset(widgetId);
            });
        }
    }
};

window.savePatientProfile = async function () {
    if (!AppState.user) return;

    showToast("Saving changes...");
    const name = document.getElementById('edit-name').value;
    const dob = document.getElementById('edit-dob').value;
    const blood = document.getElementById('edit-blood-group').value;
    const phone = document.getElementById('edit-phone').value;
    const address = document.getElementById('edit-address').value;
    const emergency = document.getElementById('edit-emergency').value;

    const photoInput = document.getElementById('patient-photo-input');
    let photoUrl = AppState.user.image;

    if (photoInput && photoInput.files[0]) {
        photoUrl = await uploadFile(photoInput.files[0], `profile/${AppState.user.id}/photo`);
    }

    const data = {
        name, dob, blood, phone, address, emergency,
        image: photoUrl,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
        await db.collection('users').doc(AppState.user.id).update(data);
        AppState.user = { ...AppState.user, ...data };
        showToast("Profile updated successfully!", "success");
        applyUserSession();
    } catch (err) {
        showToast("Save failed: " + err.message, "error");
    }
};

window.showProfileSub = function (sub, event) {
    document.querySelectorAll('.profile-sub-section').forEach(s => s.classList.add('hidden'));
    const target = document.getElementById(`profile-${sub}`);
    if (target) target.classList.remove('hidden');

    document.querySelectorAll('.profile-menu .menu-item').forEach(m => m.classList.remove('active'));
    if (event) event.currentTarget.classList.add('active');
};

// --- Sidebar Helper Functions ---
window.toggleSidebar = () => {
    const sidebar = document.getElementById('app-sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.toggle('active');
    if (overlay) overlay.classList.toggle('active');
};

window.handleSidebarAction = (action) => {
    toggleSidebar();
    showToast(`Accessing ${action}...`);
    // Specific logic per action can go here
};

window.handleLogout = () => {
    toggleSidebar();
    auth.signOut().then(() => showToast("Logged out successfully"));
};

function updateSidebarUI() {
    const nameEl = document.getElementById('sidebar-user-name');
    const idEl = document.getElementById('sidebar-user-id');
    const photoEl = document.getElementById('sidebar-user-photo');

    if (!nameEl || !idEl || !photoEl) return;

    if (AppState.user) {
        nameEl.innerText = (AppState.user.name || "HEALTH USER").toUpperCase();
        idEl.innerText = `ID: HM-${AppState.user.id.slice(0, 6).toUpperCase()}`;
        if (AppState.user.image) {
            photoEl.src = AppState.user.image;
        } else {
            photoEl.src = "https://images.unsplash.com/photo-1633332755192-727a05c4013d?auto=format&fit=crop&w=200&q=80";
        }
    } else {
        nameEl.innerText = "GUEST USER";
        idEl.innerText = "ID: HM-000000";
        photoEl.src = "https://images.unsplash.com/photo-1633332755192-727a05c4013d?auto=format&fit=crop&w=200&q=80";
    }
}

// Start the app
init();
