const storageKey = "web-metronome-state";
const defaultSongs = [
  { name: "Great Song", bpm: 125, meter: 4 },
  { name: "The Waltz", bpm: 79, meter: 3 },
  { name: "Fast and Furious", bpm: 180, meter: 4 },
  { name: "Amazing Song", bpm: 134, meter: 4 },
];

const state = loadState();
let audioContext = null;
let timerId = null;
let currentBeat = 0;
let editingSongIndex = null;
let wakeLock = null;
let clickSamplesPromise = null;
let clickSamples = null;

const appShell = document.querySelector(".app-shell");
const bpmInput = document.querySelector("#bpmInput");
const meterSelect = document.querySelector("#meterSelect");
const wakeControl = document.querySelector("#wakeControl");
const wakeLockInput = document.querySelector("#wakeLockInput");
const ledRow = document.querySelector("#ledRow");
let leds = [];
const playButton = document.querySelector("#playButton");
const muteButton = document.querySelector("#muteButton");
const previousButton = document.querySelector("#previousButton");
const nextButton = document.querySelector("#nextButton");
const bpmDown = document.querySelector("#bpmDown");
const bpmUp = document.querySelector("#bpmUp");
const songList = document.querySelector("#songList");
const addSongButton = document.querySelector("#addSongButton");
const songForm = document.querySelector("#songForm");
const songNameInput = document.querySelector("#songNameInput");
const songBpmInput = document.querySelector("#songBpmInput");
const songMeterInput = document.querySelector("#songMeterInput");

syncControls();
syncWakeLockSupport();
renderLeds();
renderSongs();
registerServiceWorker();

playButton.addEventListener("click", togglePlayback);
muteButton.addEventListener("click", () => {
  state.muted = !state.muted;
  muteButton.textContent = state.muted ? "🔇" : "🔊";
  saveState();
});

bpmInput.addEventListener("input", () => {
  bpmInput.value = bpmInput.value.replace(/\D/g, "").slice(0, 3);
});

bpmInput.addEventListener("blur", () => {
  commitTempoInput();
});

bpmInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    commitTempoInput();
    bpmInput.blur();
  }
});

meterSelect.addEventListener("change", () => {
  state.meter = Number(meterSelect.value);
  currentBeat = 0;
  renderLeds();
  clearLeds();
  saveState();
  renderSongs();
});

wakeLockInput.addEventListener("change", () => {
  state.keepAwake = wakeLockInput.checked;
  saveState();
  if (state.keepAwake && state.playing) {
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.playing && state.keepAwake) {
    requestWakeLock();
  }
});

bpmDown.addEventListener("click", () => setTempo(state.bpm - 1));
bpmUp.addEventListener("click", () => setTempo(state.bpm + 1));

previousButton.addEventListener("click", () => moveSelection(-1));
nextButton.addEventListener("click", () => moveSelection(1));

addSongButton.addEventListener("click", () => {
  songForm.hidden = !songForm.hidden;
  songNameInput.value = "";
  songBpmInput.value = state.bpm;
  songMeterInput.value = state.meter;
  if (!songForm.hidden) {
    songNameInput.focus();
  }
});

songForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = songNameInput.value.trim() || `Tema ${state.songs.length + 1}`;
  const bpm = clamp(Number(songBpmInput.value), 30, 300);
  const meter = Number(songMeterInput.value);

  state.songs.push({ name, bpm, meter });
  state.activeSong = state.songs.length - 1;
  applySong(state.activeSong);
  songForm.hidden = true;
  saveState();
  renderSongs();
});

function togglePlayback() {
  if (state.playing) {
    stop();
    return;
  }

  start();
}

async function start() {
  audioContext = audioContext || new AudioContext();
  await audioContext.resume();
  await loadClickSamples();
  state.playing = true;
  appShell.classList.add("is-playing");
  playButton.classList.add("stop-symbol");
  playButton.textContent = "■";
  playButton.setAttribute("aria-label", "Detener");
  currentBeat = 0;
  tick();
  timerId = window.setInterval(tick, beatDurationMs());
  requestWakeLock();
}

function stop() {
  state.playing = false;
  appShell.classList.remove("is-playing");
  playButton.classList.remove("stop-symbol");
  playButton.textContent = "▶";
  playButton.setAttribute("aria-label", "Reproducir");
  window.clearInterval(timerId);
  timerId = null;
  currentBeat = 0;
  clearLeds();
  releaseWakeLock();
}

