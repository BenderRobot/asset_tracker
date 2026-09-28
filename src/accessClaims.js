// accessClaims.js
// Accès à l'application : un compte doit avoir été invité. La preuve est le
// custom claim `invited`, posé côté serveur par la Cloud Function
// `redeemInvitation` et exigé par les Workers (Gemini, Enable Banking) et
// fetchRSS. Ce contrôle client n'est qu'un confort d'interface : la vraie
// barrière est côté serveur.
import { db } from './firebaseConfig.js';

const functions = () => firebase.app().functions('us-central1');

// Un admin garde l'accès même avant la migration des claims
// (syncInvitedClaims), sinon il ne pourrait plus ouvrir le panneau admin
// pour la lancer. `isAdmin` n'est modifiable que par un admin (firestore.rules).
export async function hasAppAccess(user) {
    if ((await user.getIdTokenResult()).claims.invited === true) return true;
    // Le token en cache peut dater d'avant l'attribution du claim (migration,
    // accord manuel par l'admin) : on le rafraîchit une fois avant de conclure.
    if ((await user.getIdTokenResult(true)).claims.invited === true) return true;
    try {
        const snap = await db.collection('users').doc(user.uid).get();
        return snap.exists && snap.data().isAdmin === true;
    } catch {
        return false;
    }
}

// Consomme le code pour l'utilisateur connecté puis rafraîchit son token pour
// qu'il porte immédiatement le claim `invited`. Renvoie les modules accordés.
export async function redeemInvitation(code) {
    const { data } = await functions().httpsCallable('redeemInvitation')({ code });
    await firebase.auth().currentUser.getIdToken(true);
    return data.modules || null;
}

export function callAdminFunction(name, payload = {}) {
    return functions().httpsCallable(name)(payload).then(r => r.data);
}
