import { auth, db } from './firebaseConfig.js';

const tabs = document.querySelectorAll('.settings-tab');
const tabContents = document.querySelectorAll('.settings-content');
const invitationsTab = document.getElementById('invitations-tab');

// Check admin via Firestore (source de vérité) et affiche l'onglet Invitations
auth.onAuthStateChanged(async user => {
    if (!user) return;
    try {
        const snap = await db.collection('users').doc(user.uid).get();
        if (snap.exists && snap.data().isAdmin === true) {
            if (invitationsTab) invitationsTab.style.display = 'flex';
        }
    } catch (e) {
        // Fallback sur le cache si Firestore inaccessible
        if (localStorage.getItem('isAdmin') === 'true') {
            if (invitationsTab) invitationsTab.style.display = 'flex';
        }
    }
});

// Tab switching
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;

        // Remove active from all tabs
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.classList.remove('active'));

        // Add active to clicked tab
        tab.classList.add('active');
        document.getElementById(`tab-${targetTab}`).classList.add('active');

        // Store active tab in URL hash
        window.location.hash = targetTab;
    });
});

// Restore tab from URL hash on page load
window.addEventListener('DOMContentLoaded', () => {
    const hash = window.location.hash.substring(1);
    if (hash) {
        const targetTab = document.querySelector(`[data-tab="${hash}"]`);
        if (targetTab) {
            targetTab.click();
        }
    }
});