function tick() {
  const beat = currentBeat % state.meter;
  pulseLed(beat);
  if (!state.muted) {
    playClick(beat === 0);
  }
  currentBeat += 1;
}

function pulseLed(beat) {
  clearLeds();
  const led = leds[beat] || leds[beat % leds.length];
  led.classList.add(beat === 0 ? "accent" : "active");
}

function renderLeds() {
  ledRow.innerHTML = "";
  ledRow.style.setProperty("--beat-count", state.meter);
  leds = Array.from({ length: state.meter }, (_, index) => {
    const led = document.createElement("span");
    led.className = "led";
    led.setAttribute("aria-label", `Pulso ${index + 1}`);
    ledRow.append(led);
    return led;
  });
}

function clearLeds() {
  leds.forEach((led) => led.classList.remove("active", "accent"));
}

function playClick(accent) {
  if (clickSamples) {
    const source = audioContext.createBufferSource();
    source.buffer = accent ? clickSamples.downbeat : clickSamples.beat;
    source.connect(audioContext.destination);
    source.start();
    return;
  }

  playFallbackClick(accent);
}

async function loadClickSamples() {
  if (clickSamples || !audioContext) {
    return;
  }

  clickSamplesPromise =
    clickSamplesPromise ||
    Promise.all([decodeClickSample("./audio/click-downbeat.wav"), decodeClickSample("./audio/click-beat.wav")])
      .then(([downbeat, beat]) => {
        clickSamples = { downbeat, beat };
      })
      .catch(() => {
        clickSamples = null;
      });

  await clickSamplesPromise;
}

async function decodeClickSample(url) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return audioContext.decodeAudioData(arrayBuffer);
}

function playFallbackClick(accent) {
  const ctx = audioContext;
  const now = ctx.currentTime;
  const output = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const oscA = ctx.createOscillator();
  const oscB = ctx.createOscillator();

  output.gain.setValueAtTime(0.0001, now);
  output.gain.exponentialRampToValueAtTime(accent ? 0.95 : 0.68, now + 0.004);
  output.gain.exponentialRampToValueAtTime(0.001, now + (accent ? 0.13 : 0.09));

  filter.type = "bandpass";
  filter.frequency.setValueAtTime(accent ? 1850 : 1550, now);
  filter.Q.setValueAtTime(7, now);

  oscA.type = "square";
  oscB.type = "square";
  oscA.frequency.setValueAtTime(accent ? 760 : 620, now);
  oscB.frequency.setValueAtTime(accent ? 1160 : 930, now);

  oscA.connect(filter);
  oscB.connect(filter);
  filter.connect(output);
  output.connect(ctx.destination);

  oscA.start(now);
  oscB.start(now);
  oscA.stop(now + 0.14);
  oscB.stop(now + 0.14);
}

function setTempo(value, options = {}) {
  state.bpm = clamp(Number(value), 30, 300);
  if (options.syncInput !== false) {
    bpmInput.value = state.bpm;
  }
  saveState();
  restartTimer();
  renderSongs();
}

function commitTempoInput() {
  setTempo(bpmInput.value || state.bpm);
}

function restartTimer() {
  if (state.playing) {
    window.clearInterval(timerId);
    timerId = window.setInterval(tick, beatDurationMs());
  }
}

function beatDurationMs() {
  return 60000 / state.bpm;
}

function applySong(index) {
  const song = state.songs[index];
  if (!song) {
    return;
  }

  state.activeSong = index;
  state.bpm = song.bpm;
  state.meter = song.meter;
  currentBeat = 0;
  syncControls();
  renderLeds();
  restartTimer();
  clearLeds();
  saveState();
  renderSongs();
}

function moveSelection(direction) {
  if (!state.songs.length) {
    return;
  }

  const nextIndex = (state.activeSong + direction + state.songs.length) % state.songs.length;
  applySong(nextIndex);
}

