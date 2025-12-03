// firebaseConfig.js
// Configuration Firebase partagée
const firebaseConfig = {
    apiKey: "AIzaSyBTOp0H9KbCAwhfbtG0IDQmVkOORbXpZiU",
    authDomain: "asset-tracker-479809-b80f1.firebaseapp.com",
    projectId: "asset-tracker-479809-b80f1",
    storageBucket: "asset-tracker-479809-b80f1.firebasestorage.app",
    messagingSenderId: "405474617830",
    appId: "1:405474617830:web:6d2388705df26dd5bb4e27",
    measurementId: "G-SYTYDG37Y0"
};

// Initialisation de Firebase si ce n'est pas déjà fait
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
} else {
    firebase.app(); // if already initialized, use that one
}

const auth = firebase.auth();
const db = firebase.firestore(); // Si vous utilisez Firestore plus tard

export { auth, db, firebaseConfig };
