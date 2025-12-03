// loginApp.js
import { auth } from './firebaseConfig.js';

const form = document.getElementById('login-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirm-password');
const errorMessage = document.getElementById('error-message');
const toggleModeBtn = document.getElementById('toggle-mode');
const googleLoginBtn = document.getElementById('google-login-btn');
const submitBtn = document.getElementById('submit-btn');
const cardTitle = document.querySelector('.login-card h2');

let isLoginMode = true;

function displayError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
}

function toggleMode() {
    isLoginMode = !isLoginMode;
    errorMessage.style.display = 'none';

    if (isLoginMode) {
        cardTitle.textContent = 'Asset Tracker Login';
        submitBtn.textContent = 'Se connecter';
        toggleModeBtn.textContent = 'Créer un compte';
        confirmPasswordInput.style.display = 'none';
        confirmPasswordInput.required = false;
    } else {
        cardTitle.textContent = 'Créer un compte';
        submitBtn.textContent = "S'inscrire";
        toggleModeBtn.textContent = 'Déjà un compte ? Se connecter';
        confirmPasswordInput.style.display = 'block';
        confirmPasswordInput.required = true;
    }
}

if (toggleModeBtn) {
    toggleModeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        toggleMode();
    });
}

// 3. Gestion de la soumission (Login ou Register)
form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = emailInput.value;
    const password = passwordInput.value;
    errorMessage.style.display = 'none';

    if (isLoginMode) {
        // LOGIN
        auth.signInWithEmailAndPassword(email, password)
            .then(() => {
                window.location.href = 'index.html';
            })
            .catch(error => {
                if (error.code === 'auth/user-not-found') {
                    displayError("Utilisateur non trouvé. Veuillez créer un compte.");
                } else {
                    displayError("Erreur de connexion: " + error.message);
                }
            });
    } else {
        // REGISTER
        const confirmPassword = confirmPasswordInput.value;
        if (password !== confirmPassword) {
            displayError("Les mots de passe ne correspondent pas.");
            return;
        }

        auth.createUserWithEmailAndPassword(email, password)
            .then(() => {
                alert('Compte créé avec succès ! Vous êtes connecté.');
                window.location.href = 'index.html';
            })
            .catch(error => {
                displayError("Erreur lors de l'enregistrement: " + error.message);
            });
    }
});

// 5. Gestion de la connexion Google
if (googleLoginBtn) {
    googleLoginBtn.addEventListener('click', () => {
        const provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider)
            .then((result) => {
                // Connexion réussie
                window.location.href = 'index.html';
            })
            .catch((error) => {
                displayError("Erreur Google: " + error.message);
            });
    });
}

// 6. Vérifier si l'utilisateur est déjà connecté
auth.onAuthStateChanged(user => {
    if (user) {
        // Utilisateur déjà connecté, rediriger vers l'application
        window.location.href = 'index.html';
    }
});