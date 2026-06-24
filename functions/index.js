/**
 * Cloud Function pour l'envoi d'invitations par email
 * Utilise SendGrid pour envoyer des emails depuis invitations@asset-tracker.fr
 */

const { onCall, onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const logger = require("firebase-functions/logger");
const axios = require("axios");

// Initialize Firebase Admin
admin.initializeApp();

// Constantes
const ADMIN_EMAIL = "blaurens31@gmail.com";
const FROM_EMAIL = "invitations@asset-tracker.fr";
const APP_URL = "https://asset-tracker.fr";

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

        // 2. Vérifier que l'utilisateur est admin
        const userDoc = await admin.firestore().collection("users").doc(callerUid).get();
        const userData = userDoc.data();

        if (!userData || userData.email !== ADMIN_EMAIL) {
            throw new Error("Seul l'administrateur peut envoyer des invitations.");
        }

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

/**
 * Cloud Function : fetchRSS
 * Récupère un flux RSS côté serveur pour contourner les restrictions CORS
 */
exports.fetchRSS = onRequest({ cors: true }, async (req, res) => {
    try {
        const url = req.query.url;

        if (!url) {
            res.status(400).send({ error: "URL parameter is required" });
            return;
        }

        logger.info("Fetching RSS feed", { url });

        // Fetch RSS feed server-side with better headers
        let response;
        try {
            response = await axios.get(url, {
                timeout: 10000, // Reduced from 30s so the fallback kicks in faster
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                    'Accept': 'application/rss+xml, application/xml, text/xml, */*; q=0.01',
                    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
                }
            });
        } catch (e) {
            logger.warn("Direct fetch failed, falling back to allorigins", { url, error: e.message });
            response = await axios.get('https://api.allorigins.win/raw?url=' + encodeURIComponent(url), {
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
            });
        }

        // Set CORS headers
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Content-Type', 'text/xml; charset=utf-8');
        res.status(200).send(response.data);

    } catch (error) {
        logger.error("Error fetching RSS feed", { error: error.message, url: req.query.url });
        res.status(500).send({ error: error.message });
    }
});
