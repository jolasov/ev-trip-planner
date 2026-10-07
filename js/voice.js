export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function micSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

/** Request mic access once; browser remembers per-site after user allows. */
export async function ensureMicAccess() {
  if (!micSupported()) {
    throw new Error("Microphone not available in this browser");
  }

  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: "microphone" });
      if (status.state === "granted") return true;
      if (status.state === "denied") {
        throw new Error("Microphone blocked — allow it in browser settings for this site");
      }
    } catch {
      /* Safari may not support microphone permission query */
    }
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  return true;
}

export function listenForSpeech({ onInterim } = {}) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    return Promise.reject(new Error("Voice input isn't supported in this browser. Try Chrome."));
  }

  return new Promise((resolve, reject) => {
    const rec = new SpeechRecognition();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("No speech detected — try again")));
    }, 10000);

    rec.onresult = (event) => {
      let interim = "";
      let finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const chunk = result[0]?.transcript?.trim() ?? "";
        if (!chunk) continue;
        if (result.isFinal) finalText += (finalText ? " " : "") + chunk;
        else interim += chunk;
      }

      if (interim && onInterim) onInterim(interim);
      if (finalText) finish(() => resolve(finalText));
    };

    rec.onerror = (event) => {
      if (event.error === "aborted") return;
      finish(() => {
        if (event.error === "not-allowed") {
          reject(new Error("Microphone permission denied"));
        } else if (event.error === "no-speech") {
          reject(new Error("Didn't catch that — try again"));
        } else {
          reject(new Error("Voice input failed"));
        }
      });
    };

    rec.onend = () => {
      if (!settled) {
        finish(() => reject(new Error("Didn't catch that — try again")));
      }
    };

    rec.start();
  });
}
