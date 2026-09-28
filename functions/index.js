/**
 * Cloud Function pour l'envoi d'invitations par email
 * Utilise SendGrid pour envoyer des emails depuis invitations@asset-tracker.fr
 */

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const logger = require("firebase-functions/logger");
const axios = require("axios");

// Initialize Firebase Admin
admin.initializeApp();

// Constantes
const FROM_EMAIL = "invitations@asset-tracker.fr";
const APP_URL = "https://asset-tracker.fr";

// Modules accordés quand un code d'invitation n'en précise pas (anciens codes)
const ALL_MODULES = {
    dashboard: true, assets: true, transactions: true,
    analytics: true, watchlist: true, screener: true,
    news: true, realestate: true, assistant: true,
};

const INVALID_CODE_MESSAGE = "Code d'invitation invalide, expiré ou déjà utilisé.";

// `users/{uid}.isAdmin` n'est modifiable que par un admin (firestore.rules),
// c'est donc une source fiable — contrairement à `email`, que l'utilisateur
// pouvait réécrire lui-même.
async function assertAdmin(request) {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Connexion requise.");
    const snap = await admin.firestore().collection("users").doc(uid).get();
    if (snap.get("isAdmin") !== true) {
        throw new HttpsError("permission-denied", "Réservé à l'administrateur.");
    }
    return snap;
}

// Le claim `invited` est la preuve, signée par Firebase Auth, qu'un compte a
// été invité. Les Workers (Gemini, Enable Banking) et fetchRSS l'exigent.
async function setInvitedClaim(uid, invited) {
    const user = await admin.auth().getUser(uid);
    const claims = { ...(user.customClaims || {}) };
    if (invited) claims.invited = true;
    else delete claims.invited;
    await admin.auth().setCustomUserClaims(uid, claims);
    // Un retrait doit aussi invalider les sessions en cours : sinon le token
    // déjà émis garde `invited: true` jusqu'à son expiration (1 h max).
    if (!invited) await admin.auth().revokeRefreshTokens(uid);
    return user;
}

/**
 * Cloud Function : redeemInvitation
 * Consomme un code d'invitation pour l'utilisateur authentifié, crée son
 * profil avec les modules du code et lui attribue le claim `invited`.
 * Remplace l'ancienne consommation côté client, qui laissait l'utilisateur
 * écrire lui-même `usedBy` (XSS stockée dans le panneau admin).
 */
exports.redeemInvitation = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Connexion requise.");
    if (request.auth.token.invited === true) return { alreadyInvited: true };

    const code = String(request.data?.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9-]{4,40}$/.test(code)) {
        throw new HttpsError("invalid-argument", INVALID_CODE_MESSAGE);
    }

    const email = request.auth.token.email || null;
    const db = admin.firestore();
    const codeRef = db.collection("invitationCodes").doc(code);
    const userRef = db.collection("users").doc(uid);

    const modules = await db.runTransaction(async (txn) => {
        const [codeSnap, userSnap] = await Promise.all([txn.get(codeRef), txn.get(userRef)]);
        if (!codeSnap.exists) throw new HttpsError("failed-precondition", INVALID_CODE_MESSAGE);
        const c = codeSnap.data();
        const granted = (c.modules && typeof c.modules === "object") ? c.modules : ALL_MODULES;

        // Reprise après un échec de setInvitedClaim : le code a déjà été
        // consommé par CE compte, on ne le rejoue pas.
        if (c.status === "used" && c.usedByUid === uid) return granted;

        if (c.status !== "available" || (c.expiresAt && Date.now() > c.expiresAt)) {
            throw new HttpsError("failed-precondition", INVALID_CODE_MESSAGE);
        }

        txn.update(codeRef, { status: "used", usedBy: email, usedByUid: uid, usedAt: Date.now() });
        txn.set(userRef, {
            email,
            invitationCode: code,
            modules: granted,
            ...(userSnap.get("createdAt") ? {} : { createdAt: Date.now() }),
        }, { merge: true });
        return granted;
    });

    await setInvitedClaim(uid, true);
    logger.info("Invitation redeemed", { uid, code });
    return { modules };
});

/**
 * Cloud Function : syncInvitedClaims (admin)
 * Migration des comptes créés avant le claim `invited`. Accorde le claim aux
 * admins et aux comptes dont le code d'invitation est enregistré comme
 * utilisé par leur propre email Firebase Auth. Les autres sont renvoyés dans
 * `unverified` pour une décision manuelle (setUserInvited).
 * `dryRun: true` ne modifie rien et renvoie le même rapport.
 */
