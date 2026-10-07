export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function listenForSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    return Promise.reject(new Error("Voice input isn't supported in this browser. Try Chrome."));
  }

  return new Promise((resolve, reject) => {
    const rec = new SpeechRecognition();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript?.trim();
      if (text) resolve(text);
      else reject(new Error("Didn't catch that — try again"));
    };

    rec.onerror = (event) => {
      if (event.error === "aborted") return;
      reject(new Error(event.error === "not-allowed" ? "Microphone permission denied" : "Voice input failed"));
    };

    rec.onend = () => {};
    rec.start();
  });
}
