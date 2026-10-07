// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantApp } from '../src/assistantApp.js';

afterEach(() => {
    delete window.webkitSpeechRecognition;
    delete window.SpeechRecognition;
    delete window.speechSynthesis;
    delete globalThis.SpeechSynthesisUtterance;
    document.body.innerHTML = '';
});

describe('Assistant voice input', () => {
    it('transcrit une question française dans le champ sans l’envoyer automatiquement', () => {
        let instance;
        class RecognitionMock {
            constructor() { instance = this; }
            start() { this.onstart?.(); }
            stop() { this.onend?.(); }
        }
        window.webkitSpeechRecognition = RecognitionMock;
        document.body.innerHTML = `
            <textarea id="user-input"></textarea>
            <button id="voice-input-btn"><i class="ph ph-microphone"></i></button>`;
        const app = Object.create(AssistantApp.prototype);
        app._isListening = false;
        app._speechRecognition = null;
        app._voiceInputPrefix = '';
        app.setupVoiceInput();

        document.getElementById('voice-input-btn').click();
        expect(document.getElementById('voice-input-btn').classList.contains('is-listening')).toBe(true);
        instance.onresult({ results: [[{ transcript: 'Pourquoi Schneider baisse aujourd’hui' }]] });
        expect(document.getElementById('user-input').value).toBe('Pourquoi Schneider baisse aujourd’hui');
        instance.onend();
        expect(document.getElementById('voice-input-btn').classList.contains('is-listening')).toBe(false);
    });
});

describe('Assistant speech synthesis', () => {
    it('lit puis arrête une réponse avec le même bouton', () => {
        class UtteranceMock {
            constructor(text) { this.text = text; }
        }
        globalThis.SpeechSynthesisUtterance = UtteranceMock;
        const speak = vi.fn();
        const cancel = vi.fn();
        window.speechSynthesis = { speak, cancel, getVoices: () => [{ lang: 'fr-FR' }] };
        const button = document.createElement('button');
        button.innerHTML = '<i></i><span>Lire</span>';
        const app = Object.create(AssistantApp.prototype);
        app._speechUtterance = null;
        app._activeSpeechButton = null;

        app.toggleSpeech(button, '**Bonjour** https://example.com/source');
        expect(speak).toHaveBeenCalledOnce();
        expect(speak.mock.calls[0][0].text).toBe('Bonjour lien source');
        expect(button.classList.contains('is-speaking')).toBe(true);
        expect(button.querySelector('span').textContent).toBe('Arrêter');

        app.toggleSpeech(button, 'ignored');
        expect(cancel).toHaveBeenCalled();
        expect(button.classList.contains('is-speaking')).toBe(false);
        expect(button.querySelector('span').textContent).toBe('Lire');
    });
});