exports.syncInvitedClaims = onCall(async (request) => {
    await assertAdmin(request);
    const dryRun = request.data?.dryRun === true;
    const db = admin.firestore();
    const report = { granted: [], already: [], unverified: [], missingAuth: [] };

    const usersSnap = await db.collection("users").get();
    for (const doc of usersSnap.docs) {
        const d = doc.data();
        let authUser;
        try {
            authUser = await admin.auth().getUser(doc.id);
        } catch {
            report.missingAuth.push({ uid: doc.id });
            continue;
        }
        const entry = { uid: doc.id, email: authUser.email || null };
        if (authUser.customClaims?.invited === true) {
            report.already.push(entry);
            continue;
        }

        let eligible = d.isAdmin === true;
        if (!eligible && typeof d.invitationCode === "string" && authUser.email) {
            const codeSnap = await db.collection("invitationCodes").doc(d.invitationCode.toUpperCase()).get();
            const c = codeSnap.exists ? codeSnap.data() : null;
            eligible = !!c && c.status === "used" && (
                c.usedByUid === doc.id ||
                String(c.usedBy || "").toLowerCase() === authUser.email.toLowerCase()
            );
        }

        if (!eligible) {
            report.unverified.push(entry);
            continue;
        }
        if (!dryRun) await setInvitedClaim(doc.id, true);
        report.granted.push(entry);
    }

    logger.info("syncInvitedClaims", {
        dryRun,
        granted: report.granted.length,
        already: report.already.length,
        unverified: report.unverified.length,
    });
    return { dryRun, ...report };
});

/**
 * Cloud Function : setUserInvited (admin)
 * Accorde ou retire manuellement le claim `invited` d'un compte.
 */
exports.setUserInvited = onCall(async (request) => {
    await assertAdmin(request);
    const uid = String(request.data?.uid || "");
    if (!uid) throw new HttpsError("invalid-argument", "uid requis.");
    const invited = request.data?.invited === true;
    try {
        await setInvitedClaim(uid, invited);
    } catch (e) {
        if (e.code === "auth/user-not-found") throw new HttpsError("not-found", "Compte introuvable.");
        throw e;
    }
    logger.info("setUserInvited", { uid, invited, by: request.auth.uid });
    return { uid, invited };
});

/**
 * Cloud Function : sendInvitationEmail
 * Génère ou récupère un code d'invitation et l'envoie par email
 */
