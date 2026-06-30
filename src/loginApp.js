// loginApp.js
import { auth, db } from './firebaseConfig.js';

const form = document.getElementById('login-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirm-password');
const invitationCodeInput = document.getElementById('invitation-code');
const errorMessage = document.getElementById('error-message');
const toggleModeBtn = document.getElementById('toggle-mode');
const googleLoginBtn = document.getElementById('google-login-btn');
const submitBtn = document.getElementById('submit-btn');
const cardTitle = document.querySelector('.login-card h2');

// All modules enabled — used for admin and for legacy codes without a modules field
function allModulesEnabled() {
    return {
        dashboard: true, assets: true, transactions: true,
        analytics: true, watchlist: true, screener: true,
        news: true, realestate: true, assistant: true
    };
}

let isLoginMode = true;
let isRegistering = false; // Bloque le redirect automatique pendant l'inscription

const FIREBASE_ERRORS = {
    'auth/user-not-found':        "Aucun compte associé à cet email.",
    'auth/wrong-password':        "Mot de passe incorrect.",
    'auth/invalid-credential':    "Email ou mot de passe incorrect.",
    'auth/invalid-email':         "Adresse email invalide.",
    'auth/email-already-in-use':  "Cet email est déjà utilisé par un autre compte.",
    'auth/weak-password':         "Le mot de passe doit contenir au moins 6 caractères.",
    'auth/too-many-requests':     "Trop de tentatives. Réessayez dans quelques minutes.",
    'auth/network-request-failed':"Erreur réseau. Vérifiez votre connexion.",
    'auth/popup-closed-by-user':  "Connexion Google annulée.",
};

function displayError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
}

function firebaseError(error) {
    displayError(FIREBASE_ERRORS[error.code] || "Une erreur est survenue. Veuillez réessayer.");
}

function setLoading(loading) {
    submitBtn.disabled = loading;
    submitBtn.innerHTML = loading
        ? '<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i>' + (isLoginMode ? 'Connexion...' : 'Inscription...')
        : (isLoginMode ? 'Se connecter' : "S'inscrire");
}

function toggleMode() {
    isLoginMode = !isLoginMode;
    errorMessage.style.display = 'none';

    if (isLoginMode) {
        cardTitle.textContent = 'Connexion';
        submitBtn.textContent = 'Se connecter';
        toggleModeBtn.textContent = 'Créer un compte';
        confirmPasswordInput.style.display = 'none';
        confirmPasswordInput.required = false;
        invitationCodeInput.style.display = 'none';
        invitationCodeInput.required = false;
    } else {
        cardTitle.textContent = 'Créer un compte';
        submitBtn.textContent = "S'inscrire";
        toggleModeBtn.textContent = 'Déjà un compte ? Se connecter';
        confirmPasswordInput.style.display = 'block';
        confirmPasswordInput.required = true;
        invitationCodeInput.style.display = 'block';
        invitationCodeInput.required = true;
    }
}

if (toggleModeBtn) {
    toggleModeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        toggleMode();
    });
}

// Validate and atomically consume an invitation code (prevents TOCTOU race)
async function validateAndConsumeInvitationCode(code, userEmail) {
    const ref = db.collection('invitationCodes').doc(code.toUpperCase());
    let codeData = null;
    await db.runTransaction(async (txn) => {
        const doc = await txn.get(ref);
        if (!doc.exists) throw new Error('invalid');
        const data = doc.data();
        if (data.status !== 'available') throw new Error('invalid');
        if (data.expiresAt && Date.now() > data.expiresAt) throw new Error('invalid');
        codeData = { id: doc.id, ...data };
        txn.update(ref, { status: 'used', usedBy: userEmail, usedAt: Date.now() });
    });
    return codeData;
}

// Charger et mettre en cache les modules de l'utilisateur dans localStorage
async function cacheUserModules(user) {
    try {
        const snap = await db.collection('users').doc(user.uid).get();
        const data = snap.exists ? snap.data() : {};
        const isAdmin = data.isAdmin === true;
        localStorage.setItem('isAdmin', isAdmin ? 'true' : 'false');
        if (isAdmin) {
            localStorage.removeItem('userModules');
            return;
        }
        localStorage.setItem('userModules', JSON.stringify(data.modules || {}));
    } catch (e) {
        localStorage.removeItem('userModules');
    }
}

// Gestion de la soumission (Login ou Register)
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    errorMessage.style.display = 'none';
    setLoading(true);

    if (isLoginMode) {
        // LOGIN
        try {
            const userCredential = await auth.signInWithEmailAndPassword(email, password);
            await cacheUserModules(userCredential.user);
            window.location.href = 'dashboard.html';
        } catch (error) {
            setLoading(false);
            firebaseError(error);
        }
    } else {
        // REGISTER
        const confirmPassword = confirmPasswordInput.value;
        if (password !== confirmPassword) {
            setLoading(false);
            displayError("Les mots de passe ne correspondent pas.");
            return;
        }

        const invitationCode = invitationCodeInput.value.trim();

        if (!invitationCode) {
            setLoading(false);
            displayError("Code d'invitation requis pour créer un compte.");
            return;
        }

        try {
            // Atomically claim the code before creating the account — prevents race conditions
            let codeDoc;
            try {
                codeDoc = await validateAndConsumeInvitationCode(invitationCode, email);
            } catch {
                setLoading(false);
                displayError("Code d'invitation invalide, expiré ou déjà utilisé.");
                return;
            }

            // Bloquer le redirect automatique de onAuthStateChanged pendant l'inscription
            isRegistering = true;

            // Create account — if Auth fails, rollback the invitation code
            let userCredential;
            try {
                userCredential = await auth.createUserWithEmailAndPassword(email, password);
            } catch (authError) {
                try {
                    await db.collection('invitationCodes').doc(invitationCode.toUpperCase())
                        .update({ status: 'available', usedBy: null, usedAt: null });
                } catch (_) {}
                throw authError;
            }

            // Apply modules from the invitation code (fallback: all enabled)
            const modules = (codeDoc.modules && typeof codeDoc.modules === 'object')
                ? codeDoc.modules
                : allModulesEnabled();

            // Create user document in Firestore — if Firestore fails, delete the Auth account
            try {
                await db.collection('users').doc(userCredential.user.uid).set({
                    email: email,
                    createdAt: Date.now(),
                    invitationCode: invitationCode,
                    modules
                });
            } catch (firestoreError) {
                await userCredential.user.delete();
                throw firestoreError;
            }

            // Mettre en cache les modules du nouveau compte
            localStorage.setItem('isAdmin', 'false');
            localStorage.setItem('userModules', JSON.stringify(modules));

            isRegistering = false;
            window.location.href = 'dashboard.html';
        } catch (error) {
            isRegistering = false;
            setLoading(false);
            firebaseError(error);
        }
    }
});

// 5. Gestion de la connexion Google
if (googleLoginBtn) {
    googleLoginBtn.addEventListener('click', () => {
        const provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider)
            .then(async (result) => {
                await cacheUserModules(result.user);
                window.location.href = 'dashboard.html';
            })
            .catch((error) => {
                firebaseError(error);
            });
    });
}

// 6. Vérifier si l'utilisateur est déjà connecté
auth.onAuthStateChanged(async user => {
    if (user && !isRegistering) {
        // Mettre en cache les modules avant la redirection
        await cacheUserModules(user);
        window.location.href = 'dashboard.html';
    }
});