function renderSongs() {
  songList.innerHTML = "";
  state.songs.forEach((song, index) => {
    const isActive = index === state.activeSong;
    const isDirty = isActive && isActiveSongDirty();
    const item = document.createElement("li");
    item.className = `song-item${isActive ? " active" : ""}`;

    const loadButton = document.createElement("button");
    loadButton.className = "song-load";
    loadButton.type = "button";
    loadButton.addEventListener("click", () => applySong(index));

    const songIndex = document.createElement("span");
    songIndex.className = "song-index";
    songIndex.textContent = `${index + 1}.`;

    const title = document.createElement("span");
    title.className = "song-title";
    title.textContent = `${song.name}${isDirty ? " *" : ""}`;

    loadButton.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      editingSongIndex = index;
      renderSongs();
    });

    const meta = document.createElement("span");
    meta.className = "song-meta";
    meta.textContent = `${song.bpm} bpm ${song.meter}/4`;

    const saveButton = document.createElement("button");
    saveButton.className = "save-button";
    saveButton.type = "button";
    saveButton.setAttribute("aria-label", `Guardar tempo actual en ${song.name}`);
    saveButton.title = "Guardar tempo";
    saveButton.addEventListener("click", () => saveActiveSongTempo());

    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-button";
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `Eliminar ${song.name}`);
    deleteButton.textContent = "×";
    deleteButton.addEventListener("click", () => deleteSong(index));

    loadButton.append(songIndex);
    if (editingSongIndex === index) {
      const editInput = document.createElement("input");
      editInput.className = "song-title-input";
      editInput.type = "text";
      editInput.maxLength = 36;
      editInput.value = song.name;
      editInput.setAttribute("aria-label", `Editar nombre de ${song.name}`);
      editInput.addEventListener("click", (event) => event.stopPropagation());
      editInput.addEventListener("dblclick", (event) => event.stopPropagation());
      editInput.addEventListener("blur", () => commitSongName(index, editInput.value));
      editInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitSongName(index, editInput.value);
        }
        if (event.key === "Escape") {
          editingSongIndex = null;
          renderSongs();
        }
      });
      loadButton.append(editInput);
      window.setTimeout(() => {
        editInput.focus();
        editInput.select();
      }, 0);
    } else {
      loadButton.append(title);
    }
    item.append(loadButton, meta);
    if (isDirty) {
      item.append(saveButton);
    }
    item.append(deleteButton);
    songList.append(item);
  });
}

function isActiveSongDirty() {
  const song = state.songs[state.activeSong];
  return Boolean(song && (song.bpm !== state.bpm || song.meter !== state.meter));
}

function saveActiveSongTempo() {
  const song = state.songs[state.activeSong];
  if (!song) {
    return;
  }

  song.bpm = state.bpm;
  song.meter = state.meter;
  saveState();
  renderSongs();
}

function commitSongName(index, value) {
  const song = state.songs[index];
  if (!song) {
    return;
  }

  const nextName = value.trim();
  if (nextName) {
    song.name = nextName;
  }
  editingSongIndex = null;
  saveState();
  renderSongs();
}

function deleteSong(index) {
  editingSongIndex = null;
  state.songs.splice(index, 1);
  state.activeSong = Math.min(state.activeSong, Math.max(0, state.songs.length - 1));
  saveState();
  renderSongs();
}

function syncControls() {
  bpmInput.value = state.bpm;
  meterSelect.value = state.meter;
  wakeLockInput.checked = state.keepAwake;
  muteButton.textContent = state.muted ? "🔇" : "🔊";
}

function syncWakeLockSupport() {
  const supported = "wakeLock" in navigator;
  wakeLockInput.disabled = !supported;
  wakeControl.classList.toggle("unsupported", !supported);
  wakeControl.title = supported
    ? "Evita que la pantalla se bloquee durante la reproducción"
    : "Tu navegador o conexión no permite mantener la pantalla encendida";
}

async function requestWakeLock() {
  if (!state.keepAwake || wakeLock || !("wakeLock" in navigator)) {
    return;
  }

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  if (!wakeLock) {
    return;
  }

  const lock = wakeLock;
  wakeLock = null;
  await lock.release();
}

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    if (stored && Array.isArray(stored.songs)) {
      const songs = stored.songs.length ? stored.songs : defaultSongs;
      return {
        bpm: clamp(Number(stored.bpm) || 120, 30, 300),
        meter: [2, 3, 4].includes(Number(stored.meter)) ? Number(stored.meter) : 4,
        muted: Boolean(stored.muted),
        keepAwake: stored.keepAwake !== false,
        playing: false,
        activeSong: clamp(Number(stored.activeSong) || 0, 0, songs.length - 1),
        songs,
      };
    }
  } catch {
    localStorage.removeItem(storageKey);
  }

  return {
    bpm: 120,
    meter: 4,
    muted: false,
    keepAwake: true,
    playing: false,
    activeSong: 0,
    songs: defaultSongs,
  };
}

function saveState() {
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      bpm: state.bpm,
      meter: state.meter,
      muted: state.muted,
      keepAwake: state.keepAwake,
      activeSong: state.activeSong,
      songs: state.songs,
    }),
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value || min)));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