exports.sendInvitationEmail = onCall(async (request) => {
    try {
        const { recipientEmail, invitationCode } = request.data;
        const callerUid = request.auth?.uid;

        // 1. Vérifier que l'appelant est authentifié
        if (!callerUid) {
            throw new Error("Vous devez être connecté pour envoyer des invitations.");
        }

        // 2. Vérifier que l'utilisateur est admin (isAdmin, verrouillé par les
        // règles — et non `email`, que l'utilisateur pouvait modifier)
        const userDoc = await assertAdmin(request);
        const userData = userDoc.data();

        // 3. Valider l'email du destinataire
        if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
            throw new Error("Email du destinataire invalide.");
        }

        // 4. Vérifier le code d'invitation dans Firestore
        if (!invitationCode) {
            throw new Error("Code d'invitation manquant.");
        }

        const codeDoc = await admin.firestore()
            .collection("invitationCodes")
            .where("code", "==", invitationCode)
            .limit(1)
            .get();

        if (codeDoc.empty) {
            throw new Error("Code d'invitation introuvable.");
        }

        const code = codeDoc.docs[0].data();

        if (code.status === "used") {
            throw new Error("Ce code a déjà été utilisé.");
        }

        // 5. Récupérer la clé API SendGrid depuis la config
        const sendgridApiKey = process.env.SENDGRID_API_KEY;
        if (!sendgridApiKey) {
            throw new Error("Configuration SendGrid manquante.");
        }

        sgMail.setApiKey(sendgridApiKey);

        // 6. Créer le template HTML de l'email
        const emailHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background-color: #0a0e27;
            color: #ffffff;
        }
        .container {
            max-width: 600px;
            margin: 40px auto;
            background: linear-gradient(135deg, #1a2238 0%, #22294a 100%);
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }
        .header {
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
            padding: 40px 30px;
            text-align: center;
        }
        .header h1 {
            margin: 0;
            font-size: 32px;
            font-weight: 700;
            color: #ffffff;
        }
        .content {
            padding: 40px 30px;
        }
        .greeting {
            font-size: 18px;
            margin-bottom: 20px;
            color: #e0e0e0;
        }
        .message {
            font-size: 16px;
            line-height: 1.6;
            color: #9fa6bc;
            margin-bottom: 30px;
        }
        .code-box {
            background: rgba(99, 102, 241, 0.1);
            border: 2px solid #6366f1;
            border-radius: 12px;
            padding: 20px;
            text-align: center;
            margin: 30px 0;
        }
        .code-label {
            font-size: 14px;
            color: #9fa6bc;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .code {
            font-size: 32px;
            font-weight: 700;
            color: #6366f1;
            font-family: 'Courier New', monospace;
            letter-spacing: 2px;
        }
        .cta-button {
            display: inline-block;
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
            color: #ffffff;
            text-decoration: none;
            padding: 16px 40px;
            border-radius: 8px;
            font-size: 18px;
            font-weight: 600;
            margin: 20px 0;
            box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
            transition: transform 0.2s ease;
        }
        .cta-button:hover {
            transform: translateY(-2px);
        }
        .footer {
            padding: 30px;
            text-align: center;
            font-size: 14px;
            color: #6b7280;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
        }
        .logo {
            font-size: 24px;
            margin-bottom: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">📊 Asset Tracker</div>
            <h1>Bienvenue !</h1>
        </div>
        
        <div class="content">
            <div class="greeting">Bonjour,</div>
            
            <div class="message">
                Vous avez été invité(e) à rejoindre <strong>Asset Tracker</strong>, 
                la plateforme de suivi et d'analyse de vos investissements.
                <br><br>
                Suivez vos actions, cryptomonnaies, immobilier et bien plus encore, 
                le tout dans une interface moderne et intuitive.
            </div>
            
            <div class="code-box">
                <div class="code-label">🔑 Votre code d'invitation</div>
                <div class="code">${invitationCode}</div>
            </div>
            
            <div style="text-align: center;">
                <a href="${APP_URL}/login.html" class="cta-button">
                    Créer mon compte
                </a>
            </div>
            
            <div class="message" style="margin-top: 30px; font-size: 14px;">
                Ce code est <strong>à usage unique</strong> et vous permet de créer votre compte sur Asset Tracker.
                Cliquez sur le bouton ci-dessus pour démarrer !
            </div>
        </div>
        
        <div class="footer">
            À bientôt sur Asset Tracker 🚀
            <br>
            <span style="font-size: 12px; color: #6b7280;">
                Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.
            </span>
        </div>
    </div>
</body>
</html>
        `;

        // 7. Envoyer l'email
        const msg = {
            to: recipientEmail,
            from: FROM_EMAIL,
            subject: "🎉 Vous êtes invité(e) à rejoindre Asset Tracker",
            html: emailHtml,
        };

        await sgMail.send(msg);

        // 8. Logger l'envoi
        logger.info("Invitation email sent", {
            recipientEmail,
            invitationCode,
            sentBy: userData.email,
        });

        // 9. Retourner le succès
        return {
            success: true,
            message: `Invitation envoyée avec succès à ${recipientEmail}`,
        };
    } catch (error) {
        logger.error("Error sending invitation email", error);
        throw new Error(error.message || "Erreur lors de l'envoi de l'invitation");
    }
});

// ── fetchRSS : proxy RSS restreint ──────────────────────────────────────────
// SECURITY FIX (SSRF / proxy ouvert, audit P1) : la fonction allait chercher
// n'importe quelle URL, pour n'importe qui, avec un repli via un service
// tiers (allorigins). Elle n'accepte plus que les flux Google News, pour un
// compte invité authentifié.
const RSS_ALLOWED_HOSTS = new Set(["news.google.com"]);
const RSS_MAX_BYTES = 2 * 1024 * 1024;
const APP_ORIGINS = [
    "https://asset-tracker.fr",
    "https://asset-tracker-beta.web.app",
    "https://asset-tracker-479809-b80f1.web.app",
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

function isAllowedRssHost(hostname) {
    return RSS_ALLOWED_HOSTS.has(String(hostname).toLowerCase());
}

function parseAllowedRssUrl(raw) {
    let url;
    try {
        url = new URL(String(raw || ""));
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    if (!isAllowedRssHost(url.hostname) || !url.pathname.startsWith("/rss")) return null;
    return url;
}

/**
 * Cloud Function : fetchRSS
 * Récupère un flux RSS Google News côté serveur (contournement CORS).
 * Exige `Authorization: Bearer <Firebase ID token>` d'un compte invité.
 */
exports.fetchRSS = onRequest({ cors: APP_ORIGINS }, async (req, res) => {
    const match = (req.get("Authorization") || "").match(/^Bearer (.+)$/);
    if (!match) {
        res.status(401).send({ error: "Unauthorized" });
        return;
    }
    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(match[1]);
    } catch {
        res.status(401).send({ error: "Unauthorized" });
        return;
    }
    if (decoded.invited !== true) {
        res.status(403).send({ error: "Forbidden" });
        return;
    }

    const target = parseAllowedRssUrl(req.query.url);
    if (!target) {
        res.status(400).send({ error: "URL de flux non autorisée" });
        return;
    }

    try {
        const response = await axios.get(target.href, {
            timeout: 10000,
            responseType: "text",
            maxContentLength: RSS_MAX_BYTES,
            maxRedirects: 3,
            // Une redirection ne doit jamais sortir de la liste blanche
            beforeRedirect: (options) => {
                if (options.protocol !== "https:" || !isAllowedRssHost(options.hostname)) {
                    throw new Error(`Redirection refusée vers ${options.hostname}`);
                }
            },
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*; q=0.01',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        res.set('Content-Type', 'text/xml; charset=utf-8');
        res.status(200).send(response.data);
    } catch (error) {
        logger.error("Error fetching RSS feed", { error: error.message, url: target.href, uid: decoded.uid });
        res.status(502).send({ error: "Flux RSS indisponible" });
    }
});
