/** Optional browser capabilities; Safari/WebKit implementations are feature detected. */
interface SpeechRecognitionResultEvent extends Event {
    readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }>>;
}
interface SpeechRecognitionFailureEvent extends Event { readonly error: string }
interface BrowserSpeechRecognition {
    lang: string;
    interimResults: boolean;
    onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
    onerror: ((event: SpeechRecognitionFailureEvent) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}
interface Window {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitAudioContext?: typeof AudioContext;
    eruda?: { init(): void };
    __takaPreload?: { loaded: number; total: number };
}
