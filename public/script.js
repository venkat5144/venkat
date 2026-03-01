/**
 * HealthMate - Core Logic Rewrite
 * Focus: Modularity, Real-time Sync, Robust Auth & RBAC
 */

// Firebase instances are already initialized in index.html and exposed globally.
// const db = firebase.firestore();
// const auth = firebase.auth();

const APP_VERSION = "2.0.5";
console.log("HealthMate App Loading. Version:", APP_VERSION);

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
    searchInput: document.getElementById('hero-search-input'),
    locationInput: document.getElementById('hero-location-input'),
    authOverlay: document.getElementById('auth-overlay'),
    loginCard: document.getElementById('login-card'),
    registerCard: document.getElementById('register-card'),
    modal: document.getElementById('booking-modal'),
    modalBody: document.getElementById('modal-body'),
    toastContainer: document.getElementById('toast-container')
};

// --- Initialization ---
function init() {
    setupAuthListener();
    setupRealtimeSync();
    setupEventListeners();
    initSimulations();
    seedInitialData(); // Ensure some data exists
}

// --- Firebase Real-time Sync ---
function setupRealtimeSync() {
    console.log("Setting up Firestore listeners...");

    // Listen for Doctors
    db.collection('doctors').onSnapshot(snap => {
        console.log("Doctors sync received:", snap.size, "records");
        AppState.doctors = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (AppState.currentType === 'doctors') renderGrid();
    }, err => {
        console.warn("Doctor Sync Error:", err.message);
        if (err.message.includes("permission")) {
            console.warn("Hint: Ensure firestore.rules are deployed and public read is allowed.");
        }
    });

    // Listen for Labs
    db.collection('labs').onSnapshot(snap => {
        AppState.labs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (AppState.currentType === 'labs') renderGrid();
    }, err => console.warn("Lab Sync Error:", err.message));

    // Listen for Appointments (Global for updates)
    db.collection('appointments').onSnapshot(snap => {
        AppState.appointments = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        refreshActiveDashboard();
    }, err => console.warn("Appointment Sync Error:", err.message));
}

