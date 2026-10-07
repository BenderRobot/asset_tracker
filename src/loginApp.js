// loginApp.js
import { auth, db } from './firebaseConfig.js';
import { hasAppAccess, redeemInvitation } from './accessClaims.js';

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

let isLoginMode = true;
let isRegistering = false; // Bloque le redirect automatique pendant l'inscription
let isInvitationStep = false; // Compte connecté mais pas encore invité : seul le code est demandé

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

// Erreurs renvoyées par redeemInvitation (HttpsError) : leur message est
// rédigé côté serveur pour l'utilisateur.
const INVITATION_ERROR_CODES = ['functions/invalid-argument', 'functions/failed-precondition'];

function firebaseError(error) {
    if (INVITATION_ERROR_CODES.includes(error.code)) return displayError(error.message);
    displayError(FIREBASE_ERRORS[error.code] || "Une erreur est survenue. Veuillez réessayer.");
}

function submitLabel() {
    if (isInvitationStep) return 'Valider le code';
    return isLoginMode ? 'Se connecter' : "S'inscrire";
}

function setLoading(loading) {
    submitBtn.disabled = loading;
    submitBtn.innerHTML = loading
        ? '<i class="ph ph-spinner-gap ph-spin" style="margin-right:6px;"></i>' + (isLoginMode ? 'Connexion...' : 'Inscription...')
        : submitLabel();
}

function setFieldVisible(input, visible) {
    input.style.display = visible ? 'block' : 'none';
    input.required = visible;
}

// Compte authentifié (email ou Google) sans claim `invited` : on ne demande
// plus que le code d'invitation, consommé côté serveur.
function showInvitationStep() {
    isInvitationStep = true;
    isLoginMode = false;
    cardTitle.textContent = "Code d'invitation requis";
    setFieldVisible(emailInput, false);
    setFieldVisible(passwordInput, false);
    setFieldVisible(confirmPasswordInput, false);
    setFieldVisible(invitationCodeInput, true);
    if (googleLoginBtn) googleLoginBtn.style.display = 'none';
    toggleModeBtn.textContent = 'Se déconnecter';
    setLoading(false);
    displayError("Ce compte n'a pas encore été invité. Saisissez votre code d'invitation.");
}

async function enterApp(user) {
    await cacheUserModules(user);
    window.location.href = 'dashboard.html';
}

async function routeSignedInUser(user) {
    try {
        if (await hasAppAccess(user)) return enterApp(user);
    } catch (e) {
        console.warn('[login] access check failed:', e.message);
    }
    showInvitationStep();
}

function toggleMode() {
    if (isInvitationStep) {
        auth.signOut().then(() => window.location.reload());
        return;
    }
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

    if (isInvitationStep) {
        // Compte déjà connecté : seul le code est consommé
        try {
            await redeemInvitation(invitationCodeInput.value.trim());
            await enterApp(auth.currentUser);
        } catch (error) {
            setLoading(false);
            firebaseError(error);
        }
    } else if (isLoginMode) {
        // LOGIN — la redirection (ou l'étape d'invitation) est faite par onAuthStateChanged
        try {
            await auth.signInWithEmailAndPassword(email, password);
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
            // Bloquer le redirect automatique de onAuthStateChanged pendant l'inscription
            isRegistering = true;

            // Le compte Auth est créé d'abord : redeemInvitation exige un
            // appelant authentifié, et c'est elle (côté serveur) qui valide le
            // code, crée le profil et pose le claim `invited`.
            const userCredential = await auth.createUserWithEmailAndPassword(email, password);
            try {
                await redeemInvitation(invitationCode);
            } catch (redeemError) {
                // Code refusé : supprimer le compte pour permettre un nouvel essai avec le même email
                try { await userCredential.user.delete(); } catch (_) {}
                throw redeemError;
            }

            isRegistering = false;
            await enterApp(userCredential.user);
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
        // La redirection (ou l'étape d'invitation) est faite par onAuthStateChanged
        const provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider).catch(firebaseError);
    });
}

// 6. Utilisateur connecté : entrer dans l'app s'il est invité, sinon demander le code
auth.onAuthStateChanged(user => {
    if (user && !isRegistering) routeSignedInUser(user);
});