// --- Authentication Logic ---
function setupAuthListener() {
    auth.onAuthStateChanged(async (firebaseUser) => {
        if (firebaseUser) {
            try {
                const userDoc = await db.collection('users').doc(firebaseUser.uid).get();
                if (userDoc.exists) {
                    AppState.user = { id: firebaseUser.uid, ...userDoc.data() };

                    // Admin Override for specific UID
                    if (firebaseUser.uid === 'DwaDCedzWzNC5Y0qLE1e6989bR23') {
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

            // Prefill Doctor Specifics if applicable
            if (AppState.user.role === 'doctor') {
                if (document.getElementById('doc-profile-spec')) document.getElementById('doc-profile-spec').value = AppState.user.specialty || "";
                if (document.getElementById('doc-profile-fee')) document.getElementById('doc-profile-fee').value = AppState.user.price || "";
                if (document.getElementById('doc-profile-address')) document.getElementById('doc-profile-address').value = AppState.user.address || "";
            }

            showToast(`Logged in as ${AppState.user.name}`);
        });
    } else {
        DOM.authBtn.innerHTML = `Login / Sign Up`;
        DOM.userInfo.classList.add('hidden');
        requestAnimationFrame(() => showRoleView('guest'));
    }
}

function showRoleView(role) {
    document.querySelectorAll('.role-section').forEach(sec => sec.classList.add('hidden'));

    if (role === 'guest' || role === 'patient') {
        document.getElementById('patient-view').classList.remove('hidden');
        const secondaryNav = document.getElementById('patient-secondary-nav');
        if (role === 'patient') secondaryNav.classList.remove('hidden');
        else secondaryNav.classList.add('hidden');
        showPatientSection('home');
    } else if (role === 'doctor') {
        document.getElementById('doctor-view').classList.remove('hidden');
        renderDoctorDashboard();
    } else if (role === 'lab') {
        document.getElementById('lab-view').classList.remove('hidden');
        renderLabDashboard();
    } else if (role === 'admin') {
        document.getElementById('admin-view').classList.remove('hidden');
        renderAdminDashboard();
    }
}

// --- UI Rendering ---
function renderGrid() {
    const data = AppState.currentType === 'doctors' ? AppState.doctors : AppState.labs;
    const filtered = data.filter(item => {
        const matchesSearch = item.name.toLowerCase().includes(AppState.activeFilters.search.toLowerCase()) ||
            item.specialty?.toLowerCase().includes(AppState.activeFilters.search.toLowerCase());
        const matchesCat = AppState.activeFilters.category === 'All' || item.specialty === AppState.activeFilters.category;
        const matchesLoc = !AppState.activeFilters.location || item.address?.toLowerCase().includes(AppState.activeFilters.location.toLowerCase());

        return matchesSearch && matchesCat && matchesLoc;
    });

    DOM.gridContainer.innerHTML = '';
    if (filtered.length === 0) {
        DOM.gridContainer.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">No results found matching your search.</div>`;
        return;
    }

    DOM.gridContainer.innerHTML = filtered.map(item => {
        const fallbackImg = AppState.currentType === 'doctors'
            ? 'https://images.unsplash.com/photo-1537368910025-700350fe46c7?q=80&w=800&auto=format&fit=crop'
            : 'https://images.unsplash.com/photo-1579152276506-8d6874837837?q=80&w=800&auto=format&fit=crop';

        return `
        <div class="card" data-id="${item.id}">
            <div class="card-img" style="background-image: url('${item.image || fallbackImg}')">
                <span class="badge-verified"><i class="fas fa-certificate"></i> Verified</span>
            </div>
            <div class="card-content">
                <h3 class="card-title">${item.name}</h3>
                <span class="card-tag"><i class="fas fa-stethoscope"></i> ${item.specialty || 'General'}</span>
                <span class="card-tag" style="font-size: 0.85rem;"><i class="fas fa-location-dot"></i> ${item.address || 'Mumbai, India'}</span>
                <div class="card-footer">
                    <div class="card-price">₹${item.price || '500'} <span>/${AppState.currentType === 'doctors' ? 'Visit' : 'Test'}</span></div>
                    <button class="btn-book" onclick="openBooking('${item.id}')">Book Now</button>
                </div>
            </div>
        </div>
        `;
    }).join('');
}

window.setCategory = function (cat) {
    if (cat === 'Video Consult' || cat === 'Medicines' || cat === 'Surgeries') {
        return showToast(`${cat} service coming soon!`, "warning");
    }
    AppState.currentType = cat; // 'doctors' or 'labs'
    AppState.activeFilters.category = 'All';
    DOM.sectionTitle.innerText = cat === 'doctors' ? 'Verified Doctors' : 'Diagnostic Labs';
    renderGrid();
    document.getElementById('list-section').scrollIntoView({ behavior: 'smooth' });
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

    AppState.selectedSlot = null; // Reset

    DOM.modalBody.innerHTML = `
        <div class="booking-flow">
            <h3 style="margin-bottom: 20px;">Book with ${item.name}</h3>
            
            <label style="font-weight: 700; display: block; margin-bottom: 10px;">1. Select Available Slot</label>
            <div class="slot-picker" id="modal-slot-picker">
                ${['09:00 AM', '10:30 AM', '01:00 PM', '03:30 PM', '05:00 PM'].map(time => `
                    <div class="slot-item" onclick="selectSlot(this, '${time}')">${time}</div>
                `).join('')}
            </div>

            <label style="font-weight: 700; display: block; margin: 25px 0 10px;">2. Secure Payment</label>
            <div class="payment-selector">
                <div class="pay-method active" onclick="selectPayMethod(this, 'upi')">
                    <i class="fas fa-mobile-screen"></i>
                    <div>
                        <div style="font-weight: 700;">UPI (PhonePe/Google Pay)</div>
                        <p style="font-size: 0.8rem; color: var(--text-muted);">Instant & Secure</p>
                    </div>
                </div>
                <div class="pay-method" onclick="selectPayMethod(this, 'card')">
                    <i class="fas fa-credit-card"></i>
                    <div>
                        <div style="font-weight: 700;">Debit / Credit Card</div>
                        <p style="font-size: 0.8rem; color: var(--text-muted);">Mastercard/Visa</p>
                    </div>
                </div>
            </div>

            <div style="margin: 25px 0; background: #F8F8F8; padding: 15px; border-radius: 12px; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: 600;">Total Payable:</span>
                <span style="font-size: 1.2rem; font-weight: 800; color: var(--primary);">₹${item.price}</span>
            </div>

            <button class="btn-signup" style="width: 100%" id="confirm-booking-btn" onclick="processPayment('${item.id}', '${AppState.currentType}')">
                Proceed to Pay & Confirm
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
    document.querySelectorAll('.pay-method').forEach(m => m.classList.remove('active'));
    el.classList.add('active');
};

window.processPayment = async function (itemId, type) {
    if (!AppState.selectedSlot) return showToast("Please select a time slot first", "warning");

    const btn = document.getElementById('confirm-booking-btn');
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Securing Payment...`;
    btn.disabled = true;

    // Simulate Payment Gateway Delay
    setTimeout(async () => {
        await confirmBooking(itemId, type);
    }, 1500);
};

window.confirmBooking = async function (itemId, type) {
    const item = (type === 'doctors' ? AppState.doctors : AppState.labs).find(i => i.id === itemId);
    const appointment = {
        patientId: AppState.user.id,
        patientName: AppState.user.name,
        targetId: itemId,
        targetName: item.name,
        type: type,
        time: AppState.selectedSlot,
        price: item.price,
        status: 'pending',
        paymentStatus: 'paid',
        date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
        await db.collection('appointments').add(appointment);
        DOM.modalBody.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div style="width: 80px; height: 80px; background: #E8F5E9; color: #2ecc71; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 2.5rem;">
                    <i class="fas fa-check"></i>
                </div>
                <h2>Payment Successful!</h2>
                <p>Your appointment for <strong>${AppState.selectedSlot}</strong> has been confirmed.</p>
                <div style="margin-top: 25px; font-size: 0.9rem; color: var(--text-muted);">
                    <i class="fas fa-bell"></i> An SMS reminder will be sent 30 mins before.
                </div>
                <button class="btn-signup" style="margin-top: 30px; width: 100%;" onclick="DOM.modal.classList.add('hidden')">Done</button>
            </div>
        `;
        showToast("Booking & Payment Successful!");
    } catch (err) {
        showToast("Transaction failed", "error");
    }
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

    // Highlight Navigation
    document.querySelectorAll('.patient-nav a').forEach(a => {
        a.style.color = 'var(--text-muted)';
        if (a.innerText.toLowerCase().includes(tab)) a.style.color = 'var(--primary)';
    });

    if (tab === 'history') refreshPatientHistory();
    if (tab === 'records') refreshPatientRecords();
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
    if (!AppState.user) return;
    const newName = document.getElementById('edit-name').value;
    const newPhone = document.getElementById('edit-phone').value;
    try {
        await db.collection('users').doc(AppState.user.id).update({ name: newName, phone: newPhone });
        AppState.user.name = newName;
        AppState.user.phone = newPhone;
        DOM.userName.innerText = newName;
        showToast("Profile Updated!");
    } catch (err) {
        showToast("Reflect failed", "error");
    }
};

window.savePatientProfile = async function () {
    const name = document.getElementById('edit-name').value;
    const phone = document.getElementById('edit-phone').value;
    const photoFile = document.getElementById('patient-photo-input').files[0];

    if (!AppState.user) return;
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

    list.innerHTML = myApps.map(a => `
        <div class="tile-item">
            <div class="tile-info">
                <h4>${a.targetName}</h4>
                <p>${a.type.toUpperCase()} • ${a.date} ${a.time ? `• ${a.time}` : ''}</p>
                ${a.status === 'approved' && !a.reviewed ? `<button class="btn-small btn-signup" style="margin-top:10px; padding: 5px 12px; font-size: 0.8rem;" onclick="openReviewModal('${a.id}', '${a.targetName}')">Rate Visit</button>` : ''}
                ${a.reviewed ? `<span style="font-size: 0.8rem; color: #2ecc71; margin-top: 10px; display: block;"><i class="fas fa-check-double"></i> Feedback Shared</span>` : ''}
            </div>
            <span class="tile-badge status-${a.status}">${a.status}</span>
        </div>
    `).join('');
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

        summaryMetrics.innerHTML = `
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-calendar-check" style="color:var(--primary); font-size:1.5rem; margin-bottom:10px;"></i>
                <h3>${monthlyApps.length}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Monthly Appointments</p>
            </div>
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-indian-rupee-sign" style="color:#2ecc71; font-size:1.5rem; margin-bottom:10px;"></i>
                <h3>₹${monthEarnings}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Gross Earnings (Total)</p>
            </div>
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-wallet" style="color:var(--primary); font-size:1.5rem; margin-bottom:10px;"></i>
                <h3 style="color:#2ecc71;">₹${netEarnings}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Net Payout (After 20%)</p>
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
                <h4>${a.patientName}</h4>
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
    showToast(`Loading records for ${patientName}...`);
    try {
        const snap = await db.collection('medical_records').where('patientId', '==', patientId).get();
        const records = snap.docs.map(doc => doc.data());

        if (records.length === 0) {
            return alert(`${patientName} hasn't uploaded any records yet.`);
        }

        DOM.modalBody.innerHTML = `
            <h3>Records for ${patientName}</h3>
            <div class="tile-list" style="margin-top: 20px;">
                ${records.map(r => `
                    <div class="tile-item">
                        <div class="tile-info">
                            <h4>${r.name}</h4>
                            <p>${r.date} • ${r.type.toUpperCase()}</p>
                        </div>
                        <button class="btn-signup btn-small" onclick="window.open('${r.url}', '_blank')">View</button>
                    </div>
                `).join('')}
            </div>
            <button class="btn-signup" style="width: 100%; margin-top: 25px; background: var(--secondary);" onclick="DOM.modal.classList.add('hidden')">Close</button>
        `;
        DOM.modal.classList.remove('hidden');
    } catch (err) {
        showToast("Error fetching patient records", "error");
    }
};

window.showDoctorTab = function (tab, event) {
    const targetId = `doctor-${tab}-tab`;
    const targetTab = document.getElementById(targetId);
    if (!targetTab) {
        console.warn(`Tab ${targetId} not found!`);
        return;
    }

    document.querySelectorAll('#doctor-view .doctor-tab').forEach(el => el.classList.add('hidden'));
    targetTab.classList.remove('hidden');

    document.querySelectorAll('#doctor-view .menu-item').forEach(btn => btn.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');

    if (tab === 'summary') renderDoctorDashboard();
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
    const spec = document.getElementById('doc-profile-spec').value;
    const fee = document.getElementById('doc-profile-fee').value;
    const address = document.getElementById('doc-profile-address').value;
    const photoFile = document.getElementById('doctor-photo-input').files[0];

    if (!AppState.user) return;
    try {
        let photoURL = AppState.user.image;
        if (photoFile) {
            showToast("Uploading photo...");
            photoURL = await uploadFile(photoFile, `doctors/${AppState.user.id}`);
        }

        await db.collection('doctors').doc(AppState.user.id).update({
            specialty: spec,
            price: fee,
            address: address,
            image: photoURL
        });

        showToast("Clinic Profile Updated!");
        refreshActiveDashboard();
    } catch (err) {
        showToast("Save failed", "error");
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

        summaryMetrics.innerHTML = `
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-microscope" style="color:var(--primary); font-size:1.5rem; margin-bottom:10px;"></i>
                <h3>${monthlyApps.length}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Monthly Tests</p>
            </div>
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-file-invoice-dollar" style="color:#2ecc71; font-size:1.5rem; margin-bottom:10px;"></i>
                <h3>₹${monthEarnings}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Gross Revenue</p>
            </div>
            <div class="admin-stat-card" style="background:#fff; border:1px solid #eee; padding:20px; border-radius:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <i class="fas fa-piggy-bank" style="color:var(--primary); font-size:1.5rem; margin-bottom:10px;"></i>
                <h3 style="color:#2ecc71;">₹${netEarnings}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Net Settlement</p>
            </div>
        `;
    }

    if (myApps.length === 0) {
        list.innerHTML = `<p style="text-align: center; padding: 40px; color: var(--text-muted);">No test requests yet.</p>`;
    } else {
        list.innerHTML = myApps.map(a => `
            <div class="tile-item">
                <div class="tile-info">
                    <h4>${a.patientName}</h4>
                    <p>Request for Diagnostic Test • ${a.date}</p>
                </div>
                <span class="tile-badge status-${a.status}">${a.status}</span>
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
    // Existing overview, verifications, and financials rendering
    const list = document.getElementById('admin-verification-list');
    const payoutList = document.getElementById('admin-payout-list');
    const statsGrid = document.getElementById('admin-stats-grid');

    const pendingDoctors = AppState.doctors.filter(d => !d.approved);
    const pendingLabs = AppState.labs.filter(l => !l.approved);
    const allPending = [...pendingDoctors, ...pendingLabs];

    const now = new Date();
    const thisMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthlyApps = AppState.appointments.filter(a => a.date && a.date.startsWith(thisMonthStr));
    const monthlyRevenue = monthlyApps.filter(a => a.status === 'approved').reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);
    const platformFees = Math.floor(monthlyRevenue * 0.20);

    statsGrid.innerHTML = `
        <div class="admin-stat-card"><h3>${AppState.doctors.length}</h3><p>Total Doctors</p></div>
        <div class="admin-stat-card"><h3>${AppState.labs.length}</h3><p>Total Labs</p></div>
        <div class="admin-stat-card"><h3>${AppState.appointments.length}</h3><p>Total Bookings</p></div>
        <div class="admin-stat-card" style="border: 2px solid var(--primary);"><h3>${monthlyApps.length}</h3><p>This Month Bookings</p></div>
        <div class="admin-stat-card" style="border: 2px solid #2ecc71;"><h3>₹${monthlyRevenue}</h3><p>This Month Revenue</p></div>
        <div class="admin-stat-card" style="border: 2px solid var(--primary); background:var(--primary-light);"><h3>₹${platformFees}</h3><p>Expected Commission</p></div>
    `;

    // Verifications
    if (allPending.length === 0) {
        list.innerHTML = `<p style="text-align: center; padding: 40px; color: var(--text-muted);">No pending approvals.</p>`;
    } else {
        list.innerHTML = allPending.map(p => `
            <div class="tile-item">
                <div class="tile-info">
                    <h4>${p.name}</h4>
                    <p>Waiting for provider verification</p>
                </div>
                <button class="btn-book" onclick="approveProvider('${p.id}', '${p.image?.includes('lab') ? 'labs' : 'doctors'}')">Approve Now</button>
            </div>
        `).join('');
    }

    // Financials / Payouts (with Commission)
    const COMMISSION_RATE = 0.20; // 20% platform fee
    const providers = [...AppState.doctors, ...AppState.labs];
    const payouts = providers.map(p => {
        const grossEarnings = AppState.appointments
            .filter(a => a.targetId === p.id && a.status === 'approved')
            .reduce((sum, a) => sum + (parseInt(a.price) || 0), 0);

        const commission = Math.floor(grossEarnings * COMMISSION_RATE);
        const netSettlement = grossEarnings - commission;

        return { ...p, grossEarnings, commission, netSettlement };
    }).filter(p => p.grossEarnings > 0);

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
                        <p style="margin: 0; color: var(--primary);">- 20% Commission</p>
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

// Updated settlePayout to show the breakdown in the toast
window.settlePayout = function (id, netAmt, grossAmt, commAmt) {
    showToast(`Settlement Approved!\nGross: ₹${grossAmt} | Fee: ₹${commAmt} | Credited: ₹${netAmt}`, "success");
    // In a real app, you would update the database here.
};

// New function to render user management tab
function renderAdminUsers() {
    const usersList = document.getElementById('admin-users-list');
    if (!usersList) return;
    const allUsers = [...AppState.doctors, ...AppState.labs];
    if (allUsers.length === 0) {
        usersList.innerHTML = `<p style="text-align: center; padding: 40px; color: var(--text-muted);">No users found.</p>`;
        return;
    }
    usersList.innerHTML = allUsers.map(u => `
        <div class="tile-item">
            <div class="tile-info">
                <h4>${u.name}</h4>
                <p>${u.approved ? 'Approved' : 'Pending'} – ${u.email || 'No email'}</p>
            </div>
            ${u.approved ? '' : `<button class="btn-book" onclick="approveProvider('${u.id}', '${u.image?.includes('lab') ? 'labs' : 'doctors'}')">Approve</button>`}
        </div>
    `).join('');
}

window.settlePayout = function (id, amount) {
    showToast(`Payout of ₹${amount} settled successfully!`);
};

window.showAdminTab = function (tab, event) {
    const targetId = `admin-${tab}-tab`;
    const targetTab = document.getElementById(targetId);
    if (!targetTab) return console.warn(`Admin tab ${tab} not found`);

    document.querySelectorAll('#admin-view .doctor-tab').forEach(el => el.classList.add('hidden'));
    targetTab.classList.remove('hidden');
    document.querySelectorAll('#admin-view .menu-item').forEach(btn => btn.classList.remove('active'));
    if (event) event.currentTarget.classList.add('active');

    // Render specific tab content if needed
    if (tab === 'users') {
        renderAdminUsers();
    }
};

window.updateAppStatus = async function (appId, status) {
    try {
        await db.collection('appointments').doc(appId).update({ status });
        showToast(`Appointment ${status}`);
        refreshActiveDashboard();
    } catch (err) {
        showToast("Update failed", "error");
    }
};

window.approveProvider = async function (id, collection) {
    try {
        await db.collection(collection).doc(id).update({ approved: true });
        showToast("Provider approved!");
    } catch (err) {
        showToast("Approval failed", "error");
    }
};

// --- Utilities ---
function refreshActiveDashboard() {
    if (!AppState.user) return;
    if (AppState.user.role === 'patient') refreshPatientHistory();
    if (AppState.user.role === 'doctor') renderDoctorDashboard();
    if (AppState.user.role === 'lab') renderLabDashboard();
    if (AppState.user.role === 'admin') renderAdminDashboard();
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
        "Rahul M. booked Cardiology", "Sarah K. booked Blood Test", "Dr. Vikram updated slots", "Amit P. joined HealthMate"
    ];
    setInterval(() => {
        const activity = activities[Math.floor(Math.random() * activities.length)];
        DOM.pulse.innerHTML = `<i class="fas fa-bolt" style="color: #FFD700;"></i> <strong>${activity}</strong>`;
        DOM.pulse.style.opacity = '1';
        setTimeout(() => DOM.pulse.style.opacity = '0.7', 2000);
    }, 8000);
}

// --- Data Seeding (For Demo/Initial State) ---
async function seedInitialData() {
    try {
        console.log("Refreshing sample data images...");
        const sampleDoctors = [
            { id_search: "Vikram", name: "Dr. Vikram Malhotra", specialty: "Cardiology", language: "Hindi", address: "Andheri West, Mumbai", price: "800", rating: "4.8", image: "https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?q=80&w=800&auto=format&fit=crop", approved: true },
            { id_search: "Sarah", name: "Dr. Sarah Khan", specialty: "Pediatrics", language: "English", address: "Bandra, Mumbai", price: "600", rating: "4.9", image: "https://images.unsplash.com/photo-1559839734-2b71f1536783?q=80&w=800&auto=format&fit=crop", approved: true },
            { id_search: "Amit", name: "Dr. Amit Patel", specialty: "Orthopedics", language: "Marathi", address: "Thane, Maharashtra", price: "700", rating: "4.7", image: "https://images.unsplash.com/photo-1622253692010-333f2da6031d?q=80&w=800&auto=format&fit=crop", approved: true },
            { id_search: "Priya", name: "Dr. Priya Sharma", specialty: "Gynaecology", language: "English, Hindi", address: "Colaba, Mumbai", price: "900", rating: "4.9", image: "https://images.unsplash.com/photo-1594824476967-48c8b964273f?q=80&w=800&auto=format&fit=crop", approved: true }
        ];

        for (const doc of sampleDoctors) {
            const q = await db.collection('doctors').where('name', '==', doc.name).get();
            if (q.empty) {
                await db.collection('doctors').add(doc);
            } else {
                // Update existing to fix image
                await q.docs[0].ref.update({ image: doc.image });
            }
        }

        const sampleLabs = [
            { name: "City Diagnostics", specialty: "Full Body Checkup", address: "Dadar, Mumbai", price: "1200", rating: "4.6", image: "https://images.unsplash.com/photo-1581594634722-e759247f446d?q=80&w=800&auto=format&fit=crop", approved: true },
            { name: "Wellness PathLabs", specialty: "Blood Test", address: "Colaba, Mumbai", price: "450", rating: "4.5", image: "https://images.unsplash.com/photo-1516733725897-1aa390dc3fa0?q=80&w=800&auto=format&fit=crop", approved: true }
        ];

        for (const lab of sampleLabs) {
            const q = await db.collection('labs').where('name', '==', lab.name).get();
            if (q.empty) {
                await db.collection('labs').add(lab);
            } else {
                await q.docs[0].ref.update({ image: lab.image });
            }
        }
    } catch (err) {
        console.warn("Seeding or image update failed:", err.message);
    }
}

// Start the app
init();
